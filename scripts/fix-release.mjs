/**
 * 发布后修正：保证指定版本的 GitHub Release 唯一、完整、且已正式发布。
 *
 * 为什么需要这一步：
 * electron-builder 对每个 target（nsis / portable）各起一个 publisher 并行干活，
 * 两路同时查不到新版本的 Release，就各自 create 一个 draft —— 于是同一个 tag
 * 底下会冒出两个 Release 对象，而且创建它们的 publisher 各自只 PATCH 了自己那
 * 一份，另一份永远停在 draft=true。
 * GitHub 的 /releases/latest 会跳过 draft，结果就是客户端检查更新时被告知
 * "已是最新"，一路回落到上一个正式版本 —— 更新链路看着通、实际是断的。
 *
 * 本脚本做的事：
 *   1. 找出该 tag 下的所有 Release，挑一个当主 Release（优先有 latest.yml 的）
 *   2. 把其余 Release 上缺失的资源搬到主 Release
 *   3. 删掉多余的 Release
 *   4. 把主 Release 的 draft 置为 false
 *   5. 校验 /releases/latest 确实指向本版本
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = { owner: 'hb1234567898', name: 'aimusic' };
const apiBase = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
const uploadBase = `https://uploads.github.com/repos/${repo.owner}/${repo.name}`;

function tokenFromEnv() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
}

/**
 * 本机没有配 GH_TOKEN 时，回落到 Git Credential Manager 里那份凭据。
 * 注意必须异步 spawn：Node 的 spawnSync 在 MSYS/Git-Bash 下会因为管道实现
 * 直接报 EBUSY，拿不到任何输出。
 */
function tokenFromGitCredential() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = spawn('git', ['credential', 'fill'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
      child.on('error', () => finish(''));
      child.on('close', () => finish(((out.match(/^password=(.*)$/m) || [])[1] || '').trim()));
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } finish(''); }, 25000);
      child.on('close', () => clearTimeout(timer));
      child.stdin.end('protocol=https\nhost=github.com\n\n');
    } catch {
      finish('');
    }
  });
}

const token = tokenFromEnv() || await tokenFromGitCredential();
if (!token) {
  console.error('缺少 GitHub 令牌：请设置 GH_TOKEN，或确保 git credential 里有 github.com 凭据');
  process.exit(1);
}

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const tag = `v${version}`;

const headers = {
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'orbit-music-release-fix',
};

async function api(pathname, init = {}) {
  const res = await fetch(`${apiBase}${pathname}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* 不是 JSON 就原样返回 */ }
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${pathname} -> ${res.status} ${text.slice(0, 300)}`);
  return body;
}

const all = await api('/releases?per_page=100');
const mine = all.filter(r => r.tag_name === tag);

console.log(`[fix-release] ${tag} 下的 Release 数量：${mine.length}`);
for (const r of mine) {
  console.log(`  id=${r.id} draft=${r.draft} assets=[${r.assets.map(a => a.name).join(', ')}]`);
}

if (mine.length === 0) {
  console.error(`${tag} 没有任何 Release，先跑 npm run release`);
  process.exit(1);
}

// 有 latest.yml 的才是客户端真正认的那份，优先留它
const primary = mine.find(r => r.assets.some(a => a.name === 'latest.yml'))
  || mine.slice().sort((a, b) => b.assets.length - a.assets.length)[0];
console.log(`[fix-release] 主 Release 选定 id=${primary.id}`);

const owned = new Set(primary.assets.map(a => a.name));

for (const dup of mine) {
  if (dup.id === primary.id) continue;

  for (const asset of dup.assets) {
    if (owned.has(asset.name)) {
      console.log(`  跳过 ${asset.name}（主 Release 已有）`);
      continue;
    }
    console.log(`  搬运 ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)}MB)`);
    const buf = Buffer.from(await (await fetch(asset.url, {
      headers: { ...headers, Accept: 'application/octet-stream' },
    })).arrayBuffer());
    const tmp = path.join(os.tmpdir(), `orbit-asset-${Date.now()}-${asset.name}`);
    writeFileSync(tmp, buf);
    try {
      await uploadReleaseAsset(primary.id, asset.name, tmp, asset.label || '');
      owned.add(asset.name);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  console.log(`  删除重复 Release id=${dup.id}`);
  await api(`/releases/${dup.id}`, { method: 'DELETE' });
}

if (primary.draft) {
  console.log(`[fix-release] 把主 Release id=${primary.id} 的 draft 置为 false`);
  await api(`/releases/${primary.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: false }),
  });
} else {
  console.log('[fix-release] 主 Release 已经是正式发布状态');
}

async function uploadReleaseAsset(releaseId, name, filePath, label) {
  const url = `${uploadBase}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}${label ? `&label=${encodeURIComponent(label)}` : ''}`;
  const size = statSync(filePath).size;
  const body = readFileSync(filePath);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'User-Agent': 'orbit-music-release-fix',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`上传 ${name} (${(size / 1024 / 1024).toFixed(1)}MB) 失败: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// 最后一道校验：客户端实际读的就是这个端点
const latest = await api('/releases/latest');
console.log(`[fix-release] /releases/latest -> ${latest.tag_name}`);
if (latest.tag_name !== tag) {
  console.error(`校验失败：/releases/latest 仍是 ${latest.tag_name}，客户端不会发现 ${tag}`);
  process.exit(1);
}
console.log(`[fix-release] 校验通过，资源清单：${latest.assets.map(a => a.name).join(', ')}`);
