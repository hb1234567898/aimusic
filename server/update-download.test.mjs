import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildManifestCandidates,
  buildUpdateCandidates,
  compareVersions,
  createVersionedTaskQueue,
  downloadResumableFile,
  parseUpdateManifest,
} from '../desktop/update-download.mjs';

const info = {
  version: '1.2.3',
  files: [{ url: 'ORBIT-Music-Setup-1.2.3.exe', sha512: 'official-hash', size: 123 }],
};

test('China update order prefers mirrors but retains official fallback', () => {
  const result = buildUpdateCandidates(info, true);
  assert.equal(result.fileName, 'ORBIT-Music-Setup-1.2.3.exe');
  assert.equal(result.expectedSha512, 'official-hash');
  assert.match(result.urls[0], /^https:\/\/ghfast\.top\/https:\/\/github\.com\//);
  assert.match(result.urls.at(-1), /^https:\/\/github\.com\//);
});

test('non-China update order keeps GitHub first', () => {
  const result = buildUpdateCandidates(info, false);
  assert.match(result.urls[0], /^https:\/\/github\.com\//);
  assert.equal(result.urls.length, 5);
});

test('China update checks use mirrors before GitHub', () => {
  const urls = buildManifestCandidates(true);
  assert.match(urls[0], /^https:\/\/ghfast\.top\/https:\/\/github\.com\//);
  assert.match(urls.at(-1), /^https:\/\/github\.com\//);
});

test('parses the signed hash and installer data from latest.yml', () => {
  const parsed = parseUpdateManifest(`version: 1.2.3
files:
  - url: ORBIT-Music-Setup-1.2.3.exe
    sha512: ${'A'.repeat(86)}==
    size: 123456
path: ORBIT-Music-Setup-1.2.3.exe
releaseDate: '2026-09-28T07:11:21.564Z'
`);
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.files[0].url, 'ORBIT-Music-Setup-1.2.3.exe');
  assert.equal(parsed.files[0].size, 123456);
});

test('compares release versions numerically', () => {
  assert.equal(compareVersions('1.0.15', '1.0.14'), 1);
  assert.equal(compareVersions('1.0.14', '1.0.14'), 0);
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1);
});

test('versioned task queue deduplicates one version and starts only the latest queued version', async () => {
  const queue = createVersionedTaskQueue();
  const starts = [];
  let current = '1.0.1';
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const first = queue.run('1.0.1', version => current === version, () => {
    starts.push('1.0.1');
    return gate;
  });
  const duplicate = queue.run('1.0.1', version => current === version, () => {
    starts.push('duplicate');
  });
  assert.equal(duplicate, first);
  current = '1.0.2';
  const second = queue.run('1.0.2', version => current === version, () => starts.push('1.0.2'));
  current = '1.0.3';
  const third = queue.run('1.0.3', version => current === version, () => {
    starts.push('1.0.3');
    return 'latest';
  });
  await Promise.resolve();
  assert.deepEqual(starts, ['1.0.1']);
  releaseFirst('old');
  assert.equal(await first, 'old');
  assert.deepEqual(await second, { superseded: true });
  assert.equal(await third, 'latest');
  assert.deepEqual(starts, ['1.0.1', '1.0.3']);
});

const digest = data => createHash('sha512').update(data).digest('base64');
const fixture = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => (index * 37 + 11) & 255));

async function temporaryPartial(t, initial = Buffer.alloc(0)) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orbit-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const partialPath = path.join(directory, 'update.exe.part');
  if (initial.length) await writeFile(partialPath, initial);
  return partialPath;
}

function rangeStart(headers) {
  const value = headers.Range || headers.range || '';
  return Number(String(value).match(/^bytes=(\d+)-$/)?.[1] || 0);
}

function rangedResponse(data, start) {
  return new Response(data.subarray(start), {
    status: 206,
    headers: {
      'Content-Length': String(data.length - start),
      'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}`,
    },
  });
}

test('resumes an existing partial file with a validated Range response', async t => {
  const prefix = 64 * 1024;
  const partialPath = await temporaryPartial(t, fixture.subarray(0, prefix));
  const ranges = [];
  const progress = [];
  await downloadResumableFile({
    url: 'https://updates.invalid/update.exe', partialPath,
    expectedSha512: digest(fixture), expectedSize: fixture.length,
    maxAttempts: 1,
    onProgress: (percent, received) => progress.push({ percent, received }),
    fetchImpl: async (_url, options) => {
      const start = rangeStart(options.headers);
      ranges.push(start);
      return rangedResponse(fixture, start);
    },
  });
  assert.deepEqual(ranges, [prefix]);
  assert.deepEqual(await readFile(partialPath), fixture);
  assert.ok(progress.some(item => item.received === prefix && item.percent === 25));
  assert.equal(progress.at(-1).percent, 100);
});

test('rejects a mismatched Content-Range without appending to the partial file', async t => {
  const prefix = 16 * 1024;
  const initial = fixture.subarray(0, prefix);
  const partialPath = await temporaryPartial(t, initial);
  await assert.rejects(downloadResumableFile({
    url: 'https://updates.invalid/update.exe', partialPath,
    expectedSha512: digest(fixture), expectedSize: fixture.length,
    maxAttempts: 1,
    fetchImpl: async () => rangedResponse(fixture, prefix + 1),
  }), /无效的断点范围/);
  assert.deepEqual(await readFile(partialPath), initial);
});

test('clears an unsupported range after 416 and retries once with a full GET', async t => {
  const prefix = 20 * 1024;
  const partialPath = await temporaryPartial(t, fixture.subarray(0, prefix));
  const starts = [];
  await downloadResumableFile({
    url: 'https://updates.invalid/update.exe', partialPath,
    expectedSha512: digest(fixture), expectedSize: fixture.length,
    maxAttempts: 2, retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      const start = rangeStart(options.headers);
      starts.push(start);
      if (starts.length === 1) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${fixture.length}` },
        });
      }
      return new Response(fixture, {
        status: 200,
        headers: { 'Content-Length': String(fixture.length) },
      });
    },
  });
  assert.deepEqual(starts, [prefix, 0]);
  assert.deepEqual(await readFile(partialPath), fixture);
});

test('detects when a 206 body is shorter than its declared Content-Range', async t => {
  const prefix = 12 * 1024;
  const partialPath = await temporaryPartial(t, fixture.subarray(0, prefix));
  const declaredBytes = 2048;
  const actualBytes = 1024;
  await assert.rejects(downloadResumableFile({
    url: 'https://updates.invalid/update.exe', partialPath,
    expectedSha512: digest(fixture), expectedSize: fixture.length,
    maxAttempts: 1,
    fetchImpl: async () => new Response(fixture.subarray(prefix, prefix + actualBytes), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${prefix}-${prefix + declaredBytes - 1}/${fixture.length}`,
      },
    }),
  }), /响应体长度与声明不一致/);
  assert.equal((await readFile(partialPath)).length, prefix + actualBytes);
});

test('drops a corrupt mixed partial after final hash failure and retries cleanly', async t => {
  const prefix = 40 * 1024;
  const partialPath = await temporaryPartial(t, Buffer.alloc(prefix, 255));
  const starts = [];
  await downloadResumableFile({
    url: 'https://updates.invalid/update.exe', partialPath,
    expectedSha512: digest(fixture), expectedSize: fixture.length,
    maxAttempts: 2, retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      const start = rangeStart(options.headers);
      starts.push(start);
      return start > 0
        ? rangedResponse(fixture, start)
        : new Response(fixture, { status: 200, headers: { 'Content-Length': String(fixture.length) } });
    },
  });
  assert.deepEqual(starts, [prefix, 0]);
  assert.deepEqual(await readFile(partialPath), fixture);
});

test('automatically reconnects after a broken response and continues from bytes already written', async t => {
  const partialPath = await temporaryPartial(t);
  const cutoff = 48 * 1024;
  const starts = [];
  let request = 0;
  const retries = [];
  await downloadResumableFile({
    url: 'https://updates.invalid/update.exe', partialPath,
    expectedSha512: digest(fixture), expectedSize: fixture.length,
    maxAttempts: 3, retryDelayMs: 0,
    onRetry: state => retries.push(state),
    fetchImpl: async (_url, options) => {
      const start = rangeStart(options.headers);
      starts.push(start);
      request += 1;
      if (request === 1) {
        let emitted = false;
        const body = new ReadableStream({
          pull(controller) {
            if (!emitted) {
              emitted = true;
              controller.enqueue(fixture.subarray(0, cutoff));
            } else controller.error(new Error('simulated connection reset'));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Length': String(fixture.length) },
        });
      }
      return rangedResponse(fixture, start);
    },
  });
  assert.deepEqual(starts, [0, cutoff]);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].received, cutoff);
  assert.deepEqual(await readFile(partialPath), fixture);
});

test('safely restarts from zero when a mirror ignores Range', async t => {
  const prefix = 72 * 1024;
  const partialPath = await temporaryPartial(t, fixture.subarray(0, prefix));
  let requestedRange = '';
  await downloadResumableFile({
    url: 'https://updates.invalid/update.exe', partialPath,
    expectedSha512: digest(fixture), expectedSize: fixture.length,
    maxAttempts: 1,
    fetchImpl: async (_url, options) => {
      requestedRange = options.headers.Range;
      return new Response(fixture, {
        status: 200,
        headers: { 'Content-Length': String(fixture.length) },
      });
    },
  });
  assert.equal(requestedRange, `bytes=${prefix}-`);
  assert.deepEqual(await readFile(partialPath), fixture);
});

test('keeps a partial file after retries are exhausted so a later app run can resume', async t => {
  const prefix = 32 * 1024;
  const partialPath = await temporaryPartial(t, fixture.subarray(0, prefix));
  const retries = [];
  await assert.rejects(downloadResumableFile({
    url: 'https://updates.invalid/update.exe', partialPath,
    expectedSha512: digest(fixture), expectedSize: fixture.length,
    maxAttempts: 2, retryDelayMs: 0,
    onRetry: state => retries.push(state),
    fetchImpl: async () => { throw new Error('offline'); },
  }), /重连失败/);
  assert.equal((await readFile(partialPath)).length, prefix);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].percent, 13);
});
