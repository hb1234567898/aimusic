// QQ Music login handling is adapted from Sonic Topography for local,
// personal non-commercial use. See THIRD_PARTY_NOTICES.md.
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const isDev = Boolean(process.env.ORBIT_ELECTRON_DEV_URL);
const appUrl = process.env.ORBIT_ELECTRON_DEV_URL || `http://127.0.0.1:${process.env.PORT || '45437'}`;
const QQ_LOGIN_PARTITION = 'persist:orbit-music-qq-login';
const QQ_LOGIN_URL = 'https://y.qq.com/n/ryqq/profile';
let mainWindow = null;

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

function createLoginWindow(owner) {
  return new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    parent: owner && !owner.isDestroyed() ? owner : undefined,
    show: false,
    autoHideMenuBar: true,
    title: 'QQ 音乐登录 · ORBIT Bridge',
    backgroundColor: '#111111',
    webPreferences: {
      partition: QQ_LOGIN_PARTITION,
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
        if (hasLogin(cookie)) await finish({ ok: true, cookie, partial: !hasLogin(cookie, true) });
        else resolve({ ok: false, cancelled: true, message: 'QQ 音乐登录窗口已关闭' });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(QQ_LOGIN_URL).catch((error) => finish({ ok: false, error: error.message }));
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
    if (hasLogin(savedCookie)) await syncCookieToBridge(savedCookie);
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
ipcMain.handle('orbit-clear-qq-login', async () => {
  await session.fromPartition(QQ_LOGIN_PARTITION).clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
  await fetch(`${appUrl}/api/qq/logout`, { method: 'POST' }).catch(() => {});
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
