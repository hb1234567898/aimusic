const LEGACY_KEY = 'orbit.netease.library.v1';
const LIBRARY_KEY = 'orbit.netease.library.v2';
export const MAX_NETEASE_IMPORTS = 30;
export const MAX_NETEASE_PLAYLISTS = 8;
export const NETEASE_LOOSE_PLAYLIST_ID = 'loose';

const encode = value => encodeURIComponent(String(value || ''));

function normalizeSong(song) {
  const cloudId = String(song?.cloudId || song?.id || '').trim();
  const title = String(song?.title || song?.name || '').trim();
  if (!cloudId || !title) return null;
  const rawDuration = Number(song?.duration || 0);
  return {
    provider: 'netease', cloudId, title,
    artist: String(song?.artist || '网易云音乐'),
    album: String(song?.album || '网易云音乐'),
    cover: String(song?.cover || ''),
    duration: Math.max(0, rawDuration > 10000 ? rawDuration / 1000 : rawDuration),
    fee: Number(song?.fee || 0),
  };
}

function toTrack(song, id) {
  return {
    ...song, id, genre: 'NETEASE',
    src: `/api/netease/audio?id=${encode(song.cloudId)}&br=320000`,
    lyrics: `/api/netease/lyric?id=${encode(song.cloudId)}`,
    sourceUrl: `https://music.163.com/#/song?id=${encode(song.cloudId)}`,
    note: `${song.title} · ${song.artist}。由 ORBIT Bridge 从网易云音乐导入，播放地址按当前扫码账号实时获取。`,
  };
}

function normalizePlaylist(entry, index) {
  const songs = Array.isArray(entry?.songs) ? entry.songs.map(normalizeSong).filter(Boolean).slice(0, MAX_NETEASE_IMPORTS) : [];
  if (!songs.length) return null;
  return {
    id: String(entry.id || `local-${index}`),
    name: String(entry.name || '网易云音乐'),
    cover: String(entry.cover || ''),
    addedAt: Number(entry.addedAt || 0),
    songs,
  };
}

function writeLibrary(value) {
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify({ version: 2, ...value })); } catch { /* memory playback still works */ }
}

function readLibrary() {
  try {
    const raw = JSON.parse(localStorage.getItem(LIBRARY_KEY) || 'null');
    if (raw && Array.isArray(raw.playlists)) {
      const playlists = raw.playlists.map(normalizePlaylist).filter(Boolean);
      const activeId = playlists.some(item => item.id === raw.activeId) ? raw.activeId : (playlists[0]?.id ?? null);
      return { activeId, playlists };
    }
  } catch { /* migrate or start empty */ }

  // 1.0.9/1.0.10 只有一个扁平网易云曲库。升级后把它变成一个真实歌单，
  // 这样用户已经导入的 30 首不会丢，也不再叠到 QQ 当前歌单上。
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
    const migrated = normalizePlaylist({ id: 'migrated', name: legacy?.name || '网易云已导入', cover: legacy?.cover, songs: legacy?.songs }, 0);
    if (migrated) {
      const next = { activeId: migrated.id, playlists: [migrated] };
      writeLibrary(next);
      localStorage.removeItem(LEGACY_KEY);
      return next;
    }
  } catch { /* ignore invalid legacy data */ }
  return { activeId: null, playlists: [] };
}

function activeSongs(value) {
  return value.playlists.find(item => item.id === value.activeId)?.songs || [];
}

function rebuild(library, songs) {
  for (let index = library.length - 1; index >= 0; index -= 1) {
    if (library[index]?.provider === 'netease') library.splice(index, 1);
  }
  songs.forEach(song => library.push(toTrack(song, library.length)));
  library.forEach((track, index) => { track.id = index; });
  return songs.length;
}

const summary = playlist => ({ id: playlist.id, name: playlist.name, cover: playlist.cover, count: playlist.songs.length, provider: 'netease' });

export function hydrateNeteaseTracks(library) {
  return rebuild(library, activeSongs(readLibrary()));
}

export function listNeteasePlaylists() {
  return readLibrary().playlists.map(summary);
}

export function getActiveNeteasePlaylistId() {
  return readLibrary().activeId;
}

export function importNeteaseTracks(library, songs, meta = {}) {
  const incoming = (songs || []).map(normalizeSong).filter(Boolean);
  const stored = readLibrary();
  if (!incoming.length) return { added: 0, count: activeSongs(stored).length, reason: 'empty' };
  const id = String(meta.id || NETEASE_LOOSE_PLAYLIST_ID);
  let playlist = stored.playlists.find(item => item.id === id);
  if (!playlist) {
    if (stored.playlists.length >= MAX_NETEASE_PLAYLISTS) return { added: 0, count: activeSongs(stored).length, reason: 'playlist-limit' };
    playlist = { id, name: String(meta.name || '网易云零散导入'), cover: String(meta.cover || ''), addedAt: Date.now(), songs: [] };
    stored.playlists.push(playlist);
  }
  const known = new Set(playlist.songs.map(song => song.cloudId));
  const fresh = incoming.filter(song => !known.has(song.cloudId)).slice(0, Math.max(0, MAX_NETEASE_IMPORTS - playlist.songs.length));
  if (!fresh.length) return { added: 0, count: playlist.songs.length, playlist: summary(playlist), reason: 'duplicate' };
  playlist.songs = playlist.songs.concat(fresh);
  stored.activeId = playlist.id;
  writeLibrary(stored);
  rebuild(library, playlist.songs);
  return { added: fresh.length, count: playlist.songs.length, name: playlist.name, playlist: summary(playlist) };
}

export function switchNeteasePlaylist(library, id) {
  const stored = readLibrary();
  stored.activeId = stored.playlists.some(item => item.id === id) ? id : (stored.playlists[0]?.id ?? null);
  writeLibrary(stored);
  const count = rebuild(library, activeSongs(stored));
  return { id: stored.activeId, count };
}

export function removeNeteasePlaylist(library, id) {
  const stored = readLibrary();
  const next = stored.playlists.filter(item => item.id !== id);
  if (next.length === stored.playlists.length) return { removed: 0, activeId: stored.activeId };
  stored.playlists = next;
  if (stored.activeId === id) stored.activeId = next[0]?.id ?? null;
  writeLibrary(stored);
  return { removed: 1, activeId: stored.activeId, count: rebuild(library, activeSongs(stored)) };
}

export function clearNeteaseTracks(library) {
  try { localStorage.removeItem(LIBRARY_KEY); localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  rebuild(library, []);
}
