import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectQQAuth, normalizeQQCookieInput } from './qq-music.mjs';

test('普通网页登录凭据不能冒充 QQ 音乐播放授权', () => {
  assert.deepEqual(inspectQQAuth('uin=o0012345; p_skey=web-only'), {
    userId: '12345',
    accountReady: true,
    playbackReady: false,
    playbackKeyName: '',
  });
});

test('qm_keyst 被识别为 QQ 音乐播放授权', () => {
  assert.deepEqual(inspectQQAuth('uin=o0012345; p_skey=web; qm_keyst=play'), {
    userId: '12345',
    accountReady: true,
    playbackReady: true,
    playbackKeyName: 'qm_keyst',
  });
});

test('微信登录的 wxuin 与 wxskey 可以组成播放授权', () => {
  assert.deepEqual(inspectQQAuth('login_type=2; wxuin=0012345; wxskey=play'), {
    userId: '12345',
    accountReady: true,
    playbackReady: true,
    playbackKeyName: 'wxskey',
  });
});

test('Cookie 归一化保留播放凭据并清理 UIN 前导零', () => {
  assert.equal(
    normalizeQQCookieInput(' uin=o0012345; qm_keyst=abc;;\nqqmusic_key=def; '),
    'uin=12345; qm_keyst=abc; qqmusic_key=def',
  );
});
