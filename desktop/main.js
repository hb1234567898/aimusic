// QQ Music and Netease Cloud Music login handling is adapted from Sonic Topography for local,
// personal non-commercial use. See THIRD_PARTY_NOTICES.md.
import { app, BrowserWindow, ipcMain, powerSaveBlocker, session, shell } from 'electron';
// electron-updater 是 CJS 包，autoUpdater 用 Object.defineProperty 的 getter 挂出来，
// 静态扫描认不了这个命名导出。直接 `import { autoUpdater } from 'electron-updater'`
// 会在加载期就抛 SyntaxError，主进程起不来、整个应用打不开。必须 default import 再解构。
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const isDev = Boolean(process.env.ORBIT_ELECTRON_DEV_URL);
const appUrl = process.env.ORBIT_ELECTRON_DEV_URL || `http://127.0.0.1:${process.env.PORT || '45437'}`;
const QQ_LOGIN_PARTITION = 'persist:orbit-music-qq-login';
const QQ_LOGIN_URL = 'https://y.qq.com/n/ryqq/profile';
const NETEASE_LOGIN_PARTITION = 'persist:orbit-music-netease-login';
const NETEASE_LOGIN_URL = 'https://music.163.com/#/login';
let mainWindow = null;
let qqCookieSyncTimer = null;
let neteaseCookieSyncTimer = null;
let displaySleepBlockerId = null;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setName('ORBIT Music');
app.setAppUserModelId('com.orbit.music.desktop');

function parseCookieHeader(cookieText) {
  const result = {};
  String(cookieText || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index <= 0) return;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  });
  return result;
}

function normalizeUin(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}

function hasLogin(cookieText, playbackOnly = false) {
  const cookie = parseCookieHeader(cookieText);
  const uin = normalizeUin(Number(cookie.login_type) === 2
    ? (cookie.wxuin || cookie.uin || cookie.p_uin)
    : (cookie.uin || cookie.qqmusic_uin || cookie.wxuin || cookie.p_uin));
  const key = playbackOnly
    ? (cookie.qm_keyst || cookie.qqmusic_key || cookie.music_key || cookie.wxskey)
    : (cookie.qm_keyst || cookie.qqmusic_key || cookie.music_key || cookie.p_skey || cookie.skey || cookie.psrf_qqaccess_token || cookie.psrf_qqrefresh_token || cookie.wxrefresh_token || cookie.wxskey);
  return Boolean(uin && key);
}

function isQQDomain(domain) {
  const clean = String(domain || '').replace(/^\./, '').toLowerCase();
  return clean === 'qq.com' || clean.endsWith('.qq.com');
}

async function readQQCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  const priority = [
    'uin', 'qqmusic_uin', 'wxuin', 'login_type', 'qm_keyst', 'qqmusic_key',
    'music_key', 'p_skey', 'skey', 'psrf_qqopenid', 'psrf_qqunionid',
    'psrf_qqaccess_token', 'psrf_qqrefresh_token', 'wxopenid', 'wxunionid',
    'wxrefresh_token', 'wxskey', 'p_uin', 'ptcz', 'RK',
  ];
  const picked = new Map(cookies.filter((cookie) => cookie?.name && isQQDomain(cookie.domain)).map((cookie) => [cookie.name, cookie.value || '']));
  const extras = [...picked.keys()].filter((key) => !priority.includes(key)).sort();
  return [...priority, ...extras]
    .filter((key) => picked.get(key))
    .map((key) => `${key}=${picked.get(key)}`)
    .join('; ');
}

function isNeteaseDomain(domain) {
  const clean = String(domain || '').replace(/^\./, '').toLowerCase();
  return clean === '163.com' || clean.endsWith('.163.com');
}

async function readNeteaseCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  const priority = ['MUSIC_U', '__csrf', 'NMTID', 'MUSIC_A', 'MUSIC_R_T', 'MUSIC_SNS'];
  const picked = new Map(cookies.filter(cookie => cookie?.name && isNeteaseDomain(cookie.domain)).map(cookie => [cookie.name, cookie.value || '']));
  const extras = [...picked.keys()].filter(key => !priority.includes(key)).sort();
  return [...priority, ...extras].filter(key => picked.get(key)).map(key => `${key}=${picked.get(key)}`).join('; ');
}

function hasNeteaseLogin(cookieText) {
  return Boolean(parseCookieHeader(cookieText).MUSIC_U);
}

async function syncCookieToBridge(cookie) {
  const response = await fetch(`${appUrl}/api/qq/login/cookie`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'QQ 登录信息同步失败');
  return payload;
}

async function syncCurrentQQPlaybackCookie() {
  const cookieSession = session.fromPartition(QQ_LOGIN_PARTITION);
  const cookie = await readQQCookieHeader(cookieSession);
  if (!hasLogin(cookie, true)) return { ok: false, playbackKeyReady: false };
  const profile = await syncCookieToBridge(cookie);
  return { ok: true, profile, playbackKeyReady: true };
}

async function syncNeteaseCookieToBridge(cookie) {
  const response = await fetch(`${appUrl}/api/netease/login/cookie`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || '网易云登录信息同步失败');
  return payload;
}

async function syncCurrentNeteaseCookie() {
  const cookie = await readNeteaseCookieHeader(session.fromPartition(NETEASE_LOGIN_PARTITION));
  if (!hasNeteaseLogin(cookie)) return { ok: false };
  return { ok: true, profile: await syncNeteaseCookieToBridge(cookie) };
}

function scheduleQQCookieSync() {
  clearTimeout(qqCookieSyncTimer);
  qqCookieSyncTimer = setTimeout(() => {
    syncCurrentQQPlaybackCookie().catch(() => {});
  }, 250);
}

function watchQQPlaybackCookies() {
  const cookieSession = session.fromPartition(QQ_LOGIN_PARTITION);
  cookieSession.cookies.on('changed', (_event, cookie) => {
    if (cookie?.domain && isQQDomain(cookie.domain)) scheduleQQCookieSync();
  });
}

function watchNeteaseCookies() {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  cookieSession.cookies.on('changed', (_event, cookie) => {
    if (!cookie?.domain || !isNeteaseDomain(cookie.domain)) return;
    clearTimeout(neteaseCookieSyncTimer);
    neteaseCookieSyncTimer = setTimeout(() => syncCurrentNeteaseCookie().catch(() => {}), 300);
  });
}

function createLoginWindow(owner, { partition = QQ_LOGIN_PARTITION, title = 'QQ 音乐登录 · ORBIT Bridge' } = {}) {
  return new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    parent: owner && !owner.isDestroyed() ? owner : undefined,
    show: false,
    autoHideMenuBar: true,
    title,
    backgroundColor: '#111111',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

async function openQQMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(QQ_LOGIN_PARTITION);
  const initialCookie = await readQQCookieHeader(cookieSession);
  if (hasLogin(initialCookie, true)) {
    return { ok: true, profile: await syncCookieToBridge(initialCookie), reused: true };
  }

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let warmupStarted = false;
    const loginWindow = createLoginWindow(owner);
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (!loginWindow.isDestroyed()) loginWindow.close();
      if (!result.ok) {
        resolve(result);
        return;
      }
      try {
        const profile = await syncCookieToBridge(result.cookie);
        resolve({ ok: true, profile, reused: result.reused, partial: result.partial });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    };
    const checkCookies = async () => {
      try {
        const cookie = await readQQCookieHeader(cookieSession);
        if (hasLogin(cookie, true)) {
          finish({ ok: true, cookie });
        } else if (hasLogin(cookie) && !warmupStarted) {
          warmupStarted = true;
          setTimeout(() => {
            if (!settled && !loginWindow.isDestroyed()) loginWindow.loadURL('https://y.qq.com/n/ryqq/player').catch(() => {});
          }, 900);
        }
      } catch { /* 下一轮轮询继续检查 */ }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?qq\.com/i.test(url)) loginWindow.loadURL(url).catch(() => {});
      else if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    loginWindow.webContents.on('did-finish-load', checkCookies);
    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readQQCookieHeader(cookieSession);
        if (hasLogin(cookie, true)) await finish({ ok: true, cookie });
        else if (hasLogin(cookie)) resolve({ ok: false, cancelled: true, error: 'QQ_PLAYBACK_COOKIE_MISSING', message: 'QQ 账号已登录，但播放授权尚未完成。请重新连接并等待窗口自动关闭。' });
        else resolve({ ok: false, cancelled: true, message: 'QQ 音乐登录窗口已关闭' });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(QQ_LOGIN_URL).catch((error) => finish({ ok: false, error: error.message }));
  });
}

async function openNeteaseLoginWindow(owner) {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  const initialCookie = await readNeteaseCookieHeader(cookieSession);
  if (hasNeteaseLogin(initialCookie)) {
    return { ok: true, profile: await syncNeteaseCookieToBridge(initialCookie), reused: true };
  }

  return new Promise(resolve => {
    let settled = false;
    let pollTimer = null;
    const loginWindow = createLoginWindow(owner, {
      partition: NETEASE_LOGIN_PARTITION,
      title: '网易云音乐扫码登录 · ORBIT Bridge',
    });
    const finish = async result => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      if (!loginWindow.isDestroyed()) loginWindow.close();
      if (!result.ok) return resolve(result);
      try {
        resolve({ ok: true, profile: await syncNeteaseCookieToBridge(result.cookie) });
      } catch (error) { resolve({ ok: false, error: error.message }); }
    };
    const checkCookies = async () => {
      try {
        const cookie = await readNeteaseCookieHeader(cookieSession);
        if (hasNeteaseLogin(cookie)) finish({ ok: true, cookie });
      } catch { /* keep polling */ }
    };
    // 网易云登录浮层默认可能停在手机号页；只点击官方页面里的“登录”和
    // “二维码登录/扫码登录”，不注入账号密码，也不接触第三方登录服务。
    const selectQrLogin = () => loginWindow.webContents.executeJavaScript(`(() => {
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nodes = [...document.querySelectorAll('button,a,span,div')].filter(visible);
      const login = nodes.find(el => /^(登录|立即登录)$/.test((el.textContent || '').trim()));
      if (login) login.click();
      setTimeout(() => {
        const next = [...document.querySelectorAll('button,a,span,div')].filter(visible);
        const qr = next.find(el => /(二维码登录|扫码登录)/.test((el.textContent || '').trim()));
        if (qr) qr.click();
      }, 450);
    })()`, true).catch(() => {});

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?163\.com/i.test(url)) loginWindow.loadURL(url).catch(() => {});
      else if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      selectQrLogin();
      setTimeout(selectQrLogin, 1300);
      setTimeout(selectQrLogin, 2800);
    });
    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      clearInterval(pollTimer);
      const cookie = await readNeteaseCookieHeader(cookieSession).catch(() => '');
      if (hasNeteaseLogin(cookie)) finish({ ok: true, cookie });
      else resolve({ ok: false, cancelled: true, message: '网易云扫码登录窗口已关闭' });
    });
    pollTimer = setInterval(checkCookies, 1000);
    loginWindow.loadURL(NETEASE_LOGIN_URL).catch(error => finish({ ok: false, error: error.message }));
  });
}

function waitForHttp(url, timeoutMs = 12000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => { response.resume(); resolve(); });
      request.on('error', () => {
        if (Date.now() - started >= timeoutMs) reject(new Error(`等待 ${url} 超时`));
        else setTimeout(check, 250);
      });
      request.setTimeout(1000, () => request.destroy());
    };
    check();
  });
}

async function createWindow() {
  if (!isDev) {
    process.env.PORT = process.env.PORT || '45437';
    await import(pathToFileURL(path.join(appRoot, 'local-server.mjs')).href);
    await waitForHttp(appUrl);
  }
  // 桌面会话会持久化；应用重启后自动把登录态重新交给本地代理，
  // 用户不需要每次打开都重新扫码。
  try {
    const savedCookie = await readQQCookieHeader(session.fromPartition(QQ_LOGIN_PARTITION));
    if (hasLogin(savedCookie, true)) await syncCookieToBridge(savedCookie);
  } catch { /* 离线启动时仍然允许打开本地曲库 */ }
  try {
    const savedCookie = await readNeteaseCookieHeader(session.fromPartition(NETEASE_LOGIN_PARTITION));
    if (hasNeteaseLogin(savedCookie)) await syncNeteaseCookieToBridge(savedCookie);
  } catch { /* 离线启动时仍然允许打开本地曲库 */ }
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'ORBIT Music',
    backgroundColor: '#101113',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(appUrl);
}

ipcMain.handle('orbit-open-qq-login', (event) => openQQMusicLoginWindow(BrowserWindow.fromWebContents(event.sender)));
ipcMain.handle('orbit-refresh-qq-login', () => syncCurrentQQPlaybackCookie());
ipcMain.handle('orbit-open-netease-login', event => openNeteaseLoginWindow(BrowserWindow.fromWebContents(event.sender)));
ipcMain.handle('orbit-refresh-netease-login', () => syncCurrentNeteaseCookie());
ipcMain.handle('orbit-set-keep-awake', (_event, enabled) => {
  if (enabled) {
    if (displaySleepBlockerId === null || !powerSaveBlocker.isStarted(displaySleepBlockerId)) {
      displaySleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    }
  } else if (displaySleepBlockerId !== null) {
    if (powerSaveBlocker.isStarted(displaySleepBlockerId)) powerSaveBlocker.stop(displaySleepBlockerId);
    displaySleepBlockerId = null;
  }
  return { active: displaySleepBlockerId !== null && powerSaveBlocker.isStarted(displaySleepBlockerId) };
});
// ---- 远程更新 ----------------------------------------------------------------
// 只在打包后的应用里跑：开发模式（electron . 或 dev server）下 electron-updater
// 找不到 app-update.yml，会一路报错刷屏，所以这里直接关掉。
const updaterEnabled = !isDev && app.isPackaged;

function emitUpdateState(payload) {
  mainWindow?.webContents?.send('orbit-update-state', payload);
}

function wireUpdater() {
  if (!updaterEnabled) return;
  // 静默更新：每次启动后台查一次，发现新版本直接在后台下载，
  // UI 只负责把状态画成一个小徽章，不弹窗、不放按钮。
  autoUpdater.autoDownload = true;
  // 下载完不趁App退出偷偷装上，等用户点一下徽章再重启，避免抢走控制权。
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => emitUpdateState({ phase: 'checking' }));
  autoUpdater.on('update-available', (info) => emitUpdateState({
    phase: 'available',
    version: info?.version || '',
    releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : '',
  }));
  autoUpdater.on('update-not-available', (info) => emitUpdateState({ phase: 'idle', version: info?.version || app.getVersion() }));
  autoUpdater.on('download-progress', (progress) => emitUpdateState({
    phase: 'downloading',
    percent: Math.min(100, Math.max(0, Math.round(progress?.percent || 0))),
  }));
  autoUpdater.on('update-downloaded', (info) => emitUpdateState({
    phase: 'downloaded',
    version: info?.version || '',
  }));
  autoUpdater.on('error', (error) => emitUpdateState({
    phase: 'error',
    message: error?.message || '检查更新失败',
  }));
}

ipcMain.handle('orbit-app-version', () => ({ version: app.getVersion(), updaterEnabled }));
ipcMain.handle('orbit-check-update', async () => {
  if (!updaterEnabled) return { ok: false, reason: 'dev' };
  try {
    return await autoUpdater.checkForUpdates();
  } catch (error) {
    return { ok: false, reason: error?.message || 'check-failed' };
  }
});
ipcMain.handle('orbit-download-update', async () => {
  if (!updaterEnabled) return { ok: false, reason: 'dev' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message || 'download-failed' };
  }
});
ipcMain.handle('orbit-install-update', () => {
  if (!updaterEnabled) return { ok: false, reason: 'dev' };
  // 关掉 HTTP 服务再装，否则端口占着，装完重启会起不来。
  // 安装包自己会拉起新版本。
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });
  return { ok: true };
});

ipcMain.handle('orbit-clear-qq-login', async () => {
  await session.fromPartition(QQ_LOGIN_PARTITION).clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
  await fetch(`${appUrl}/api/qq/logout`, { method: 'POST' }).catch(() => {});
  return { ok: true };
});

ipcMain.handle('orbit-clear-netease-login', async () => {
  await session.fromPartition(NETEASE_LOGIN_PARTITION).clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
  await fetch(`${appUrl}/api/netease/logout`, { method: 'POST' }).catch(() => {});
  return { ok: true };
});

app.whenReady().then(async () => {
  watchQQPlaybackCookies();
  watchNeteaseCookies();
  await createWindow();
  // 窗口就绪后再挂 updater，之前发的事件没有接收方会丢
  wireUpdater();
  if (updaterEnabled) autoUpdater.checkForUpdates().catch(() => {});
});
app.on('window-all-closed', () => {
  if (displaySleepBlockerId !== null && powerSaveBlocker.isStarted(displaySleepBlockerId)) powerSaveBlocker.stop(displaySleepBlockerId);
  displaySleepBlockerId = null;
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
