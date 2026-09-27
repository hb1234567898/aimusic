import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8766/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('console', msg => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
page.on('pageerror', err => problems.push(`pageerror: ${err.message}`));

// 在应用模块执行前种一份 QQ 歌单：hydrateQQTracks 是模块顶层跑的，晚一步就补不上了
await page.addInitScript(() => {
  localStorage.setItem('orbit.qq.library.v2', JSON.stringify({
    version: 2,
    activeId: 'smoke',
    playlists: [{
      id: 'smoke',
      name: '冒烟歌单',
      cover: '', creator: '', sourceUrl: '', addedAt: Date.now(),
      songs: [
        { provider: 'qq', mid: 'AAAAAAAA', mediaMid: 'BBBBBBBB', title: '冒烟曲', artist: 'QA', album: 'QA', duration: 200, fee: 0 },
        { provider: 'qq', mid: 'CCCCCCCC', mediaMid: 'DDDDDDDD', title: '第二首', artist: 'QA', album: 'QA', duration: 180, fee: 0 },
      ],
    }],
  }));
  // QQ 歌曲是追加在本地 19 首之后的，把续播位置指到第一首 QQ 歌上，播放栏才会显示它的信息
  localStorage.setItem('aimusic.lastTrack', '19');
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

const before = await page.evaluate(() => ({
  qualityBtn: document.querySelector('.quality-btn')?.textContent?.trim() || null,
  firstSrc: document.querySelector('audio')?.getAttribute('src') || '',
}));
console.log('初始:', JSON.stringify(before));

// 打开音质菜单，逐个确认档位都在
await page.click('.quality-btn');
await page.waitForTimeout(250);
const options = await page.evaluate(() =>
  [...document.querySelectorAll('.quality-menu .output-item')].map(el => ({
    label: el.querySelector('strong')?.textContent, hint: el.querySelector('small')?.textContent, on: el.classList.contains('on'),
  })));
console.log('菜单:', JSON.stringify(options));

// 切到 320k
await page.click('.quality-menu .output-item:nth-of-type(3)');
await page.waitForTimeout(900);

const after = await page.evaluate(() => ({
  qualityBtn: document.querySelector('.quality-btn')?.textContent?.trim() || null,
  audioSrc: document.querySelector('audio')?.getAttribute('src') || '',
  stored: localStorage.getItem('aimusic.qqQuality'),
}));
console.log('切到极高后:', JSON.stringify(after));

await page.screenshot({ path: process.argv[3] || 'smoke-quality.png' });
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'no console errors');
await browser.close();
