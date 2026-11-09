// Keep provider text and timing together; never estimate timing from text length.
const TIME_TAGS = /^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\])+/;
const TIME_TAG = /\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g;
const ID_TAG = /^\[(ti|ar|al|by|au|offset|length|re|ve)\s*:\s*(.*?)\]\s*$/i;
const META_HEAD = /^(?:作词|作詞|作曲|编曲|編曲|制作人|製作人|制作|製作|监制|監製|混音|母带|母帶|录音|錄音|原唱|翻唱|和声|和聲|演唱|出品|词曲|词|詞|曲)\s*[:：]/;
const WORD_TAG = /<(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?>/g;
const timestampMs = tag => Number(tag[1]) * 60000 + Number(tag[2]) * 1000
  + Number((tag[3] || '').padEnd(3, '0'));

function parseWordCues(source, lineMs) {
  const tags = [...source.matchAll(WORD_TAG)];
  if (!tags.length) return { text: source, words: null };
  const text = source.replace(WORD_TAG, '');
  const times = tags.map(timestampMs);
  // Bad word times must not be repaired by estimating a different timeline.
  if (times.some((time, index) => time < lineMs || (index && time < times[index - 1]))) {
    return { text, words: null };
  }
  const words = [];
  const prefix = source.slice(0, tags[0].index);
  if (prefix) words.push({ text: prefix, start: null, end: null });
  tags.forEach((tag, index) => {
    const content = source.slice(tag.index + tag[0].length, tags[index + 1]?.index ?? source.length);
    if (content) words.push({ text: content, start: times[index] / 1000, end: times[index + 1] === undefined ? null : times[index + 1] / 1000 });
  });
  return { text, words: words.length ? words : null };
}

export function lrcWordProgress(word, time) {
  if (word.start === null || time < word.start) return 0;
  // With no supplied end time, switch at the supplied onset rather than invent
  // a duration from the remaining characters or the next line.
  if (word.end === null || word.end <= word.start) return 1;
  return Math.min(1, Math.max(0, (time - word.start) / (word.end - word.start)));
}

export function parseLrc(source) {
  const entries = [];
  const meta = {};
  if (typeof source !== 'string') return { rows: [], meta };
  source.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).forEach(rawLine => {
    const line = rawLine.trim();
    const id = line.match(ID_TAG);
    if (id) {
      meta[id[1].toLowerCase()] = id[2];
      return;
    }
    const prefix = line.match(TIME_TAGS)?.[0];
    if (!prefix) return;
    const content = line.slice(prefix.length).trim();
    if (/^\[\d/.test(content)) return;
    const tags = [...prefix.matchAll(TIME_TAG)];
    for (const tag of tags) {
      const ms = timestampMs(tag);
      const parsed = parseWordCues(content, ms);
      // Multiple line tags with absolute word cues are ambiguous. Keep the
      // supplied plain text for repeats rather than shift the word timestamps.
      entries.push({ ms, text: parsed.text, words: tags.length === 1 ? parsed.words : null });
    }
  });
  // Positive LRC offset advances the text. The tag may occur after the lyrics.
  const offset = /^[+-]?\d+$/.test(meta.offset || '') ? Number(meta.offset) : 0;
  const groups = new Map();
  entries.forEach(({ ms, text, words }) => {
    const timeMs = ms - offset;
    if (!groups.has(timeMs)) groups.set(timeMs, []);
    const lines = groups.get(timeMs);
    if (text && !lines.some(line => line.text === text)) lines.push({ text, words: words?.map(word => ({
      ...word,
      start: word.start === null ? null : word.start - offset / 1000,
      end: word.end === null ? null : word.end - offset / 1000,
    })) || null });
  });
  const rows = [...groups].sort(([a], [b]) => a - b).map(([ms, lines]) => ({
    time: ms / 1000,
    text: lines[0]?.text || '',
    lines: lines.map(line => line.text),
    wordLines: lines.map(line => line.words),
    translations: [],
    meta: lines.length > 0 && lines.every(line => META_HEAD.test(line.text)),
  }));
  return { rows, meta };
}

const xmlText = value => value.replace(/&(#x[\da-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (entity, code) => {
  if (code[0] === '#') {
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  }
  return ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[code.toLowerCase()];
});

export function parseNativeLyrics(source, format) {
  if (typeof source !== 'string' || !['qrc', 'yrc'].includes(format)) return { rows: [], meta: {} };
  const body = source.includes('LyricContent')
    ? xmlText(source.match(/LyricContent\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] || '') : source;
  const meta = parseLrc(body).meta;
  const offset = /^[+-]?\d+$/.test(meta.offset || '') ? Number(meta.offset) / 1000 : 0;
  const grouped = new Map();
  body.split(/\r\n|\n|\r/).forEach(line => {
    const head = line.match(/^\s*\[(\d+),(\d+)\]/);
    if (!head) return;
    const start = Number(head[1]) / 1000 - offset;
    const content = line.slice(head[0].length);
    const pattern = format === 'qrc' ? /\((\d+),(\d+)\)/g : /\((\d+),(\d+),\d+\)/g;
    const tags = [...content.matchAll(pattern)];
    const words = [];
    if (format === 'yrc' && tags[0]?.index > 0) {
      words.push({ text: content.slice(0, tags[0].index), start: null, end: null });
    }
    tags.forEach((tag, index) => {
      const text = format === 'qrc'
        ? content.slice(index ? tags[index - 1].index + tags[index - 1][0].length : 0, tag.index)
        : content.slice(tag.index + tag[0].length, tags[index + 1]?.index ?? content.length);
      if (!text) return;
      const time = Number(tag[1]) / 1000 - offset;
      words.push({ text, start: time, end: time + Number(tag[2]) / 1000 });
    });
    if (format === 'qrc' && tags.length) {
      const last = tags[tags.length - 1];
      const suffix = content.slice(last.index + last[0].length);
      if (suffix) words.push({ text: suffix, start: null, end: null });
    }
    const text = content.replace(pattern, '');
    const timed = words.filter(word => word.start !== null);
    const valid = timed.length > 0 && timed.every((word, index) => Number.isFinite(word.end)
      && word.start >= start && (!index || word.start >= timed[index - 1].start));
    if (!grouped.has(start)) grouped.set(start, []);
    const lines = grouped.get(start);
    if (text && !lines.some(item => item.text === text)) lines.push({ text, words: valid ? words : null });
  });
  const rows = [...grouped].sort(([a], [b]) => a - b).map(([time, lines]) => ({
    time, text: lines[0]?.text || '', lines: lines.map(line => line.text),
    wordLines: lines.map(line => line.words), translations: [],
    meta: lines.length > 0 && lines.every(line => META_HEAD.test(line.text)),
  }));
  return { rows, meta, format };
}

export function parseLyricsPayload(payload) {
  if (typeof payload === 'string') return parseLrc(payload);
  const plain = parseLrc(payload?.lyric);
  const native = payload?.provider === 'qq' ? parseNativeLyrics(payload.qrc, 'qrc')
    : payload?.provider === 'netease' ? parseNativeLyrics(payload.yrc, 'yrc') : null;
  const hasNativeWords = native?.rows.some(row => row.wordLines.some(Boolean));
  const original = hasNativeWords ? native : plain;
  const translation = parseLrc(hasNativeWords && payload?.provider === 'netease'
    ? payload.ytlyric : payload?.tlyric);
  const translatedAt = new Map(translation.rows.map(row => [Math.round(row.time * 1000), row.lines]));
  // Match exact LRC times; never guess by array position or nearby sentences.
  original.rows.forEach(row => {
    if (!row.lines.length) return;
    row.translations = (translatedAt.get(Math.round(row.time * 1000)) || [])
      .filter(text => !row.lines.includes(text));
  });
  return original;
}

export function findLrcIndex(rows, time) {
  let low = 0;
  let high = rows.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].time <= time) {
      result = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return result;
}

const cache = new Map();
export function invalidateLrc(url) {
  cache.delete(url);
}
export function ensureLrc(url) {
  if (!url) return Promise.resolve({ rows: [], meta: {} });
  const existing = cache.get(url);
  if (existing) return existing;
  const request = fetch(url, { cache: 'no-store' })
    .then(async response => {
      if (!response.ok) throw new Error(`Lyrics ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      return contentType.includes('application/json') ? response.json() : response.text();
    })
    .then(payload => ({ ...parseLyricsPayload(payload), url }))
    .catch(error => {
      if (cache.get(url) === request) cache.delete(url);
      throw error;
    });
  cache.set(url, request);
  return request;
}

export function prefetchLrc(url) {
  if (url) ensureLrc(url).catch(() => {});
}

export function waitForLrc(url, timeout = 2600) {
  if (!url) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    ensureLrc(url).then(finish, () => finish(null));
  });
}
