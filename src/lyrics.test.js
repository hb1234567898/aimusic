import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureLrc, findLrcIndex, invalidateLrc, lrcWordProgress, parseLrc, parseLyricsPayload, parseNativeLyrics } from './lyrics.js';

test('LRC preserves timestamped content, including credits and bracketed text', () => {
  const source = '\uFEFF[ti:文件标题]\r\n非歌词提示\r\n[00:00.000]作词：甲 作曲：乙\r\n[00:01.5]文件标题\r\n[00:02.00][Chorus]\r\n[00:03.123]原句  保留空格';
  const { rows, meta } = parseLrc(source);
  assert.equal(meta.ti, '文件标题');
  assert.deepEqual(rows.map(row => [row.time, row.lines]), [
    [0, ['作词：甲 作曲：乙']], [1.5, ['文件标题']], [2, ['[Chorus]']], [3.123, ['原句  保留空格']],
  ]);
});

test('multiple timestamps expand repeated verses; unordered and equal cues form ordered groups', () => {
  const { rows } = parseLrc('[00:20.00][00:10.000]重复句\n[00:10.0]同时间第二行\n[00:10.00]重复句');
  assert.deepEqual(rows.map(row => [row.time, row.lines]), [
    [10, ['重复句', '同时间第二行']], [20, ['重复句']],
  ]);
});

test('positive and negative offset tags apply to every cue, even at the end of LRC', () => {
  assert.deepEqual(parseLrc('[00:00]开头\n[00:10]下一句\n[offset:+500]').rows.map(row => row.time), [-0.5, 9.5]);
  assert.equal(parseLrc('[offset:-250]\n[00:01]下一句').rows[0].time, 1.25);
  assert.equal(parseLrc('[offset:bad]\n[00:01]下一句').rows[0].time, 1);
});

test('blank timed cues clear lyrics and a future first cue stays inactive', () => {
  const { rows } = parseLrc('[00:05]第一句\n[00:08]\n[00:12]下一句');
  assert.equal(findLrcIndex(rows, 0), -1);
  assert.equal(findLrcIndex(rows, 5), 0);
  assert.equal(findLrcIndex(rows, 10), 1);
  assert.deepEqual(rows[1].lines, []);
  assert.equal(findLrcIndex(rows, 12), 2);
  assert.equal(findLrcIndex(rows, 6), 0); // seeking backwards
  assert.equal(findLrcIndex([], 100), -1);
});

test('original and translated LRC align by exact corrected timestamp, never by position', () => {
  const result = parseLyricsPayload({
    lyric: '[00:10]Original A\n[00:20]Original B\n[00:30]Original C',
    tlyric: '[offset:500]\n[00:20.5]译文乙\n[00:10.500]译文甲\n[00:29.500]时间不对应的译文',
  });
  assert.deepEqual(result.rows.map(row => [row.text, row.translations]), [
    ['Original A', ['译文甲']], ['Original B', ['译文乙']], ['Original C', []],
  ]);
});

test('plain text, QRC and translated-only payloads cannot replace missing original LRC', () => {
  for (const payload of [
    '无时间轴纯文本', '<html>错误页面</html>', '[00:99]无效时间',
    { lyric: '无时间轴', tlyric: '[00:01]译文' },
    { qrc: '[1000,3000]逐字歌词', roma: '[00:01]拼音' }, null,
  ]) assert.deepEqual(parseLyricsPayload(payload).rows, []);
  assert.deepEqual(parseLyricsPayload({ lyric: '[00:01]原文', tlyric: '没有时间轴的翻译' }).rows[0].translations, []);
});

test('loader consumes separate LRC fields and retries a failed request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) return new Response('unavailable', { status: 502 });
    return Response.json({ lyric: '[00:01]Original', tlyric: '[00:01]译文', qrc: 'ignored' });
  });
  const url = '/test/lyrics/retry.lrc';
  await assert.rejects(ensureLrc(url), /502/);
  const loaded = await ensureLrc(url);
  assert.deepEqual(loaded.rows[0].translations, ['译文']);
  assert.equal(await ensureLrc(url), loaded);
  assert.equal(calls, 2);
  assert.deepEqual((await ensureLrc(null)).rows, []);
});

test('enhanced LRC keeps exact text and supplied word boundaries with offset applied', () => {
  const { rows } = parseLrc('[00:10.00]<00:10.00>你<00:10.50>好 世界<00:12.00>\n[offset:250]');
  assert.deepEqual(rows[0].lines, ['你好 世界']);
  assert.equal(rows[0].time, 9.75);
  assert.deepEqual(rows[0].wordLines[0], [
    { text: '你', start: 9.75, end: 10.25 },
    { text: '好 世界', start: 10.25, end: 11.75 },
  ]);
  const words = rows[0].wordLines[0];
  assert.equal(lrcWordProgress(words[0], 9.5), 0);
  assert.equal(lrcWordProgress(words[0], 10), 0.5);
  assert.equal(lrcWordProgress(words[0], 10.5), 1);
  assert.equal(lrcWordProgress(words[1], 10.5), 1 / 6);
  assert.equal(lrcWordProgress(words[0], 9), 0); // seek backwards resets the fill
});

test('ordinary LRC never receives estimated per-character timing', () => {
  const { rows } = parseLrc('[00:10]普通歌词\n[00:20]下一句');
  assert.deepEqual(rows.map(row => row.wordLines), [[null], [null]]);
});

test('untimed prefixes and a missing final end cue are not assigned invented durations', () => {
  const { rows } = parseLrc('[00:10]前缀 <00:10.50>word<00:11.00>最后');
  assert.equal(rows[0].lines[0], '前缀 word最后');
  const words = rows[0].wordLines[0];
  assert.deepEqual(words[0], { text: '前缀 ', start: null, end: null });
  assert.equal(lrcWordProgress(words[0], 20), 0);
  assert.deepEqual(words[2], { text: '最后', start: 11, end: null });
  assert.equal(lrcWordProgress(words[2], 10.9), 0);
  assert.equal(lrcWordProgress(words[2], 11), 1);
});

test('invalid or ambiguous word times fall back to intact plain lyrics', () => {
  for (const source of [
    '[00:10]<00:10.5>你<00:10.2>好',
    '[00:10]<00:09>你<00:11>好',
    '[00:10][00:20]<00:10>你<00:11>好',
  ]) {
    const { rows } = parseLrc(source);
    assert.ok(rows.every(row => row.lines[0] === '你好' && row.wordLines[0] === null));
  }
});

test('equal-time lines retain their own word tracks; translation does not overwrite them', () => {
  const { rows } = parseLyricsPayload({
    lyric: '[00:10]<00:10>你<00:11>好<00:12>\n[00:10]另一条原文',
    tlyric: '[00:10]翻译',
  });
  assert.deepEqual(rows[0].lines, ['你好', '另一条原文']);
  assert.equal(rows[0].wordLines[0].length, 2);
  assert.equal(rows[0].wordLines[1], null);
  assert.deepEqual(rows[0].translations, ['翻译']);
});

test('QRC XML preserves entity-escaped words, their absolute start and explicit durations', () => {
  const { rows } = parseNativeLyrics('<QrcInfos><Lyric_1 LyricContent="[1000,2000]你(1000,500)&quot; &amp; 好(1700,600)" /></QrcInfos>', 'qrc');
  assert.deepEqual(rows[0].lines, ['你" & 好']);
  assert.deepEqual(rows[0].wordLines[0], [
    { text: '你', start: 1, end: 1.5 }, { text: '" & 好', start: 1.7, end: 2.3 },
  ]);
  assert.equal(lrcWordProgress(rows[0].wordLines[0][0], 1.25), 0.5);
  assert.equal(lrcWordProgress(rows[0].wordLines[0][1], 1.6), 0);
});

test('YRC ignores JSON credits and uses the provider word text and timing', () => {
  const { rows } = parseNativeLyrics('{"t":0,"c":[{"tx":"作词：测试"}]}\n[1000,2000](1000,500,0)你(1700,600,0)好', 'yrc');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '你好');
  assert.deepEqual(rows[0].wordLines[0], [{ text: '你', start: 1, end: 1.5 }, { text: '好', start: 1.7, end: 2.3 }]);
});

test('provider word lyrics are preferred and invalid word data falls back to that song LRC', () => {
  for (const provider of ['qq', 'netease']) {
    const payload = { provider, lyric: '[00:01]普通歌词', qrc: '[1000,1000]逐(1000,500)字(1500,500)', yrc: '[1000,1000](1000,500,0)逐(1500,500,0)字' };
    assert.equal(parseLyricsPayload(payload).rows[0].text, '逐字');
    payload.qrc = payload.yrc = 'invalid';
    assert.equal(parseLyricsPayload(payload).rows[0].text, '普通歌词');
    assert.equal(parseLyricsPayload(payload).rows[0].wordLines[0], null);
  }
});

test('login refresh invalidates a pre-login line-only cache and loads actual word lyrics', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ provider: 'netease',
    lyric: '[00:01]测试', yrc: ++calls > 1 ? '[1000,1000](1000,500,0)测(1500,500,0)试' : '',
  }));
  const url = '/test/login-refresh';
  assert.equal((await ensureLrc(url)).rows[0].wordLines[0], null);
  invalidateLrc(url);
  assert.equal((await ensureLrc(url)).rows[0].wordLines[0].length, 2);
  assert.equal(calls, 2);
});
