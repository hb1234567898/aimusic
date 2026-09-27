const STORAGE_KEY = 'orbit.netease.library.v1';
export const MAX_NETEASE_IMPORTS = 30;

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

function readStored() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return {
      name: String(value?.name || '网易云音乐'),
      cover: String(value?.cover || ''),
      songs: Array.isArray(value?.songs) ? value.songs.map(normalizeSong).filter(Boolean).slice(0, MAX_NETEASE_IMPORTS) : [],
    };
  } catch { return { name: '网易云音乐', cover: '', songs: [] }; }
}

function writeStored(value) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* in-memory playback still works */ }
}

function rebuild(library, songs) {
  for (let index = library.length - 1; index >= 0; index -= 1) {
    if (library[index]?.provider === 'netease') library.splice(index, 1);
  }
  songs.forEach(song => library.push(toTrack(song, library.length)));
  library.forEach((track, index) => { track.id = index; });
  return songs.length;
}

export function hydrateNeteaseTracks(library) {
  return rebuild(library, readStored().songs);
}

export function readNeteaseCollection() {
  const stored = readStored();
  return { name: stored.name, cover: stored.cover, count: stored.songs.length };
}

export function importNeteaseTracks(library, songs, meta = {}) {
  const incoming = (songs || []).map(normalizeSong).filter(Boolean);
  if (!incoming.length) return { added: 0, count: readStored().songs.length };
  const previous = readStored();
  const base = meta.replace ? [] : previous.songs;
  const known = new Set(base.map(song => song.cloudId));
  const fresh = incoming.filter(song => !known.has(song.cloudId)).slice(0, Math.max(0, MAX_NETEASE_IMPORTS - base.length));
  const next = {
    name: String(meta.name || (meta.replace ? '网易云音乐' : previous.name)),
    cover: String(meta.cover || (meta.replace ? '' : previous.cover)),
    songs: base.concat(fresh).slice(0, MAX_NETEASE_IMPORTS),
  };
  writeStored(next);
  rebuild(library, next.songs);
  return { added: fresh.length, count: next.songs.length, name: next.name };
}

export function clearNeteaseTracks(library) {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  rebuild(library, []);
}
