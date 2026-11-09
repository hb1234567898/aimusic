import test from 'node:test';
import assert from 'node:assert/strict';
import { registerNeteaseMusicExpressRoutes } from './netease-music.mjs';
import { parseLyricsPayload } from '../src/lyrics.js';

test('Netease route returns two untouched LRC documents and client aligns translations', async t => {
  const original = '[00:10]Original A\n[00:20]Original B';
  const translated = '[00:20]译文乙\n[00:10]译文甲';
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    lrc: { lyric: original }, tlyric: { lyric: translated },
  }));
  const routes = new Map();
  const app = { get: (url, handler) => routes.set(url, handler), put() {}, post() {} };
  registerNeteaseMusicExpressRoutes(app);
  let result;
  await routes.get('/api/netease/lyric')({ query: { id: '123' } }, { json: value => { result = value; } });
  assert.deepEqual(result, { provider: 'netease', id: '123', lyric: original, tlyric: translated, yrc: '', ytlyric: '' });
  const parsed = parseLyricsPayload(result);
  assert.deepEqual(parsed.rows.map(row => row.time), [10, 20]);
  assert.deepEqual(parsed.rows.map(row => row.translations), [['译文甲'], ['译文乙']]);
});

test('Netease requests native YRC and its matching translation instead of concatenating LRC', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(String(url), /\/api\/song\/lyric\/v1\?/);
    assert.match(String(url), /yv=0/);
    return Response.json({ lrc: { lyric: '[00:01]测试' }, tlyric: { lyric: '[00:00.99]旧翻译' },
      yrc: { lyric: '[1000,1200](1000,500,0)测(1500,700,0)试' }, ytlrc: { lyric: '[00:01]匹配翻译' } });
  });
  const routes = new Map();
  registerNeteaseMusicExpressRoutes({ get: (url, handler) => routes.set(url, handler), put() {}, post() {} });
  let result;
  await routes.get('/api/netease/lyric')({ query: { id: '123' } }, { json: value => { result = value; } });
  const parsed = parseLyricsPayload(result);
  assert.deepEqual(parsed.rows[0].wordLines[0], [{ text: '测', start: 1, end: 1.5 }, { text: '试', start: 1.5, end: 2.2 }]);
  assert.deepEqual(parsed.rows[0].translations, ['匹配翻译']);
});

test('Netease falls back to the old line endpoint when the YRC endpoint fails', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    if (urls.length === 1) throw new Error('unavailable');
    return Response.json({ lrc: { lyric: '[00:01]实际歌词' } });
  });
  const routes = new Map();
  registerNeteaseMusicExpressRoutes({ get: (url, handler) => routes.set(url, handler), put() {}, post() {} });
  let result;
  await routes.get('/api/netease/lyric')({ query: { id: '123' } }, { json: value => { result = value; } });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /\/api\/song\/lyric\?/);
  assert.equal(result.yrc, '');
  assert.equal(parseLyricsPayload(result).rows[0].text, '实际歌词');
});
