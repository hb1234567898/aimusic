// 地形专用低频包络。BeatEngine.hit 是检测强度，不能直接当成原作的 kickEnvelope：
// 它一触发就有 0.45~1，再乘低频 EQ 会把所有拍子压成同一个最大柱高。
const ATTACK_RATE = 42;
const RELEASE_RATE = 11.5;
export const LOW_BAND_LIMITS = [1.2, 1.15];
const BASE_GAIN = [0.22, 0.2];

const finite = value => Number.isFinite(value) ? value : 0;
const unit = value => Math.max(0, Math.min(1, finite(value)));

export function createTerrainResponse() {
  return { noiseFloor: 0, impulse: 0, envelope: 0 };
}

export function stepTerrainResponse(state, {
  subBass = 0, bass = 0, onset = 0, playing = false, dt = 1 / 60,
  eq = [90, 92],
} = {}) {
  const delta = Math.max(0, finite(dt));
  const energies = playing ? [unit(subBass), unit(bass)] : [0, 0];
  const lowLevel = energies[0] * 0.6 + energies[1] * 0.4;
  const kickLevel = Math.max(0, lowLevel - state.noiseFloor - 0.025);
  const floorRate = lowLevel > state.noiseFloor ? 1.15 : 0.35;
  state.noiseFloor += (lowLevel - state.noiseFloor) * (1 - Math.exp(-floorRate * delta));

  // 新拍只是激励，不是最终柱高。实际频谱电平决定冲击大小，检测强度只作权重；
  // 持续的低音仍通过下方 baseline 呼吸，但不会每帧重新激励鼓点。
  const impulseStrength = playing && onset > 0
    ? unit(onset) * (0.12 + 0.55 * lowLevel ** 2 + 0.3 * kickLevel)
    : 0;
  state.impulse = Math.max(state.impulse, impulseStrength);

  // 参考原作 42/s 起振与 11.5/s 释放，使用连续时间双包络的解析解。
  // 即使掉到 30fps，峰值也不会因为「onset 只亮一帧」而变成两倍高。
  const attack = Math.exp(-ATTACK_RATE * delta);
  const release = Math.exp(-RELEASE_RATE * delta);
  state.envelope = state.envelope * attack
    + state.impulse * ATTACK_RATE / (ATTACK_RATE - RELEASE_RATE) * (release - attack);
  state.impulse *= release;

  // EQ 只增强持续低频；冲击使用 EQ 后剩下的高度空间，避免再被 EQ 放大、硬截顶。
  // 软肩部保留重拍余量，弱拍/中拍/强拍有不同高度，而不是单纯把所有柱子调矮。
  const pulseMix = 0.85 * (1 - Math.exp(-2 * state.envelope));
  const bands = energies.map((energy, index) => {
    const setting = Number.isFinite(eq[index]) ? Math.max(0, Math.min(100, eq[index])) : 50;
    const eqDelta = (setting - 50) / 50;
    const input = energy ** 1.4 * BASE_GAIN[index];
    const baseline = eqDelta >= 0
      ? input * (1 + eqDelta * 1.8)
      : Math.max(0, input - Math.abs(eqDelta) * 0.35) * (1 - Math.abs(eqDelta) * 0.35);
    const limit = LOW_BAND_LIMITS[index];
    // EQ=0 仍保持静音语义；默认 90/92 不会对瞬态二次放大。
    const enabled = Math.min(1, setting / 50);
    return baseline + (limit - baseline) * pulseMix * enabled;
  });

  return { subBass: bands[0], bass: bands[1], kickEnvelope: state.envelope, impulseStrength };
}
