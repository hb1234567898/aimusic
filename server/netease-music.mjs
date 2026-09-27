const DEFAULT_BITRATE = '320000';
const ALLOWED_BITRATES = new Set(['128000', '192000', '320000']);
const BASE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
};

let browserCookie = '';
const playableCache = new Map();

export function normalizeNeteaseCookie(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim().replace(/;+$/, ''))
    .filter(Boolean)
    .join('; ');
}

export function hasNeteaseLogin(cookie) {
  return /(?:^|;\s*)MUSIC_U=[^;]+/.test(normalizeNeteaseCookie(cookie));
}

export function normalizeNeteaseBitrate(value) {
  const raw = String(value || '').trim();
  return ALLOWED_BITRATES.has(raw) ? raw : DEFAULT_BITRATE;
}

export function buildNeteasePlayerUrl(id, bitrate) {
  const songId = encodeURIComponent(String(id || '').trim());
  return `https://music.163.com/api/song/enhance/player/url?id=${songId}&ids=%5B${songId}%5D&br=${normalizeNeteaseBitrate(bitrate)}`;
}

export function mapNeteaseSong(song) {
  const artists = song?.artists || song?.ar || [];
  const album = song?.album || song?.al || {};
  return {
    provider: 'netease',
    id: String(song?.id || ''),
    name: String(song?.name || ''),
    artist: artists.map(item => item?.name).filter(Boolean).join(' / ') || '网易云音乐',
    album: album?.name || '',
    cover: album?.picUrl || album?.blurPicUrl || album?.img80x80 || '',
    duration: Number(song?.duration || song?.dt || 0),
    fee: Number(song?.fee || 0),
  };
}

function headers(cookie = browserCookie, extra = {}) {
  const normalized = normalizeNeteaseCookie(cookie);
  return { ...BASE_HEADERS, ...(normalized ? { Cookie: normalized } : {}), ...extra };
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || `网易云请求失败（${response.status}）`);
  return payload;
}

async function account(cookie = browserCookie) {
  if (!hasNeteaseLogin(cookie)) return { loggedIn: false };
  const payload = await json('https://music.163.com/api/nuser/account/get', { headers: headers(cookie) });
  const userId = payload?.profile?.userId || payload?.account?.id;
  return userId ? {
    loggedIn: true,
    userId: String(userId),
    nickname: payload?.profile?.nickname || '网易云音乐用户',
    avatar: payload?.profile?.avatarUrl || '',
  } : { loggedIn: false };
}

async function playableUrl(id, bitrate, cookie = browserCookie) {
  const br = normalizeNeteaseBitrate(bitrate);
  const key = `${id}:${br}:${cookie}`;
  const cached = playableCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.url;
  const payload = await json(buildNeteasePlayerUrl(id, br), { headers: headers(cookie) });
  const url = payload?.data?.[0]?.url || '';
  playableCache.set(key, { url, expiresAt: Date.now() + 8 * 60 * 1000 });
  return url;
}

function playlistSummary(item) {
  return {
    id: String(item?.id || ''),
    name: item?.name || '未命名歌单',
    cover: item?.coverImgUrl || item?.picUrl || '',
    trackCount: Number(item?.trackCount || 0),
    subscribed: Boolean(item?.subscribed),
  };
}

async function songDetails(ids, cookie) {
  const result = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400).map(Number);
    const payload = await json(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(JSON.stringify(batch))}`, { headers: headers(cookie) });
    result.push(...(payload?.songs || []));
  }
  return result;
}

function errorResponse(response, status, message) {
  response.status(status).json({ error: message, message });
}

async function streamAudio(request, response, upstream) {
  response.status(upstream.status);
  ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(name => {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  });
  if (!upstream.body) return response.end();
  const reader = upstream.body.getReader();
  request.on('close', () => reader.cancel().catch(() => {}));
  try {
    while (!request.destroyed && !response.destroyed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) await new Promise(resolve => response.once('drain', resolve));
    }
  } catch { /* client closed or upstream stopped */ }
  if (!response.destroyed && !response.writableEnded) response.end();
}

export function registerNeteaseMusicExpressRoutes(app) {
  app.get('/api/netease/login/status', async (_request, response) => {
    try { response.json(await account()); }
    catch { response.json({ loggedIn: false }); }
  });

  app.put('/api/netease/login/cookie', async (request, response) => {
    browserCookie = normalizeNeteaseCookie(request.body?.cookie);
    playableCache.clear();
    try {
      const profile = await account();
      if (!profile.loggedIn) return errorResponse(response, 401, '网易云登录态无效或已过期');
      response.json(profile);
    } catch (error) { errorResponse(response, 502, error.message || '网易云登录信息同步失败'); }
  });

  app.post('/api/netease/logout', (_request, response) => {
    browserCookie = '';
    playableCache.clear();
    response.json({ ok: true });
  });

  app.get('/api/netease/search', async (request, response) => {
    const keywords = String(request.query.keywords || '').trim();
    if (!keywords) return errorResponse(response, 400, '请输入歌曲、歌手或专辑');
    const limit = Math.max(1, Math.min(30, Number(request.query.limit) || 18));
    try {
      const body = new URLSearchParams({ s: keywords, type: '1', offset: '0', total: 'true', limit: String(limit) });
      const payload = await json('https://music.163.com/api/search/get/web', {
        method: 'POST', headers: headers(browserCookie, { 'Content-Type': 'application/x-www-form-urlencoded' }), body,
      });
      response.json({ songs: (payload?.result?.songs || []).map(mapNeteaseSong).filter(song => song.id && song.name) });
    } catch (error) { errorResponse(response, 502, error.message || '网易云搜索失败'); }
  });

  app.get('/api/netease/user/playlists', async (_request, response) => {
    try {
      const profile = await account();
      if (!profile.loggedIn) return errorResponse(response, 401, '请先扫码登录网易云音乐');
      const payload = await json(`https://music.163.com/api/user/playlist?uid=${encodeURIComponent(profile.userId)}&limit=1000&offset=0`, { headers: headers() });
      response.json({ profile, playlists: (payload?.playlist || []).map(playlistSummary).filter(item => item.id) });
    } catch (error) { errorResponse(response, 502, error.message || '读取网易云歌单失败'); }
  });

  app.get('/api/netease/playlist/tracks', async (request, response) => {
    const id = String(request.query.id || '').trim();
    if (!id) return errorResponse(response, 400, '缺少歌单 ID');
    try {
      const profile = await account();
      if (!profile.loggedIn) return errorResponse(response, 401, '请先扫码登录网易云音乐');
      const payload = await json(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=2000`, { headers: headers() });
      const playlist = payload?.playlist || {};
      const ordered = (playlist.trackIds || playlist.tracks || []).map(item => String(item?.id || '')).filter(Boolean).slice(0, 2000);
      const inline = new Map((playlist.tracks || []).map(item => [String(item?.id), item]));
      const missing = ordered.filter(songId => !inline.has(songId));
      (await songDetails(missing, browserCookie)).forEach(item => inline.set(String(item?.id), item));
      const songs = ordered.map(songId => inline.get(songId)).filter(Boolean).map(mapNeteaseSong).filter(song => song.id && song.name);
      response.json({
        playlist: { ...playlistSummary(playlist), loadedCount: songs.length },
        songs,
      });
    } catch (error) { errorResponse(response, 502, error.message || '读取网易云歌单歌曲失败'); }
  });

  app.get('/api/netease/lyric', async (request, response) => {
    const id = String(request.query.id || '').trim();
    if (!id) return errorResponse(response, 400, '缺少歌曲 ID');
    try {
      const payload = await json(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1`, { headers: headers() });
      const original = payload?.lrc?.lyric || '';
      const translated = payload?.tlyric?.lyric || '';
      response.type('text/plain').send(translated ? `${original}\n${translated}` : original);
    } catch (error) { errorResponse(response, 502, error.message || '读取网易云歌词失败'); }
  });

  app.get('/api/netease/audio', async (request, response) => {
    const id = String(request.query.id || '').trim();
    if (!id) return errorResponse(response, 400, '缺少歌曲 ID');
    try {
      if (!(await account()).loggedIn) return errorResponse(response, 401, '网易云登录已失效，请重新扫码登录');
      const url = await playableUrl(id, request.query.br);
      if (!url) return errorResponse(response, 404, '网易云未返回可播放地址，歌曲可能受会员或版权限制');
      const upstreamHeaders = headers(browserCookie);
      if (request.headers.range) upstreamHeaders.Range = request.headers.range;
      const upstream = await fetch(url, { headers: upstreamHeaders });
      if (!upstream.ok && upstream.status !== 206) return errorResponse(response, upstream.status, '网易云音源请求失败');
      await streamAudio(request, response, upstream);
    } catch (error) {
      if (!response.headersSent) errorResponse(response, 502, error.message || '网易云音源代理失败');
      else if (!response.writableEnded) response.end();
    }
  });
}
