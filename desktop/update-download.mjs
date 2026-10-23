import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const OWNER = 'hb1234567898';
const REPO = 'aimusic';
const MIRROR_PREFIXES = [
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
  'https://gh-proxy.org/',
];
const LATEST_MANIFEST_URL = `https://github.com/${OWNER}/${REPO}/releases/latest/download/latest.yml`;

export function createVersionedTaskQueue() {
  let activeVersion = '';
  let activePromise = null;
  const run = (version, isCurrent, start) => {
    if (activePromise) {
      if (activeVersion === version) return activePromise;
      return activePromise.catch(() => {}).then(() => (
        isCurrent(version) ? run(version, isCurrent, start) : { superseded: true }
      ));
    }
    activeVersion = version;
    let tracked;
    tracked = Promise.resolve().then(start).finally(() => {
      if (activePromise === tracked) {
        activePromise = null;
        activeVersion = '';
      }
    });
    activePromise = tracked;
    return tracked;
  };
  return { run };
}

function stripYamlScalar(value) {
  const text = String(value || '').trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseUpdateManifest(source) {
  const text = String(source || '');
  const version = stripYamlScalar(text.match(/^version:\s*(.+)$/m)?.[1]);
  const url = stripYamlScalar(text.match(/^\s*-\s+url:\s*(.+)$/m)?.[1]);
  const sha512 = stripYamlScalar(text.match(/^\s+sha512:\s*(.+)$/m)?.[1]);
  const sizeValue = stripYamlScalar(text.match(/^\s+size:\s*(.+)$/m)?.[1]);
  const releaseDate = stripYamlScalar(text.match(/^releaseDate:\s*(.+)$/m)?.[1]);
  const size = Number(sizeValue);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('更新清单版本号无效');
  if (!url || !/^[^/\\]+\.exe$/i.test(url)) throw new Error('更新清单安装包名称无效');
  const decodedHash = /^[A-Za-z0-9+/]+={0,2}$/.test(sha512) ? Buffer.from(sha512, 'base64') : Buffer.alloc(0);
  if (decodedHash.length !== 64 || decodedHash.toString('base64') !== sha512) throw new Error('更新清单校验值无效');
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('更新清单文件大小无效');
  return {
    version,
    files: [{ url, sha512, size }],
    path: url,
    sha512,
    releaseDate,
  };
}

export function compareVersions(left, right) {
  const parts = value => String(value || '').split(/[+-]/, 1)[0].split('.').map(part => Number(part) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

export function buildManifestCandidates(preferMirrors = false) {
  const mirrors = MIRROR_PREFIXES.map(prefix => `${prefix}${LATEST_MANIFEST_URL}`);
  return preferMirrors ? [...mirrors, LATEST_MANIFEST_URL] : [LATEST_MANIFEST_URL, ...mirrors];
}

async function fetchManifest(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('更新线路连接超时')), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'ORBIT-Music-Updater', Accept: 'text/yaml,text/plain,*/*' },
    });
    if (!response.ok) throw new Error(`更新线路返回 ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length')) || 0;
    if (declaredLength > 64 * 1024) throw new Error('更新清单异常过大');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('更新清单异常过大');
    return parseUpdateManifest(text);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForVerifiedUpdate({ currentVersion, preferMirrors = false, timeoutMs = 12000 }) {
  const errors = [];
  for (const url of buildManifestCandidates(preferMirrors)) {
    try {
      const info = await fetchManifest(url, timeoutMs);
      return {
        available: compareVersions(info.version, currentVersion) > 0,
        info,
        source: url === LATEST_MANIFEST_URL ? 'github' : 'mirror',
      };
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  throw new Error(`所有更新检查线路均失败：${errors.join('；')}`);
}

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

function progressPercent(received, total) {
  return total > 0 ? Math.min(99, Math.round(received / total * 100)) : 0;
}

async function partialSize(partialPath, expectedSize) {
  try {
    const entry = await stat(partialPath);
    if (!entry.isFile()) return 0;
    if (expectedSize > 0 && entry.size > expectedSize) {
      await rm(partialPath, { force: true });
      return 0;
    }
    return entry.size;
  } catch { return 0; }
}

function parseContentRange(value) {
  const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (total && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total };
}

function parseUnsatisfiedRange(value) {
  const match = String(value || '').match(/^bytes\s+\*\/(\d+)$/i);
  const total = Number(match?.[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

async function downloadAttempt({
  url, partialPath, expectedSha512, expectedSize, onProgress, fetchImpl, idleTimeoutMs,
}) {
  let offset = await partialSize(partialPath, expectedSize);
  if (expectedSize > 0 && offset === expectedSize) {
    if (await fileSha512(partialPath) === expectedSha512) {
      onProgress(100, offset, expectedSize);
      return { received: offset, resumed: offset > 0 };
    }
    await rm(partialPath, { force: true });
    offset = 0;
  }
  onProgress(progressPercent(offset, expectedSize), offset, expectedSize);

  const controller = new AbortController();
  let idleTimer = null;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error(`更新线路 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到数据`)),
      idleTimeoutMs,
    );
  };
  const headers = {
    'User-Agent': 'ORBIT-Music-Updater',
    Accept: 'application/octet-stream',
    'Accept-Encoding': 'identity',
  };
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  touch();
  let response;
  let resumed = false;
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers });
    if (String(url).startsWith('https://') && String(response.url || url).startsWith('http://')) {
      throw new Error('更新线路发生了不安全的 HTTP 降级');
    }
    if (response.status === 416 && offset > 0) {
      const remoteTotal = parseUnsatisfiedRange(response.headers.get('content-range'));
      if (remoteTotal === expectedSize && offset === expectedSize
          && await fileSha512(partialPath) === expectedSha512) {
        onProgress(100, offset, expectedSize);
        return { received: offset, resumed: true };
      }
      // 此线路拒绝当前断点，下一次同线路请求必须不带 Range，避免永久卡在 416。
      await rm(partialPath, { force: true }).catch(() => {});
      throw new Error(remoteTotal && remoteTotal !== expectedSize
        ? '更新线路的文件总大小与清单不一致，已清空分片'
        : '更新线路拒绝当前断点，已清空分片并准备完整重试');
    }
    if (!response.ok || !response.body) throw new Error(`更新线路返回 ${response.status}`);

    let writeOffset = 0;
    let expectedResponseBytes = 0;
    let total = Number(expectedSize) || 0;
    const declaredLength = Number(response.headers.get('content-length')) || 0;
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get('content-range'));
      if (!range || range.start !== offset) throw new Error('更新线路返回了无效的断点范围');
      if (total && range.total !== total) throw new Error('更新线路返回的文件大小与清单不一致');
      if (declaredLength && declaredLength !== range.end - range.start + 1) {
        throw new Error('更新线路返回的分片长度无效');
      }
      total ||= range.total;
      writeOffset = offset;
      expectedResponseBytes = range.end - range.start + 1;
      resumed = offset > 0;
    } else if (response.status === 200) {
      // 有些镜像忽略 Range。此时响应是完整文件，只能安全地从头覆盖，不能接在旧分片后面。
      if (total && declaredLength && declaredLength !== total) {
        throw new Error('更新线路返回的完整文件大小与清单不一致');
      }
      writeOffset = 0;
      expectedResponseBytes = declaredLength || total;
    } else {
      throw new Error(`更新线路不支持断点续传（${response.status}）`);
    }

    if (!total && declaredLength) total = writeOffset + declaredLength;
    const reader = response.body.getReader();
    const handle = await open(partialPath, writeOffset > 0 ? 'a' : 'w');
    let received = writeOffset;
    let responseBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        const chunk = Buffer.from(value);
        let chunkOffset = 0;
        while (chunkOffset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, chunkOffset, chunk.length - chunkOffset);
          chunkOffset += bytesWritten;
        }
        received += chunk.length;
        responseBytes += chunk.length;
        if (expectedSize > 0 && received > expectedSize) throw new Error('更新线路返回的文件超过清单大小');
        onProgress(progressPercent(received, total), received, total);
      }
      if (expectedResponseBytes > 0 && responseBytes !== expectedResponseBytes) {
        throw new Error(`更新线路响应体长度与声明不一致（${responseBytes}/${expectedResponseBytes} 字节）`);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    clearTimeout(idleTimer);
    controller.abort();
  }

  const completedSize = await partialSize(partialPath, expectedSize);
  if (expectedSize > 0 && completedSize !== expectedSize) {
    throw new Error(`更新连接提前中断（已保存 ${completedSize}/${expectedSize} 字节）`);
  }
  if (await fileSha512(partialPath) !== expectedSha512) {
    await rm(partialPath, { force: true }).catch(() => {});
    throw new Error('更新文件校验失败，已丢弃损坏的分片');
  }
  onProgress(100, completedSize, expectedSize || completedSize);
  return { received: completedSize, resumed };
}

export async function downloadResumableFile({
  url,
  partialPath,
  expectedSha512,
  expectedSize,
  onProgress = () => {},
  onRetry = () => {},
  maxAttempts = 3,
  retryDelayMs = 600,
  idleTimeoutMs = 25000,
  fetchImpl = fetch,
}) {
  const attempts = Math.max(1, Math.trunc(maxAttempts) || 1);
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadAttempt({
        url, partialPath, expectedSha512, expectedSize: Number(expectedSize) || 0,
        onProgress, fetchImpl, idleTimeoutMs,
      });
    } catch (error) {
      errors.push(error?.message || String(error));
      if (attempt >= attempts) break;
      const received = await partialSize(partialPath, Number(expectedSize) || 0);
      try {
        onRetry({
          attempt, maxAttempts: attempts, received, total: Number(expectedSize) || 0,
          percent: progressPercent(received, Number(expectedSize) || 0),
          error: error?.message || String(error),
        });
      } catch { /* UI 回调不能打断下载重连 */ }
      if (retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw new Error(`更新线路重连失败：${errors.join('；')}`);
}

export async function downloadVerifiedUpdate({
  updateInfo,
  destinationDir,
  preferMirrors = false,
  onProgress = () => {},
  onRetry = () => {},
}) {
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
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    try {
      const result = await downloadResumableFile({
        url, partialPath, expectedSha512, expectedSize: file.size, onProgress,
        onRetry: state => onRetry({ ...state, sourceIndex: index, sourceCount: urls.length }),
      });
      await rm(targetPath, { force: true }).catch(() => {});
      await rename(partialPath, targetPath);
      onProgress(100, Number(file.size) || 0, Number(file.size) || 0);
      return {
        path: targetPath,
        source: url.startsWith('https://github.com/') ? 'github' : 'mirror',
        resumed: result.resumed,
      };
    } catch (error) {
      errors.push(error?.message || String(error));
      // 所有候选地址指向同一版本、同一 sha512；切换镜像时继续复用已经校验范围的分片。
      if (index + 1 < urls.length) {
        const received = await partialSize(partialPath, Number(file.size) || 0);
        onRetry({
          attempt: 0, maxAttempts: 0, received, total: Number(file.size) || 0,
          percent: progressPercent(received, Number(file.size) || 0),
          sourceIndex: index + 1, sourceCount: urls.length, switchingSource: true,
          error: error?.message || String(error),
        });
      }
    }
  }
  const preserved = await partialSize(partialPath, Number(file.size) || 0);
  const resumeHint = preserved > 0
    ? `；已保留 ${progressPercent(preserved, Number(file.size) || 0)}% 分片，下次将从断点继续`
    : '';
  throw new Error(`所有更新线路均失败：${errors.join('；')}${resumeHint}`);
}
