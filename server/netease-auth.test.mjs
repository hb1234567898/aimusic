import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNeteasePlayerUrl, hasNeteaseLogin, mapNeteaseSong,
  normalizeNeteaseBitrate, normalizeNeteaseCookie,
} from './netease-music.mjs';

test('normalizes multiline Netease cookies and detects MUSIC_U', () => {
  const cookie = normalizeNeteaseCookie('MUSIC_U=token;\n__csrf=value;;');
  assert.equal(cookie, 'MUSIC_U=token; __csrf=value');
  assert.equal(hasNeteaseLogin(cookie), true);
  assert.equal(hasNeteaseLogin('__csrf=value'), false);
});

test('allows supported bitrates and falls back to 320k', () => {
  assert.equal(normalizeNeteaseBitrate('128000'), '128000');
  assert.equal(normalizeNeteaseBitrate('999999'), '320000');
  assert.match(buildNeteasePlayerUrl('123', '192000'), /id=123.*br=192000/);
});

test('maps both old and new Netease song payloads', () => {
  assert.deepEqual(mapNeteaseSong({ id: 7, name: '夜航', ar: [{ name: '月' }], al: { name: '轨道', picUrl: 'cover' }, dt: 215000, fee: 1 }), {
    provider: 'netease', id: '7', name: '夜航', artist: '月', album: '轨道', cover: 'cover', duration: 215000, fee: 1,
  });
});
