import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateCandidates } from '../desktop/update-download.mjs';

const info = {
  version: '1.2.3',
  files: [{ url: 'ORBIT-Music-Setup-1.2.3.exe', sha512: 'official-hash', size: 123 }],
};

test('China update order prefers mirrors but retains official fallback', () => {
  const result = buildUpdateCandidates(info, true);
  assert.equal(result.fileName, 'ORBIT-Music-Setup-1.2.3.exe');
  assert.equal(result.expectedSha512, 'official-hash');
  assert.match(result.urls[0], /^https:\/\/gh-proxy\.com\/https:\/\/github\.com\//);
  assert.match(result.urls.at(-1), /^https:\/\/github\.com\//);
});

test('non-China update order keeps GitHub first', () => {
  const result = buildUpdateCandidates(info, false);
  assert.match(result.urls[0], /^https:\/\/github\.com\//);
  assert.equal(result.urls.length, 4);
});
