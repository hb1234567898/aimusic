// LRC 解析 + 带缓存的加载器。
// 播放前会先等歌词落地，所以这里必须保证同一个地址只发一次请求，
// 并且失败后允许重试（失败的请求不留在缓存里）。

const TIME_TAG = /^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/;
const ID_TAG = /^\s*\[(ti|ar|al|by|au|offset)\s*:\s*(.*?)\]\s*$/i;
// [Verse 1]、[Chorus] 这类分段标记不算歌词
const SECTION_MARK = /^\s*[\[［(（].*[\]］)）]\s*$/;
// 作词 / 作曲 / 编曲 / Cover / Remix …这些行照样排在歌词里按时间滚，
// 只是打个标记，渲染时给个更轻的样式（Windows /Players 之外的信息）
const META_HEAD = /(^|[\s　(（\[])(作词|作詞|作曲|编曲|編曲|制作人|製作人|制作|製作|监制|監製|混音|母带|母帶|录音|錄音|原唱|翻唱|原曲|二创|二創|封面|中文翻译|中文翻譯|和声|和聲|吉他|贝斯|貝斯|演唱|策划|出品|企划|统筹|歌词|词曲|词|詞|曲)\s*[:：\-－]/;
const META_ANY = /(cover|remix|ost|feat\.?|version|instrumental|原名|原曲|主题曲|总决赛|伴奏|纯音乐|翻译)/i;

const isMetaLine = text => META_HEAD.test(text) || (text.length <= 60 && META_ANY.test(text));

// 一行里挤了好几个创作信息时拆开各占一行，例如
// 「原唱-NewJeans 翻唱-noli 混音-姜艾芙」→ 三条独立的小行，
// 否则在手机上必然被截断成一串看不清的省略内容。
const META_LABEL = /(?:^|[\s　])((?:(?:作词|作詞|作曲|编曲|編曲|制作人|製作人|制作|製作|监制|監製|混音|母带|母帶|录音|錄音|原唱|翻唱|原曲|封面|中文翻译|中文翻譯|和声|和聲|吉他|贝斯|貝斯|演唱|策划|出品|企划|统筹|歌词|词曲|词|詞|曲)\s*[:：\-－]))/g;

function splitMetaRow(text) {
  const starts = [];
  META_LABEL.lastIndex = 0;
  let found = META_LABEL.exec(text);
  while (found) {
    starts.push(found.index);
    // 防止零宽匹配把循环卡死
    if (found.index === META_LABEL.lastIndex) META_LABEL.lastIndex += 1;
    found = META_LABEL.exec(text);
  }
  if (starts.length < 2) return null;
  if (starts[0] > 0) starts[0] = 0; // 前缀信息并入第一段，别丢内容
  const parts = starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length).trim()).filter(Boolean);
  return parts.length >= 2 ? parts : null;
}

export function parseLrc(source) {
  const rows = [];
  const meta = {};

  (source || '').split(/\r?\n/).forEach(line => {
    const idTag = line.match(ID_TAG);
    if (idTag) {
      meta[idTag[1].toLowerCase()] = idTag[2].trim();
      return;
    }
    const match = line.match(TIME_TAG);
    if (!match) return;

    const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
    const time = Number(match[1]) * 60 + Number(match[2]) + fraction;
    const text = match[4].trim();
    // 空行直接丢掉：歌词首行永远要是真内容
    if (!text) return;
    if (SECTION_MARK.test(text)) return;

    const parts = isMetaLine(text) ? splitMetaRow(text) : null;
    if (parts) {
      // 同一时间点的几行依次排开，写给 MTV 式的逐条浮现留出极小的间隔
      parts.forEach((part, index) => rows.push({ time: time + index * 0.001, text: part, meta: true }));
      return;
    }
    rows.push({ time, text, meta: isMetaLine(text) });
  });

  return { rows, meta };
}

const flattenForCompare = text => String(text || '').toLowerCase()
  .replace(/[\s　,.，。!！?？、\-—_~～/()（）\[\]【】《》'":：]/g, '');

// QQ 音乐的歌词开头经常带一行「歌名」或「歌名 - 歌手」，面板顶部已经有标题了，
// 再显示一遍就是重复。只在开头那段"头部区"（meta 行或 3 秒内）里摘掉它，
// 碰到第一句正常歌词就停手——否则副歌里恰好等于歌名的整句唱词会被误删。
export function stripTitleEcho(rows, title, artist) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const titleKey = flattenForCompare(title);
  if (!titleKey) return rows;
  const artistKey = flattenForCompare(artist);
  const out = rows.slice();
  let index = 0;
  while (index < out.length) {
    const row = out[index];
    if (!row.meta && row.time > 3) break;
    const key = flattenForCompare(row.text);
    if (key === titleKey
      || (artistKey && (key === titleKey + artistKey || key === artistKey + titleKey))) {
      out.splice(index, 1);
      continue;
    }
    index += 1;
  }
  return out;
}

const cache = new Map();

export function ensureLrc(url) {
  if (!url) return Promise.resolve(null);
  const existing = cache.get(url);
  if (existing) return existing;

  const request = fetch(url, { cache: 'no-store' })
    .then(async response => {
      if (!response.ok) throw new Error(`Local lyrics ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const payload = await response.json();
        return payload.lyric || payload.tlyric || '';
      }
      return response.text();
    })
    .then(text => {
      const parsed = parseLrc(text);
      parsed.url = url;
      return parsed;
    })
    .catch(error => {
      // 网络失败不留在缓存里，下次点播放可以重试
      cache.delete(url);
      throw error;
    });

  cache.set(url, request);
  return request;
}

export function prefetchLrc(url) {
  if (!url) return;
  ensureLrc(url).catch(() => { /* 预取失败不影响播放 */ });
}

// 最多等 timeout 毫秒，歌词再慢也不能把播放卡死
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
