import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
};

const library = await import('../src/neteaseLibrary.js');

test('migrates the old flat Netease collection into its own playlist', () => {
  values.clear();
  values.set('orbit.netease.library.v1', JSON.stringify({
    name: '旧网易云导入',
    songs: [{ id: 1, name: '旧歌', artist: '歌手', duration: 180000 }],
  }));
  assert.deepEqual(library.listNeteasePlaylists().map(item => ({ id: item.id, name: item.name, count: item.count })), [
    { id: 'migrated', name: '旧网易云导入', count: 1 },
  ]);
  assert.equal(values.has('orbit.netease.library.v1'), false);
});

test('stores separate playlists and activates only one 30-song list', () => {
  values.clear();
  const runtime = [];
  const first = Array.from({ length: 35 }, (_, index) => ({ id: `a-${index}`, name: `A${index}`, duration: 200000 }));
  const second = Array.from({ length: 4 }, (_, index) => ({ id: `b-${index}`, name: `B${index}`, duration: 200000 }));
  const importedA = library.importNeteaseTracks(runtime, first, { id: 'playlist-a', name: '歌单 A' });
  const importedB = library.importNeteaseTracks(runtime, second, { id: 'playlist-b', name: '歌单 B' });
  assert.equal(importedA.count, 30);
  assert.equal(importedB.count, 4);
  assert.deepEqual(library.listNeteasePlaylists().map(item => [item.id, item.count]), [['playlist-a', 30], ['playlist-b', 4]]);
  assert.equal(runtime.length, 4);
  assert.equal(runtime.every(track => track.provider === 'netease' && track.cloudId.startsWith('b-')), true);
  library.switchNeteasePlaylist(runtime, 'playlist-a');
  assert.equal(runtime.length, 30);
  assert.equal(runtime.every(track => track.provider === 'netease' && track.cloudId.startsWith('a-')), true);
});
