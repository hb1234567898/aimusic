import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8766/';
const shot = process.argv[3] || 'smoke-desktop.png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('console', msg => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
page.on('pageerror', err => problems.push(`pageerror: ${err.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const summary = await page.evaluate(() => ({
  cards: document.querySelectorAll('.card').length,
  player: Boolean(document.querySelector('.player')),
  rightButtons: [...document.querySelectorAll('.player-right button')].map(b => b.getAttribute('aria-label') || b.textContent.trim()),
  qualityBtn: document.querySelector('.quality-btn')?.textContent?.trim() || null,
}));
console.log(JSON.stringify(summary, null, 2));

await page.screenshot({ path: shot });
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'no console errors');
await browser.close();
