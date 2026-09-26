const QQ_COOKIE_HEADER = 'x-qq-music-cookie';
const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const QQ_DEFAULT_PLAYLIST_TRACK_LIMIT = 500;
const QQ_MAX_PLAYLIST_TRACK_LIMIT = 2000;
const QQ_PLAYLIST_LIST_LIMIT = 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': UA,
};
const QQ_QUALITY_CANDIDATES = [
  { prefix: 'RS01', ext: '.flac', level: 'hires', label: 'Hi-Res FLAC' },
  { prefix: 'F000', ext: '.flac', level: 'lossless', label: 'Lossless FLAC' },
  { prefix: 'M800', ext: '.mp3', level: 'exhigh', label: '320k MP3' },
  { prefix: 'M500', ext: '.mp3', level: 'standard', label: '128k MP3' },
  { prefix: 'C400', ext: '.m4a', level: 'aac', label: 'AAC/M4A' },
];

let qqCookie = '';

function parseCookieString(cookieText) {
  const out = {};
  String(cookieText || '').split(/[;\n\r]+/).forEach((part) => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const index = raw.indexOf('=');
    if (index <= 0) return;
    const key = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim().replace(/;+$/, '');
    if (key && value) out[key] = value;
  });
  return out;
}

function serializeCookieObject(cookie) {
  return Object.entries(cookie || {})
    .filter(([key, value]) => key && value != null && String(value) !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ');
}

function normalizeQQUin(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}

export function normalizeQQCookieInput(cookieText) {
  const cookie = parseCookieString(cookieText);
  if (Number(cookie.login_type) === 2 && cookie.wxuin && !cookie.uin) cookie.uin = cookie.wxuin;
  if (!cookie.uin && (cookie.qqmusic_uin || cookie.p_uin)) cookie.uin = cookie.qqmusic_uin || cookie.p_uin;
  if (cookie.uin) cookie.uin = normalizeQQUin(cookie.uin);
  return serializeCookieObject(cookie);
}

function qqCookieObject(cookieText = qqCookie) {
  return parseCookieString(normalizeQQCookieInput(cookieText));
}

function qqCookieUin(cookie = qqCookieObject()) {
  const raw = Number(cookie.login_type) === 2
    ? (cookie.wxuin || cookie.uin || cookie.p_uin)
    : (cookie.uin || cookie.qqmusic_uin || cookie.wxuin || cookie.p_uin);
  return normalizeQQUin(raw);
}

function qqCookieMusicKey(cookie = qqCookieObject()) {
  return cookie.qm_keyst
    || cookie.qqmusic_key
    || cookie.music_key
    || cookie.p_skey
    || cookie.skey
    || cookie.psrf_qqaccess_token
    || cookie.psrf_qqrefresh_token
    || cookie.wxrefresh_token
    || cookie.wxskey
    || '';
}

function qqCookiePlaybackKey(cookie = qqCookieObject()) {
  return cookie.qm_keyst || cookie.qqmusic_key || cookie.music_key || cookie.wxskey || '';
}

function decodeCookieValue(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, '%20')).trim();
  } catch {
    return String(value || '').trim();
  }
}

function qqCookieNickname(cookie, uin) {
  const padded = uin ? `0${uin}` : '';
  const keys = [
    uin && `ptnick_${uin}`,
    padded && `ptnick_${padded}`,
    'ptnick',
    'nick',
    'nickname',
    'qq_nickname',
  ].filter(Boolean);
  for (const key of keys) {
    if (cookie[key]) return decodeCookieValue(cookie[key]);
  }
  return '';
}

function qqCookieAvatar(cookie, uin) {
  const direct = cookie.qqmusic_avatar || cookie.avatar || cookie.avatarUrl || cookie.headpic || '';
  if (direct) return decodeCookieValue(direct);
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100` : '';
}

function setQQCookie(cookieText) {
  qqCookie = normalizeQQCookieInput(cookieText);
}

function readHeaderCookie(req) {
  const raw = req.headers?.[QQ_COOKIE_HEADER];
  return normalizeQQCookieInput(Array.isArray(raw) ? raw[0] : raw);
}

function currentCookie(req) {
  return readHeaderCookie(req) || qqCookie;
}

function qqGtk(cookieText = qqCookie) {
  const cookie = qqCookieObject(cookieText);
  const key = cookie.skey || cookie.p_skey || cookie.qqmusic_key || cookie.qm_keyst || '';
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) hash += (hash << 5) + key.charCodeAt(index);
  return hash & 0x7fffffff;
}

function normalizeQQProfile(cookieText = qqCookie) {
  const cookie = qqCookieObject(cookieText);
  const userId = qqCookieUin(cookie);
  const musicKey = qqCookieMusicKey(cookie);
  const nickname = qqCookieNickname(cookie, userId) || (userId ? `QQ ${userId}` : 'QQ 音乐');
  return {
    provider: 'qq',
    loggedIn: Boolean(userId && musicKey),
    userId,
    nickname,
    avatar: qqCookieAvatar(cookie, userId),
    hasCookie: Boolean(cookieText),
    playbackKeyReady: Boolean(userId && qqCookiePlaybackKey(cookie)),
  };
}

async function fetchText(targetUrl, options = {}) {
  const response = await fetch(targetUrl, {
    ...options,
    headers: {
      ...QQ_HEADERS,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.body = text;
    throw error;
  }
  return text;
}

function parseJSONText(text) {
  const raw = String(text || '').trim();
  return JSON.parse(raw.replace(/^callback\(([\s\S]*)\);?$/, '$1'));
}

async function qqMusicRequest(payload, cookieText = '', useCookie = false) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
  };
  if (useCookie && cookieText) headers.Cookie = cookieText;
  const text = await fetchText(QQ_MUSICU_URL, {
    method: 'POST',
    headers,
    body,
  });
  return parseJSONText(text);
}

function mapQQArtists(raw) {
  return (raw || [])
    .map((artist) => ({
      id: artist?.id,
      mid: artist?.mid,
      name: artist?.name || artist?.title || '',
    }))
    .filter((artist) => artist.name);
}

function rawQQAlbumCover(albumMid, size = 300) {
  return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg?max_age=2592000` : '';
}

function qqAlbumCover(albumMid, size = 300) {
  return albumMid ? `/api/qq/cover?id=${albumMid}&size=${size}` : '';
}

function mapQQSmartSong(item) {
  const mid = item?.mid || item?.songmid || item?.id || '';
  return {
    provider: 'qq',
    id: mid,
    qqId: item?.id || item?.docid || '',
    mid,
    songmid: mid,
    mediaMid: '',
    name: item?.name || item?.title || '',
    artist: item?.singer || '',
    album: '',
    duration: 0,
    fee: 0,
  };
}

function mapQQTrack(track, fallback = {}) {
  const album = track?.album || {};
  const artists = mapQQArtists(track?.singer || []);
  const mid = track?.mid || fallback.mid || fallback.songmid || fallback.id || '';
  const albumMid = album.mid || album.pmid || '';
  return {
    provider: 'qq',
    id: mid,
    qqId: track?.id || fallback.qqId || '',
    mid,
    songmid: mid,
    mediaMid: track?.file?.media_mid || fallback.mediaMid || '',
    name: track?.name || track?.title || fallback.name || '',
    artist: artists.map((artist) => artist.name).join(' / ') || fallback.artist || '',
    album: album.name || album.title || fallback.album || '',
    cover: qqAlbumCover(albumMid, 300) || fallback.cover || '',
    duration: (Number(track?.interval) || 0) * 1000,
    fee: track?.pay && Number(track.pay.pay_play) ? 1 : 0,
  };
}

export function isQQFavoritePlaylistName(name) {
  return /我喜欢|我的喜欢|喜欢的音乐|喜爱的音乐|favorite/i.test(String(name || '').trim());
}

// 只剔除系统自动生成的「QZone背景音乐」目录（dirid 205、通常 0 首）。
// 旧实现是 name/creator 任意命中 qzone|空间|背景音乐|background 就丢，
// 会把名字里带「空间」的用户自建歌单（比如「工作空间 BGM」）一并误杀，
// 表现就是「我创建的歌单一个都不显示」。
const QQ_QZONE_DIRID = 205;

function isQzoneBackgroundPlaylist(playlist) {
  const name = String(playlist?.name || '').toLowerCase();
  const looksLikeQzone = /qzone|背景音乐/.test(name);
  if (!looksLikeQzone) return false;
  return Number(playlist?.dirid) === QQ_QZONE_DIRID || Number(playlist?.trackCount) === 0;
}

export function mapQQPlaylistSummary(playlist, kind = 'created') {
  const raw = playlist || {};
  // disslist 里根本没有 dissid 字段，只有 dirid（目录 id）和 tid（歌单 id）。
  // tid 为 0 时不能回退到 dirid：dirid 是「默认收藏=1 / QZone背景音乐=205」这类
  // 系统目录 id，拿它去请求歌单详情要么失败、要么取回错的歌单。
  const rawId = raw.dissid ?? raw.tid ?? raw.id ?? raw.diss_id;
  const id = Number(rawId) > 0 ? String(rawId) : '';
  const name = raw.diss_name || raw.dissname || raw.name || raw.title || '';
  const creator = raw.creator?.name || raw.creator?.nick || raw.hostname || raw.nick || raw.creator || 'QQ 音乐';
  const mapped = {
    provider: 'qq',
    source: 'qq',
    id,
    name,
    dirid: Number(raw.dirid) || 0,
    dirShow: raw.dir_show == null ? null : Number(raw.dir_show),
    cover: raw.diss_cover || raw.logo || raw.picurl || raw.cover || '',
    trackCount: Number(raw.song_cnt || raw.songnum || raw.total_song_num || raw.song_count || 0),
    playCount: Number(raw.listen_num || raw.visitnum || raw.play_count || 0),
    creator: typeof creator === 'string' ? creator : 'QQ 音乐',
    kind,
    subscribed: kind === 'collect',
    isFavorite: isQQFavoritePlaylistName(name),
  };
  return { ...mapped, isLowSignal: isQzoneBackgroundPlaylist(mapped) };
}

export function mapQQPlaylistTrack(raw) {
  const source = raw || {};
  const track = source.songid || source.songmid || source.mid || source.name
    ? source
    : (source.track_info || source.songInfo || source.songinfo || source.song || {});
  const album = track?.album || {};
  const artists = mapQQArtists(track?.singer || track?.singers || []);
  const mid = track?.mid || track?.songmid || source.mid || source.songmid || '';
  const albumMid = album.mid || track?.albummid || source.albummid || '';
  return {
    provider: 'qq',
    source: 'qq',
    id: mid || String(track?.id || track?.songid || source.id || source.songid || ''),
    qqId: track?.id || track?.songid || source.id || source.songid || '',
    mid,
    songmid: mid,
    mediaMid: track?.file?.media_mid || track?.strMediaMid || track?.media_mid || source.strMediaMid || '',
    name: track?.name || track?.title || track?.songname || source.songname || source.title || '',
    artist: artists.map((artist) => artist.name).join(' / ') || track?.singername || source.singername || '',
    artists,
    artistId: artists[0]?.id || artists[0]?.mid || '',
    artistMid: artists[0]?.mid || '',
    album: album.name || album.title || track?.albumname || source.albumname || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300),
    duration: (Number(track?.interval || source.interval) || 0) * 1000,
    fee: track?.pay && Number(track.pay.pay_play) ? 1 : 0,
  };
}

export function normalizeQQPlaylistTrackLimit(limit) {
  const text = String(limit || '').trim().toLowerCase();
  if (text === 'all') return QQ_MAX_PLAYLIST_TRACK_LIMIT;
  const value = Number(text || QQ_DEFAULT_PLAYLIST_TRACK_LIMIT);
  if (!Number.isFinite(value)) return QQ_DEFAULT_PLAYLIST_TRACK_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), QQ_MAX_PLAYLIST_TRACK_LIMIT));
}

async function qqGetJSON(targetUrl, params = {}, cookieText = qqCookie, options = {}) {
  const url = new URL(targetUrl);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null) url.searchParams.set(key, String(value));
  });
  const headers = { ...(options.headers || {}) };
  if (options.useCookie !== false && cookieText) headers.Cookie = cookieText;
  const text = await fetchText(url, { headers });
  return parseJSONText(text);
}

async function handleQQUserPlaylists(cookieText = qqCookie) {
  const profile = normalizeQQProfile(cookieText);
  if (!profile.loggedIn || !profile.userId) return { loggedIn: false, provider: 'qq', playlists: [] };
  const uin = profile.userId;
  const createdRequest = qqGetJSON('https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss', {
    hostUin: 0,
    hostuin: uin,
    sin: 0,
    size: QQ_PLAYLIST_LIST_LIMIT,
    g_tk: qqGtk(cookieText),
    uin,
    loginUin: uin,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, cookieText, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const collectedRequest = qqGetJSON('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', {
    ct: 20,
    cid: 205360956,
    g_tk: qqGtk(cookieText),
    uin,
    userid: uin,
    reqtype: 3,
    sin: 0,
    ein: QQ_PLAYLIST_LIST_LIMIT - 1,
  }, cookieText, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const [createdRaw, collectedRaw] = await Promise.allSettled([createdRequest, collectedRequest]);

  // 以前这里把失败一律当空数组（{} → []），上游 403/code!=0 也悄悄变成「没有歌单」，
  // UI 上一点提示都没有。现在把每个来源的状态记下来，一起带回前端。
  const sourceState = (settled, paths) => {
    if (settled.status !== 'fulfilled') {
      return { ok: false, code: null, message: settled.reason?.message || 'request failed', raw: 0, list: [] };
    }
    const payload = settled.value || {};
    const list = paths.map((path) => path(payload)).find(Array.isArray) || [];
    const code = payload.code ?? payload.subcode ?? null;
    const ok = code === 0 || code === null;
    return {
      ok,
      code,
      message: payload.message || payload.msg || '',
      raw: list.length,
      list,
      // 上游报的目录总数（字段拼写就是 totoal）。拿它和最终展示条数对比，
      // 就能区分「QQ 那边确实只有这些歌单」和「我们这边过滤掉了」。
      total: payload?.data?.totoal ?? payload?.data?.total ?? payload?.total ?? null,
    };
  };

  const createdState = sourceState(createdRaw, [
    (p) => p?.data?.disslist, (p) => p?.disslist, (p) => p?.data?.cdlist, (p) => p?.data?.list,
  ]);
  const collectedState = sourceState(collectedRaw, [
    (p) => p?.data?.cdlist, (p) => p?.cdlist, (p) => p?.data?.disslist, (p) => p?.data?.list,
  ]);
  // 老接口拿不到创建歌单时，用 musicu 的 get_created_diss 再试一次。
  // 实测（2026-09-26，uin 2564942830）：该模块已下线，无论 g_tk 怎么算都返回
  // code 500003，所以这里通常救不回来，只作为兜底保留，不做主路径。
  if (!createdState.ok || createdState.raw === 0) {
    try {
      const fallback = await fetchQQCreatedDissByMusicu(uin, cookieText);
      if (fallback.length) {
        createdState.list = fallback;
        createdState.raw = fallback.length;
        createdState.ok = true;
        createdState.via = 'musicu';
      } else {
        createdState.via = 'musicu-empty';
      }
    } catch (error) {
      createdState.via = `musicu-failed:${error.message}`;
    }
  }

  const created = createdState.list.map((playlist) => mapQQPlaylistSummary(playlist, 'created'));
  const collected = collectedState.list.map((playlist) => mapQQPlaylistSummary(playlist, 'collect'));
  const seen = new Set();
  const dropped = [];
  const playlists = [...created, ...collected]
    .filter((playlist) => {
      let reason = '';
      if (!playlist.id) reason = 'no-id';
      else if (!playlist.name) reason = 'no-name';
      else if (seen.has(playlist.id)) reason = 'duplicate';
      else if (playlist.isLowSignal) reason = 'qzone-background';
      if (reason) {
        dropped.push({ name: playlist.name || '(无标题)', dirid: playlist.dirid, reason });
        return false;
      }
      seen.add(playlist.id);
      return true;
    })
    .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite))
    .map(({ isLowSignal, ...playlist }) => playlist);

  return {
    loggedIn: true,
    provider: 'qq',
    userId: uin,
    playlists,
    diagnostics: {
      created: { ok: createdState.ok, code: createdState.code, message: createdState.message, raw: createdState.raw, via: createdState.via || 'fcg_user_created_diss' },
      collected: { ok: collectedState.ok, code: collectedState.code, message: collectedState.message, raw: collectedState.raw },
      dropped: dropped.slice(0, 12),
    },
  };
}

// musicu 兜底：music.playlist.PlayListServer / get_created_diss
async function fetchQQCreatedDissByMusicu(uin, cookieText) {
  const data = await qqMusicRequest({
    comm: { ct: 24, cv: 0, g_tk: qqGtk(cookieText), uin, format: 'json', platform: 'yqq.json' },
    req: {
      module: 'music.playlist.PlayListServer',
      method: 'get_created_diss',
      param: { uin: Number(uin) || 0, sin: 0, num: QQ_PLAYLIST_LIST_LIMIT },
    },
  }, cookieText, Boolean(cookieText));
  const payload = data?.req?.data || {};
  return [payload.disslist, payload.list, payload.cdlist].find(Array.isArray) || [];
}

async function fetchQQPlaylistTracksByMusicu(playlistId, trackLimit, cookieText, profile) {
  const data = await qqMusicRequest({
    comm: {
      ct: 24,
      cv: 0,
      g_tk: 5381,
      uin: profile.userId,
      format: 'json',
      platform: 'yqq.json',
    },
    req: {
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: {
        disstid: playlistId,
        song_begin: 0,
        song_num: trackLimit,
        userinfo: 1,
        tag: 1,
      },
    },
  }, cookieText, Boolean(cookieText));
  const songlist = data?.req?.data?.songlist;
  return Array.isArray(songlist) ? songlist : [];
}

async function handleQQPlaylistTracks(id, limit = 50, cookieText = qqCookie) {
  const profile = normalizeQQProfile(cookieText);
  if (!profile.loggedIn || !profile.userId) return { loggedIn: false, provider: 'qq', songs: [], tracks: [] };
  const playlistId = String(id || '').trim();
  if (!playlistId) return { loggedIn: true, provider: 'qq', error: 'MISSING_QQ_PLAYLIST_ID', songs: [], tracks: [] };
  const trackLimit = normalizeQQPlaylistTrackLimit(limit);
  const data = await qqGetJSON('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
    type: 1,
    utf8: 1,
    disstid: playlistId,
    loginUin: profile.userId,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, cookieText, { headers: { Referer: 'https://y.qq.com/n/yqq/playlist' } });
  const detail = data?.cdlist?.[0] || {};
  let rawTracks = Array.isArray(detail.songlist) ? detail.songlist : [];
  let trackSource = 'qzone';
  if (rawTracks.length < trackLimit) {
    try {
      const musicuTracks = await fetchQQPlaylistTracksByMusicu(playlistId, trackLimit, cookieText, profile);
      if (musicuTracks.length > rawTracks.length) {
        rawTracks = musicuTracks;
        trackSource = 'musicu';
      }
    } catch {
      // Keep the legacy playlist detail result when the newer endpoint is unavailable.
    }
  }
  const songs = rawTracks
    .map(mapQQPlaylistTrack)
    .filter((song) => song.name && (song.mid || song.id))
    .slice(0, trackLimit);
  const playlist = {
    provider: 'qq',
    id: playlistId,
    name: detail.dissname || detail.diss_name || detail.name || '',
    cover: detail.logo || detail.diss_cover || '',
    trackCount: Number(detail.total_song_num || detail.songnum || detail.song_count || rawTracks.length || songs.length),
    loadedCount: songs.length,
    trackSource,
  };
  return { loggedIn: true, provider: 'qq', playlist, songs, tracks: songs };
}

async function qqSmartboxSearch(keywords, limit) {
  const url = new URL(QQ_SMARTBOX_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('key', keywords);
  url.searchParams.set('g_tk', '5381');
  url.searchParams.set('loginUin', '0');
  url.searchParams.set('hostUin', '0');
  url.searchParams.set('inCharset', 'utf8');
  url.searchParams.set('outCharset', 'utf-8');
  url.searchParams.set('notice', '0');
  url.searchParams.set('platform', 'yqq.json');
  url.searchParams.set('needNewCode', '0');
  const text = await fetchText(url);
  const data = parseJSONText(text);
  const items = data?.data?.song?.itemlist || [];
  return (Array.isArray(items) ? items : []).slice(0, Math.max(1, Math.min(limit || 8, 12))).map(mapQQSmartSong);
}

async function qqSongDetail(mid, fallback) {
  if (!mid) return fallback;
  const data = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    songinfo: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid },
    },
  });
  return mapQQTrack(data?.songinfo?.data?.track_info, fallback);
}

async function handleQQSearch(keywords, limit) {
  const query = String(keywords || '').trim();
  if (!query) return [];
  const base = await qqSmartboxSearch(query, limit);
  const detailed = await Promise.all(base.map(async (song) => {
    try {
      return await qqSongDetail(song.mid, song);
    } catch {
      return song;
    }
  }));
  const seen = new Set();
  return detailed.filter((song) => {
    const key = song?.mid || song?.id || `${song?.name}|${song?.artist}`;
    if (!key || seen.has(key) || !song?.name) return false;
    seen.add(key);
    return true;
  });
}

function normalizeQualityPreference(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['lossless', 'flac', 'sq'].includes(raw)) return 'lossless';
  if (['exhigh', 'high', '320', '320k', 'hq'].includes(raw)) return 'exhigh';
  if (['standard', 'normal', '128', '128k', 'std'].includes(raw)) return 'standard';
  if (['aac', 'm4a'].includes(raw)) return 'aac';
  return 'exhigh';
}

export function qualityCandidatesFrom(target) {
  const normalized = normalizeQualityPreference(target);
  let index = QQ_QUALITY_CANDIDATES.findIndex((item) => item.level === normalized);
  if (index < 0) index = 0;
  return QQ_QUALITY_CANDIDATES.slice(index);
}

async function handleQQSongUrl(mid, mediaMid, qualityPreference, cookieText = qqCookie) {
  const songmid = String(mid || '').trim();
  if (!songmid) return { provider: 'qq', url: '', playable: false, error: 'MISSING_MID' };

  const cookie = qqCookieObject(cookieText);
  const userId = qqCookieUin(cookie) || '0';
  const musicKey = qqCookieMusicKey(cookie);
  const playbackKey = qqCookiePlaybackKey(cookie);
  const mediaIds = [mediaMid, songmid].map((value) => String(value || '').trim()).filter(Boolean);
  const uniqueMediaIds = [...new Set(mediaIds)];
  const fileCandidates = uniqueMediaIds.flatMap((id) => (
    qualityCandidatesFrom(qualityPreference).map((item) => ({
      ...item,
      filename: `${item.prefix}${id}${item.ext}`,
    }))
  ));
  // 试听兜底放最后：RS02 是 QQ 的试听格式（约 60 秒），实测它对没拿到完整
  // 授权的登录态也会放行。只有上面所有完整音质全被 QQ 拒掉时才会轮到它——
  // 宁可让用户听到 60 秒并明确提示，也别一声不吭地"播不了"。
  const trialCandidates = uniqueMediaIds.map((id) => ({
    prefix: 'RS02', ext: '.mp3', level: 'trial', label: '试听片段',
    filename: `RS02${id}.mp3`,
  }));
  const allCandidates = [...fileCandidates, ...trialCandidates];
  const filenames = allCandidates.map((item) => item.filename);

  const param = {
    guid: String(10000000 + Math.floor(Math.random() * 90000000)),
    songmid: filenames.length ? filenames.map(() => songmid) : [songmid],
    songtype: filenames.length ? filenames.map(() => 0) : [0],
    uin: userId,
    loginflag: 1,
    platform: '20',
    ...(filenames.length ? { filename: filenames } : {}),
  };
  const comm = { uin: userId, format: 'json', ct: musicKey ? 19 : 24, cv: 0 };
  if (musicKey) comm.authst = musicKey;

  const data = await qqMusicRequest({
    comm,
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param,
    },
  }, cookieText, true);
  const responseData = data?.req_0?.data || {};
  const infos = Array.isArray(responseData.midurlinfo) ? responseData.midurlinfo : [];
  const info = infos.find((item) => item?.purl) || infos[0];
  const purl = info?.purl;
  if (purl) {
    const sip = responseData.sip?.[0] || 'https://ws.stream.qqmusic.qq.com/';
    const fileMeta = allCandidates.find((item) => item.filename === info.filename) || {};
    const trial = fileMeta.level === 'trial';
    return {
      provider: 'qq',
      url: `${sip}${purl}`,
      playable: true,
      level: fileMeta.level || info.filename || '',
      quality: fileMeta.label || info.filename || '',
      filename: info.filename || '',
      // 只拿到试听片段时如实标注，前端会据此提示"完整播放需要会员权限"
      trial,
      ...(trial ? { message: 'QQ 音乐只授予了试听片段（约 60 秒），完整播放需要会员权限' } : {}),
    };
  }

  return {
    provider: 'qq',
    url: '',
    playable: false,
    error: 'QQ_URL_UNAVAILABLE',
    loggedIn: Boolean(userId && musicKey),
    playbackKeyReady: Boolean(userId && playbackKey),
    message: !musicKey
      ? 'QQ 音乐需要登录后才能获取播放地址'
      : `QQ 音乐没有返回「${info?.filename || '这首歌曲'}」的播放地址。该歌曲需要会员（部分目录还要豪华绿钻）；如果你确认已开通，请核对 ORBIT 登录的是不是购买会员的那个 QQ 号`,
  };
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

function decodeQQLyricText(text) {
  let raw = decodeHtmlEntities(String(text || '').trim());
  const compact = raw.replace(/\s+/g, '');
  const looksBase64 = compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (looksBase64 && !/^\s*\[/.test(raw)) {
    try {
      raw = Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '');
    } catch {
      // Keep the original response when it is not actually base64.
    }
  }
  return decodeHtmlEntities(raw).replace(/\r\n/g, '\n').trim();
}

async function handleQQLyric(mid, id, cookieText = qqCookie) {
  const songMID = String(mid || '').trim();
  const songID = Number(String(id || '').replace(/\D/g, '')) || 0;
  if (!songMID && !songID) return { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' };

  const param = {};
  if (songMID) param.songMID = songMID;
  if (songID) param.songID = songID;
  const data = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    lyric: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param,
    },
  }, cookieText, true);
  const lyricData = data?.lyric?.data || {};
  return {
    provider: 'qq',
    id: songID || '',
    mid: songMID,
    lyric: decodeQQLyricText(lyricData.lyric),
    tlyric: decodeQQLyricText(lyricData.trans),
    qrc: decodeQQLyricText(lyricData.qrc),
    roma: decodeQQLyricText(lyricData.roma),
  };
}

async function readRequestJson(req) {
  return await new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function audioContentType(audioUrl, upstreamType) {
  let pathname = '';
  try {
    pathname = new URL(audioUrl).pathname.toLowerCase();
  } catch {
    pathname = '';
  }
  if (/\.flac$/.test(pathname)) return 'audio/flac';
  if (/\.mp3$/.test(pathname)) return 'audio/mpeg';
  if (/\.(m4a|mp4)$/.test(pathname)) return 'audio/mp4';
  return upstreamType || 'audio/mpeg';
}

async function streamAudio(req, res, audioUrl, range) {
  const headers = { 'User-Agent': UA, Referer: 'https://y.qq.com/' };
  if (range) headers.Range = range;
  const audioResponse = await fetch(audioUrl, { headers });
  res.statusCode = audioResponse.status;
  ['content-length', 'content-range', 'accept-ranges'].forEach((header) => {
    const value = audioResponse.headers.get(header);
    if (value) res.setHeader(header, value);
  });
  res.setHeader('Content-Type', audioContentType(audioUrl, audioResponse.headers.get('content-type')));
  if (!audioResponse.body) {
    res.end();
    return;
  }
  const reader = audioResponse.body.getReader();
  const pump = async () => {
    try {
      if (req.destroyed || res.destroyed) {
        reader.cancel().catch(() => {});
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        if (!res.destroyed) res.end();
        return;
      }
      res.write(Buffer.from(value), (err) => {
        if (err) reader.cancel().catch(() => {});
        else pump();
      });
    } catch (err) {
      if (!res.destroyed) res.end();
    }
  };
  req.on('close', () => {
    reader.cancel().catch(() => {});
  });
  pump();
}

function writeJsonResponse(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function handleRoute(req, res, parsedUrl, writeJson = writeJsonResponse) {
  const pathname = parsedUrl.pathname;
  try {
    if (pathname === '/api/qq/login/status') {
      writeJson(res, 200, normalizeQQProfile(qqCookie));
      return true;
    }

    if (pathname === '/api/qq/login/cookie') {
      if (!['POST', 'PUT'].includes(req.method || '')) return false;
      const body = req.body && typeof req.body === 'object' ? req.body : await readRequestJson(req);
      const normalized = normalizeQQCookieInput(body.cookie || body.data || body.text || '');
      const info = normalizeQQProfile(normalized);
      if (!info.loggedIn) {
        writeJson(res, 400, { provider: 'qq', loggedIn: false, error: 'INVALID_QQ_COOKIE' });
        return true;
      }
      setQQCookie(normalized);
      writeJson(res, 200, { ...normalizeQQProfile(qqCookie), saved: true });
      return true;
    }

    if (pathname === '/api/qq/logout') {
      setQQCookie('');
      writeJson(res, 200, { provider: 'qq', ok: true, loggedIn: false });
      return true;
    }

    if (pathname === '/api/qq/user/playlists') {
      const playlists = await handleQQUserPlaylists(currentCookie(req));
      writeJson(res, playlists.loggedIn ? 200 : 401, playlists);
      return true;
    }

    if (pathname === '/api/qq/playlist/tracks') {
      const result = await handleQQPlaylistTracks(
        parsedUrl.searchParams.get('id') || parsedUrl.searchParams.get('disstid') || '',
        parsedUrl.searchParams.get('limit') || 'all',
        currentCookie(req),
      );
      writeJson(res, result.loggedIn === false ? 401 : 200, result);
      return true;
    }

    if (pathname === '/api/qq/search') {
      const keywords = parsedUrl.searchParams.get('keywords') || '';
      const requestedLimit = Number(parsedUrl.searchParams.get('limit') || '12');
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 20)) : 12;
      const songs = await handleQQSearch(keywords, limit);
      writeJson(res, 200, { provider: 'qq', songs, rawCount: songs.length, filteredCount: songs.length });
      return true;
    }

    if (pathname === '/api/qq/song/url') {
      const cookie = currentCookie(req);
      const info = await handleQQSongUrl(
        parsedUrl.searchParams.get('mid') || parsedUrl.searchParams.get('id') || '',
        parsedUrl.searchParams.get('mediaMid') || parsedUrl.searchParams.get('media_mid') || '',
        parsedUrl.searchParams.get('quality') || '',
        cookie,
      );
      writeJson(res, 200, info);
      return true;
    }

    if (pathname === '/api/qq/lyric') {
      const lyric = await handleQQLyric(
        parsedUrl.searchParams.get('mid') || parsedUrl.searchParams.get('songmid') || '',
        parsedUrl.searchParams.get('id') || parsedUrl.searchParams.get('qqId') || '',
        currentCookie(req),
      );
      writeJson(res, 200, lyric);
      return true;
    }

    if (pathname === '/api/qq/cover') {
      const albumMid = parsedUrl.searchParams.get('id') || '';
      const size = parsedUrl.searchParams.get('size') || '300';
      if (!albumMid) {
        writeJson(res, 400, { error: 'Missing album id' });
        return true;
      }
      const targetUrl = rawQQAlbumCover(albumMid, size);
      const fetchRes = await fetch(targetUrl, {
        headers: { 'Referer': 'https://y.qq.com/' }
      });
      if (!fetchRes.ok) throw new Error('Proxy cover failed');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', fetchRes.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=2592000');
      const buffer = await fetchRes.arrayBuffer();
      res.end(Buffer.from(buffer));
      return true;
    }

    if (pathname === '/api/qq/audio') {
      const info = await handleQQSongUrl(
        parsedUrl.searchParams.get('mid') || parsedUrl.searchParams.get('id') || '',
        parsedUrl.searchParams.get('mediaMid') || parsedUrl.searchParams.get('media_mid') || '',
        parsedUrl.searchParams.get('quality') || '',
        currentCookie(req),
      );
      if (!info.url) {
        writeJson(res, 404, { error: 'No playable QQ url for this song', info });
        return true;
      }
      // 试听片段打上标记头：前端用同源 fetch 读它，提示用户"这只是试听"
      if (info.trial) res.setHeader('X-Orbit-QQ-Trial', '1');
      await streamAudio(req, res, info.url, req.headers?.range);
      return true;
    }
  } catch (error) {
    writeJson(res, 500, { provider: 'qq', error: error.message || 'QQ Music request failed' });
    return true;
  }

  return false;
}

export function registerQQMusicExpressRoutes(app) {
  app.use(async (req, res, next) => {
    const parsedUrl = new URL(req.originalUrl || req.url || '', 'http://localhost');
    if (await handleRoute(req, res, parsedUrl, (response, status, payload) => response.status(status).json(payload))) return;
    next();
  });
}

export function registerQQMusicViteMiddlewares(server, writeJson) {
  server.middlewares.use(async (req, res, next) => {
    const parsedUrl = new URL(req.url || '', 'http://localhost');
    if (!parsedUrl.pathname.startsWith('/api/qq/')) {
      next();
      return;
    }
    if (await handleRoute(req, res, parsedUrl, writeJson)) return;
    next();
  });
}
