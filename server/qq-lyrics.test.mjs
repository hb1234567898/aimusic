import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeQQCloudLyrics } from './qq-lyrics-codec.mjs';
import { handleQQLyric } from './qq-music.mjs';
import { parseLyricsPayload } from '../src/lyrics.js';

const encrypted = '1eaa9479b9b1b2f51fee5bd28fff33d0a24b4dabf4ff509280772c96bc9333603de10772bc0ab03b61a152d73323b6d167ba26d3f85092fc';
const qrc = '[ti:Test]\n[1000,1200]测(1000,500)试(1500,700)';

test('QQ cloud decoder handles a fixed encrypted UTF-8 QRC vector', () => {
  assert.equal(decodeQQCloudLyrics(encrypted), qrc);
  assert.equal(decodeQQCloudLyrics(qrc), qrc);
  assert.throws(() => decodeQQCloudLyrics('deadbeef'), /Invalid/);
  assert.throws(() => decodeQQCloudLyrics('0'.repeat(32)));
});

test('QQ requests line and word lyrics for the same MID with the active account cookie', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    request = options;
    return Response.json({ code: 0,
      lyric: { code: 0, data: { lyric: Buffer.from('[00:01]测试').toString('base64'), trans: '' } },
      wordLyric: { code: 0, data: { qrc: 1, lyric: encrypted } },
    });
  });
  const payload = await handleQQLyric('test-mid', '123', 'uin=123; qm_keyst=test-only');
  const body = JSON.parse(request.body);
  assert.equal(body.lyric.param.songMid, 'test-mid');
  assert.equal(body.wordLyric.param.songMid, 'test-mid');
  assert.equal(body.lyric.param.qrc, 0);
  assert.equal(body.wordLyric.param.qrc, 1);
  assert.equal(request.headers.Cookie, 'uin=123; qm_keyst=test-only');
  assert.equal(payload.lyric, '[00:01]测试');
  assert.equal(payload.qrc, qrc);
  assert.deepEqual(parseLyricsPayload(payload).rows[0].wordLines[0], [
    { text: '测', start: 1, end: 1.5 }, { text: '试', start: 1.5, end: 2.2 },
  ]);
});

test('QQ numeric IDs work and a broken word response retains the actual line lyrics', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.wordLyric.param.songId, 123);
    return Response.json({ lyric: { data: { lyric: '[00:01]实际歌词' } }, wordLyric: { data: { lyric: 'deadbeef' } } });
  });
  const payload = await handleQQLyric('', '123');
  assert.equal(payload.qrc, '');
  assert.equal(parseLyricsPayload(payload).rows[0].wordLines[0], null);
  assert.equal(parseLyricsPayload(payload).rows[0].text, '实际歌词');
});
