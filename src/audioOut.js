// 音频输出设备管理。
//
// 为什么要单独管理：一旦用了 createMediaElementSource 把 <audio> 接进 Web Audio，
// 声音就不再走浏览器原生的媒体路由，而是交给 AudioContext 的渲染设备。
// 外接音箱（3.5mm / 蓝牙）在这种情况下经常出现声音很小、断续、甚至跑到别的设备上。
// 所以这里给两种模式让用户自己选：
//   viz    —— 律动可视化优先：接管音频进 Web Audio（默认，和以前一样）
//   direct —— 原生输出优先：完全不接管，由浏览器自己把声音送到系统默认设备
//
// 重要：**模式只在当前页面会话里生效，不写进 localStorage**。
// 之前把 direct 持久化过，结果手机上切过一次原生输出后，以后每次打开都默认没律动，
// 用户还以为律动功能坏了。现在每次打开页面一律从 viz 开始；选过的输出设备照旧记住。
const STORAGE_KEY = 'aimusic.audioOut';
const DEFAULTS = { mode: 'viz', deviceId: '' };

export const OUTPUT_MODES = {
  viz: { label: '律动可视化', hint: '默认。接管音频做频谱分析，背景跟着鼓点跳' },
  direct: { label: '原生输出', hint: '不接管音频，交给浏览器直出。外接音箱异常时的兜底，刷新页面后自动恢复律动' }
};

export function readOutputPref() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    // mode 永远从 viz 起步（会话内可切 direct），只恢复上次记住的输出设备
    return { mode: 'viz', deviceId: raw && typeof raw === 'object' && typeof raw.deviceId === 'string' ? raw.deviceId : '' };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveOutputPref(pref) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ deviceId: pref.deviceId || '' }));
  } catch { /* 隐私模式下写不了就算了，不影响本次会话 */ }
}

// ——— 律动同步校准 ———
// Web Audio 只知道自己的输出缓冲有多长，蓝牙 A2DP 那 150~300ms 它完全看不见。
// 剩下的偏差只能让用户自己拧：正数 = 画面再晚一点（视觉比声音早时往 + 调）。
const BEAT_OFFSET_KEY = 'aimusic.beatOffset';
const BEAT_OFFSET_LIMIT = 0.3;

export function readBeatOffset() {
  try {
    const value = Number(JSON.parse(localStorage.getItem(BEAT_OFFSET_KEY)));
    return Number.isFinite(value) ? Math.max(-BEAT_OFFSET_LIMIT, Math.min(BEAT_OFFSET_LIMIT, value)) : 0;
  } catch {
    return 0;
  }
}

export function saveBeatOffset(seconds) {
  try {
    localStorage.setItem(BEAT_OFFSET_KEY, JSON.stringify(Math.round(seconds * 1000) / 1000));
  } catch { /* 隐私模式写不了就算了，本次会话仍生效 */ }
}

export const BEAT_OFFSET_STEP = 0.02;

// Chrome 拿到设备名必须先授权一次麦克风；授权完立刻把 track 停掉，不真的录音
export async function requestDeviceLabels() {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch {
    return false;
  }
}

export async function listOutputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(device => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== '')
      .map(device => ({ id: device.deviceId, label: device.label || '未命名输出设备' }));
  } catch {
    return [];
  }
}

export function supportsElementSink(audio) {
  return typeof audio?.setSinkId === 'function';
}

export function supportsContextSink(context) {
  return typeof context?.setSinkId === 'function';
}

// ——— 断点续播：每首歌听到哪里记到哪里，下次打开自动接回去 ———
const PROGRESS_KEY = 'aimusic.progress';
const RESUME_MIN = 5;   // 少于 5 秒的位置没什么记忆价值
const RESUME_TAIL = 8;  // 快放完了也别再续播

export function readProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveProgress(trackId, time) {
  if (!(time > RESUME_MIN)) return;
  try {
    const all = readProgress();
    all[trackId] = Math.round(time * 10) / 10;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch { /* 隐私模式写不了，忽略 */ }
}

// ——— 上次听到哪一首 ———
// 原来只按曲目记播放位置，却没记「最后听的是哪一首」，
// 于是刷新后永远回到 01，续播等于白做。这里补上曲目本身。
const LAST_TRACK_KEY = 'aimusic.lastTrack';

export function readLastTrack() {
  try {
    const value = Number(JSON.parse(localStorage.getItem(LAST_TRACK_KEY)));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function saveLastTrack(index) {
  if (!Number.isInteger(index) || index < 0) return;
  try {
    localStorage.setItem(LAST_TRACK_KEY, JSON.stringify(index));
  } catch { /* 隐私模式写不了就算了 */ }
}

// 返回应当恢复到第几秒；不到续播门槛就返回 0
export function resumeAt(trackId, duration) {
  const saved = Number(readProgress()[trackId]);
  if (!saved || !Number.isFinite(saved)) return 0;
  if (saved < RESUME_MIN) return 0;
  if (duration && saved > duration - RESUME_TAIL) return 0;
  return saved;
}

// 把声音送到指定设备。只在明确指定了设备时才动手。
// 没指定（跟随系统默认）时**完全不要调 setSinkId**：一旦调用，浏览器就会重新协商
// 音频输出链路，外接音箱尤其是蓝牙会被打断，表现就是「又得重连一次」。
export function applySink(audio, context, deviceId) {
  if (!deviceId) return Promise.resolve(true);
  if (context && supportsContextSink(context)) {
    // 已被接管时元素的出口失效，只能改 AudioContext 的 sink
    return context.setSinkId(deviceId).then(() => true).catch(() => false);
  }
  if (supportsElementSink(audio)) return audio.setSinkId(deviceId).then(() => true).catch(() => false);
  return Promise.resolve(false);
}
