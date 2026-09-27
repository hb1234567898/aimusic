import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const OWNER = 'hb1234567898';
const REPO = 'aimusic';
const MIRROR_PREFIXES = [
  'https://gh-proxy.com/',
  'https://gh-proxy.org/',
  'https://ghfast.top/',
];

function installerFile(updateInfo) {
  const files = Array.isArray(updateInfo?.files) ? updateInfo.files : [];
  return files.find(file => /\.exe(?:$|\?)/i.test(String(file?.url || '')))
    || files.find(file => file?.url && file?.sha512)
    || null;
}

function safeFileName(rawUrl, version) {
  try {
    const name = decodeURIComponent(new URL(String(rawUrl)).pathname.split('/').pop() || '');
    if (name && name === path.basename(name) && /\.exe$/i.test(name)) return name;
  } catch { /* use the stable release filename below */ }
  return `ORBIT-Music-Setup-${version}.exe`;
}

export function buildUpdateCandidates(updateInfo, preferMirrors = false) {
  const file = installerFile(updateInfo);
  if (!file?.sha512 || !updateInfo?.version) throw new Error('更新清单缺少安装包校验信息');
  const fileName = safeFileName(file.url, updateInfo.version);
  const official = `https://github.com/${OWNER}/${REPO}/releases/download/v${encodeURIComponent(updateInfo.version)}/${encodeURIComponent(fileName)}`;
  const mirrors = MIRROR_PREFIXES.map(prefix => `${prefix}${official}`);
  return {
    file,
    fileName,
    expectedSha512: file.sha512,
    urls: preferMirrors ? [...mirrors, official] : [official, ...mirrors],
  };
}

async function fileSha512(filePath) {
  const handle = await open(filePath, 'r');
  const hash = createHash('sha512');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('base64');
  } finally { await handle.close(); }
}

async function downloadOne(url, partialPath, expectedSha512, expectedSize, onProgress) {
  const controller = new AbortController();
  let idleTimer = null;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('更新线路 25 秒没有收到数据')), 25000);
  };
  touch();
  let response;
  try {
    response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'ORBIT-Music-Updater' } });
  } catch (error) {
    clearTimeout(idleTimer);
    throw error;
  }
  if (!response.ok || !response.body) {
    clearTimeout(idleTimer);
    throw new Error(`更新线路返回 ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || Number(expectedSize) || 0;
  const hash = createHash('sha512');
  const reader = response.body.getReader();
  const handle = await open(partialPath, 'w');
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      const chunk = Buffer.from(value);
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
      received += chunk.length;
      onProgress(total > 0 ? Math.min(99, Math.round(received / total * 100)) : 0, received, total);
    }
  } finally {
    clearTimeout(idleTimer);
    await handle.close();
  }
  const actual = hash.digest('base64');
  if (actual !== expectedSha512) throw new Error('更新文件校验失败');
}

export async function downloadVerifiedUpdate({ updateInfo, destinationDir, preferMirrors = false, onProgress = () => {} }) {
  const { file, fileName, expectedSha512, urls } = buildUpdateCandidates(updateInfo, preferMirrors);
  await mkdir(destinationDir, { recursive: true });
  const targetPath = path.join(destinationDir, fileName);
  const partialPath = `${targetPath}.part`;

  try {
    if ((await stat(targetPath)).isFile() && await fileSha512(targetPath) === expectedSha512) {
      onProgress(100, Number(file.size) || 0, Number(file.size) || 0);
      return { path: targetPath, source: 'cache' };
    }
  } catch { /* cache miss */ }

  const errors = [];
  for (const url of urls) {
    await rm(partialPath, { force: true }).catch(() => {});
    try {
      await downloadOne(url, partialPath, expectedSha512, file.size, onProgress);
      await rm(targetPath, { force: true }).catch(() => {});
      await rename(partialPath, targetPath);
      onProgress(100, Number(file.size) || 0, Number(file.size) || 0);
      return { path: targetPath, source: url.startsWith('https://github.com/') ? 'github' : 'mirror' };
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  await rm(partialPath, { force: true }).catch(() => {});
  throw new Error(`所有更新线路均失败：${errors.join('；')}`);
}
