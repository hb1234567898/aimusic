// QQ 导入曲库：按「歌单」为单位存储，而不是把所有歌平铺成一堆。
// 这样才有「切换歌单」这回事——切的是当前生效的那批歌（音乐宇宙里的卡片、
// 上一首/下一首的循环范围，全都跟着变）。
const LEGACY_KEY = 'orbit.qq.imported.v1';
const LIBRARY_KEY = 'orbit.qq.library.v2';

// 单个歌单最多多少首。音乐宇宙的卡片排布是按 19～30 张设计的，
// 再往上堆卡片会挤成一团，所以上限定在 30。
export const MAX_QQ_IMPORTS = 30;
// 歌单个数上限：单个歌单 30 首 × 8 个 = 240 首，再多是纯负担。
export const MAX_QQ_PLAYLISTS = 8;
// 从搜索结果逐首“＋”进来的歌，没有归属歌单，统一塞进这个兜底歌单。
export const LOOSE_PLAYLIST_ID = 'loose';
const LOOSE_PLAYLIST_NAME = '零散导入';

const encode = value => encodeURIComponent(String(value || ''));

// 这个函数要能吃两种形状：QQ 接口返回的原始歌曲（name + 毫秒时长），
// 以及本地存盘后回读的归一化歌曲（title + 秒）。
// 不能靠 provider 字段区分——服务端返回的对象也带 provider: 'qq'，
// 那样会把 224000 毫秒原样当秒存进去，时长就变成 62 小时。
// 改按时长量级判断：真歌的毫秒值必然 ≥ 10000（10 秒），
// 而秒单位的歌曲几乎不可能超过 10000（两个多小时），以此分界。
// 附带的好处：上一版已经写坏的存量数据（毫秒当秒存的）回读时会自动除回来。
function normalizeRemoteSong(song) {
  const mid = String(song?.mid || song?.songmid || song?.id || '').trim();
  const title = String(song?.name || song?.title || '').trim();
  if (!mid || !title) return null;
  const rawDuration = Number(song?.duration || 0);
  return {
    provider: 'qq',
    qqId: String(song.qqId || ''),
    mid,
    mediaMid: String(song.mediaMid || ''),
    title,
    artist: String(song.artist || 'QQ 音乐').trim(),
    album: String(song.album || 'QQ 音乐').trim(),
    albumMid: String(song.albumMid || ''),
    cover: String(song.cover || ''),
    duration: Math.max(0, rawDuration > 10000 ? rawDuration / 1000 : rawDuration),
    fee: Number(song.fee || 0),
  };
}

function toOrbitTrack(song, id) {
  const lyricQuery = `mid=${encode(song.mid)}${song.qqId ? `&id=${encode(song.qqId)}` : ''}`;
  const audioQuery = `mid=${encode(song.mid)}${song.mediaMid ? `&mediaMid=${encode(song.mediaMid)}` : ''}&quality=exhigh`;
  return {
    ...song,
    id,
    genre: 'QQ MUSIC',
    cover: song.cover || (song.albumMid ? `/api/qq/cover?id=${encode(song.albumMid)}&size=500` : ''),
    src: `/api/qq/audio?${audioQuery}`,
    lyrics: `/api/qq/lyric?${lyricQuery}`,
    sourceUrl: `https://y.qq.com/n/ryqq/songDetail/${encode(song.mid)}`,
    note: `${song.title} · ${song.artist}。由 ORBIT Bridge 从 QQ 音乐导入，播放地址按当前登录状态实时获取。`,
  };
}

// 存盘前把运行时才拼出来的字段剥掉，避免 src/lyrics 这类地址被固化进存储，
// 以后接口一变就全成死链。
function stripRuntimeFields(song) {
  const { id, genre, src, lyrics, sourceUrl, note, ...rest } = song;
  return rest;
}

function normalizePlaylist(entry, index) {
  if (!entry || !Array.isArray(entry.songs)) return null;
  const songs = entry.songs.map(normalizeRemoteSong).filter(Boolean);
  if (!songs.length) return null;
  const id = String(entry.id || entry.dissid || '').trim() || `local-${index}`;
  return {
    id,
    name: String(entry.name || '未命名歌单').trim(),
    cover: String(entry.cover || ''),
    creator: String(entry.creator || ''),
    sourceUrl: String(entry.sourceUrl || ''),
    addedAt: Number(entry.addedAt || 0),
    songs,
  };
}

function summarize(playlist) {
  return {
    id: playlist.id,
    name: playlist.name,
    cover: playlist.cover,
    creator: playlist.creator,
    count: playlist.songs.length,
  };
}

function readLegacySongs() {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.map(normalizeRemoteSong).filter(Boolean).slice(0, MAX_QQ_IMPORTS);
  } catch {
    return [];
  }
}

function readLibrary() {
  try {
    const raw = JSON.parse(localStorage.getItem(LIBRARY_KEY) || 'null');
    if (raw && Array.isArray(raw.playlists)) {
      const playlists = raw.playlists.map(normalizePlaylist).filter(Boolean);
      // 永远必须有一个生效歌单（不再有「全部」）：activeId 指向的歌单被删掉
      // 或压根没存过时，回落到第一个歌单。
      const valid = playlists.some(playlist => playlist.id === raw.activeId)
        ? raw.activeId
        : (playlists[0]?.id ?? null);
      return { activeId: valid, playlists };
    }
  } catch { /* 存储坏了就当没有，下面走迁移或空库 */ }

  const legacy = readLegacySongs();
  if (legacy.length) {
    const migrated = {
      activeId: null,
      playlists: [{
        id: 'legacy',
        name: '已导入的歌曲',
        cover: '',
        creator: '',
        sourceUrl: '',
        addedAt: Date.now(),
        songs: legacy,
      }],
    };
    writeLibrary(migrated);
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* 删不掉也不影响 */ }
    return migrated;
  }
  return { activeId: null, playlists: [] };
}

function writeLibrary(library) {
  const payload = {
    version: 2,
    activeId: library.activeId ?? null,
    playlists: library.playlists.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      cover: playlist.cover,
      creator: playlist.creator,
      sourceUrl: playlist.sourceUrl,
      addedAt: playlist.addedAt,
      songs: playlist.songs.map(stripRuntimeFields),
    })),
  };
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(payload));
  } catch { /* 隐私模式下写不进去，内存里仍然可用 */ }
}

// 当前生效的曲目：指定了歌单就只取那个歌单，否则把所有歌单的歌按序拼起来
// （跨歌单重复的歌只留一首，免得同一个 mid 在宇宙里出现两张卡片）。
function activeSongs(library) {
  const { activeId, playlists } = library;
  const target = activeId ? playlists.find(playlist => playlist.id === activeId) : null;
  if (target) return target.songs.map(song => ({ ...song }));
  const seen = new Set();
  const merged = [];
  playlists.forEach(playlist => playlist.songs.forEach(song => {
    if (seen.has(song.mid)) return;
    seen.add(song.mid);
    merged.push({ ...song });
  }));
  return merged;
}

// 把 QQ 部分整体替换掉，本地曲目原样保留，然后重排 id。
function rebuild(library, songs) {
  for (let index = library.length - 1; index >= 0; index -= 1) {
    if (library[index]?.provider === 'qq') library.splice(index, 1);
  }
  const seen = new Set();
  songs.forEach(song => {
    if (!song || seen.has(song.mid)) return;
    seen.add(song.mid);
    library.push(toOrbitTrack(song, library.length));
  });
  library.forEach((track, index) => { track.id = index; });
  return library.filter(track => track.provider === 'qq').length;
}

export function hydrateQQTracks(library) {
  const stored = readLibrary();
  rebuild(library, activeSongs(stored));
  return library.length;
}

export function listQQPlaylists() {
  return readLibrary().playlists.map(summarize);
}

export function getActivePlaylistId() {
  return readLibrary().activeId;
}

// 导入一批歌到某个歌单。meta 为 null 表示零散导入（搜索结果逐首添加）。
// 返回实际新增条数——已经在歌单里的会跳过，不重复计数。
export function importQQPlaylist(library, meta, songs) {
  const stored = readLibrary();
  const incoming = (songs || []).map(normalizeRemoteSong).filter(Boolean);
  if (!incoming.length) return { added: 0, playlist: null, reason: 'empty' };

  const id = String(meta?.id || LOOSE_PLAYLIST_ID).trim() || LOOSE_PLAYLIST_ID;
  let playlist = stored.playlists.find(item => item.id === id);

  if (playlist) {
    const known = new Set(playlist.songs.map(song => song.mid));
    const room = Math.max(0, MAX_QQ_IMPORTS - playlist.songs.length);
    const fresh = incoming.filter(song => !known.has(song.mid)).slice(0, room);
    if (!fresh.length) return { added: 0, playlist: summarize(playlist), reason: 'duplicate' };
    playlist.songs = playlist.songs.concat(fresh);
    writeLibrary(stored);
    rebuild(library, activeSongs(stored));
    return { added: fresh.length, playlist: summarize(playlist) };
  }

  if (stored.playlists.length >= MAX_QQ_PLAYLISTS) {
    return { added: 0, playlist: null, reason: 'playlist-limit' };
  }

  playlist = {
    id,
    name: String(meta?.name || LOOSE_PLAYLIST_NAME).trim(),
    cover: String(meta?.cover || ''),
    creator: String(meta?.creator || ''),
    sourceUrl: String(meta?.sourceUrl || ''),
    addedAt: Date.now(),
    songs: incoming.slice(0, MAX_QQ_IMPORTS),
  };
  stored.playlists.push(playlist);
  writeLibrary(stored);
  rebuild(library, activeSongs(stored));
  return { added: playlist.songs.length, playlist: summarize(playlist) };
}

// 切换当前生效的歌单。歌单之间是互斥的列表关系，没有「全部」这个视图——
// 传 null/未知的 id 时回落到第一个歌单。
export function switchQQPlaylist(library, id) {
  const stored = readLibrary();
  const nextId = stored.playlists.some(playlist => playlist.id === id)
    ? id
    : (stored.playlists[0]?.id ?? null);
  stored.activeId = nextId;
  writeLibrary(stored);
  const count = rebuild(library, activeSongs(stored));
  return { id: nextId, count };
}

export function removeQQPlaylist(library, id) {
  const stored = readLibrary();
  const next = stored.playlists.filter(playlist => playlist.id !== id);
  if (next.length === stored.playlists.length) return { removed: 0, activeId: stored.activeId };
  // 删掉的正好是生效歌单时，落到剩下的第一个（没有歌单了才是 null）
  stored.playlists = next;
  if (stored.activeId === id) stored.activeId = next[0]?.id ?? null;
  writeLibrary(stored);
  const count = rebuild(library, activeSongs(stored));
  return { removed: 1, activeId: stored.activeId, count };
}

export function clearQQTracks(library) {
  try {
    localStorage.removeItem(LIBRARY_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* 忽略 */ }
  rebuild(library, []);
  return library.length;
}
