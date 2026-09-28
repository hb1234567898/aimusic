import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManifestCandidates,
  buildUpdateCandidates,
  compareVersions,
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
