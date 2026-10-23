import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainResponse, stepTerrainResponse, LOW_BAND_LIMITS } from './terrainResponse.js';
import { createTerrainGL } from './terrainGL.js';

const sample = (state, overrides = {}) => stepTerrainResponse(state, {
  subBass: 0.55, bass: 0.55, playing: true, dt: 1 / 60, ...overrides,
});

function pulsePeak(level, strength) {
  const state = createTerrainResponse();
  for (let i = 0; i < 120; i += 1) sample(state, { subBass: level, bass: level });
  const baseline = sample(state, { subBass: level, bass: level });
  let peak = baseline.subBass;
  for (let i = 0; i < 45; i += 1) {
    const result = sample(state, { subBass: level, bass: level, onset: i === 0 ? strength : 0 });
    peak = Math.max(peak, result.subBass);
  }
  return { peak, lift: peak - baseline.subBass };
}

test('light, medium and strong detected kicks keep distinct heights instead of hitting the ceiling', () => {
  for (const level of [0, 0.25, 0.5, 0.75, 1]) {
    const peaks = [0, 0.45, 0.75, 1].map(strength => pulsePeak(level, strength).peak);
    assert.ok(peaks.every(p => p < LOW_BAND_LIMITS[0] * 0.95));
    for (let i = 1; i < peaks.length; i += 1) assert.ok(peaks[i] > peaks[i - 1]);
  }
});

test('actual low-frequency level changes the punch even when detection confidence is identical', () => {
  const lifts = [0.2, 0.5, 0.85].map(level => pulsePeak(level, 1).lift);
  assert.ok(lifts[1] > lifts[0] * 1.4);
  assert.ok(lifts[2] > lifts[1] * 1.2);
});

test('a kick rises over several frames then releases, without an instantaneous full-height step', () => {
  const state = createTerrainResponse();
  const frames = Array.from({ length: 90 }, (_, i) => sample(state, { onset: i === 0 ? 1 : 0 }));
  const peak = Math.max(...frames.map(f => f.kickEnvelope));
  const peakIndex = frames.findIndex(f => f.kickEnvelope === peak);
  assert.ok(peakIndex >= 1 && peakIndex <= 6, `peak frame ${peakIndex}`);
  assert.ok(frames[0].kickEnvelope < peak * 0.9);
  assert.ok(frames.at(-1).kickEnvelope < peak * 0.001);
  assert.ok(frames.slice(1).every(f => f.impulseStrength === 0));
});

test('sustained bass continues breathing with the spectrum without inventing drum impulses', () => {
  const state = createTerrainResponse();
  const low = sample(state, { subBass: 0.2, bass: 0.2 });
  const high = sample(state, { subBass: 0.8, bass: 0.8 });
  assert.ok(high.subBass > low.subBass * 2);
  assert.equal(high.kickEnvelope, 0);
  assert.equal(high.impulseStrength, 0);
});

test('continuous-time attack/release agrees at 30, 60 and 120fps', () => {
  const render = fps => {
    const state = createTerrainResponse();
    const checkpoints = [];
    for (let i = 0; i < fps; i += 1) {
      const result = sample(state, { onset: i === 0 ? 0.8 : 0, dt: 1 / fps });
      if ((i + 1) % (fps / 10) === 0) checkpoints.push(result.subBass);
    }
    return checkpoints;
  };
  const reference = render(120);
  for (const fps of [30, 60]) render(fps).forEach((v, i) => assert.ok(Math.abs(v - reference[i]) < 1e-10));
});

test('dense kicks retain headroom and quiet passages release to silence', () => {
  const state = createTerrainResponse();
  for (let i = 0; i < 600; i += 1) {
    const result = sample(state, { subBass: 1, bass: 1, onset: i % 5 === 0 ? 1 : 0 });
    assert.ok(result.subBass < LOW_BAND_LIMITS[0] * 0.95);
    assert.ok(result.bass < LOW_BAND_LIMITS[1] * 0.95);
  }
  let result;
  for (let i = 0; i < 180; i += 1) result = sample(state, { playing: false, onset: 1 });
  assert.ok(result.subBass < 1e-10);
  assert.equal(result.impulseStrength, 0);
});

test('invalid samples stay finite, EQ=0 mutes, and zero dt does not jump the envelope', () => {
  const state = createTerrainResponse();
  const result = sample(state, { subBass: NaN, bass: Infinity, onset: NaN, dt: NaN });
  assert.ok(Object.values(result).every(Number.isFinite));
  assert.equal(sample(state, { onset: 1, dt: 0 }).kickEnvelope, 0);
  const muted = sample(state, { onset: 1, eq: [0, 0] });
  assert.equal(muted.subBass, 0);
  assert.equal(muted.bass, 0);
});

// Wiring-only WebGL stub: records uniforms, does not claim GPU/image validation.
function rendererHarness(options = {}) {
  const uniforms = new Map();
  const gl = new Proxy({
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getAttribLocation: () => 0,
    getUniformLocation: (_, name) => name,
    uniform1f: (name, value) => uniforms.set(name, value),
    uniform4fv: (name, values) => uniforms.set(name, [...values]),
    uniform2fv: (name, values) => uniforms.set(name, [...values]),
  }, { get: (target, name) => name in target ? target[name] : (/^[A-Z_]+$/.test(name) ? 0 : () => ({})) });
  const canvas = { width: 800, height: 600, getContext: () => gl };
  const renderer = createTerrainGL(canvas, { gridSize: 8, ...options });
  const bins = new Uint8Array(512).fill(140);
  const frame = overrides => renderer.frame({
    bins, playing: true, dt: 1 / 60, time: 0, sampleRate: 44100, ...overrides,
  });
  const rippleCount = () => (uniforms.get('uRippleMeta[0]') || []).filter((v, i) => i % 2 === 0 && v > 0).length;
  return { renderer, frame, uniforms, rippleCount };
}

test('renderer sends graded low-band uniforms to the existing central-peak shader', () => {
  const peak = strength => {
    const h = rendererHarness({ onsetRipples: false });
    for (let i = 0; i < 60; i += 1) h.frame({ time: i / 60 });
    let max = 0;
    for (let i = 0; i < 30; i += 1) {
      h.frame({ time: 1 + i / 60, onset: i === 0 ? strength : 0, kickEnvelope: 1 });
      max = Math.max(max, h.uniforms.get('uSubBass'));
    }
    h.renderer.dispose();
    return max;
  };
  const peaks = [0.45, 0.75, 1].map(peak);
  assert.ok(peaks[0] < peaks[1] && peaks[1] < peaks[2]);
  assert.ok(peaks[2] < 1);
});

test('renderer peak height and timing stay close at 30, 60 and 120fps', () => {
  const runs = [30, 60, 120].map(fps => {
    const h = rendererHarness({ onsetRipples: false });
    for (let i = 0; i < fps; i += 1) h.frame({ time: i / fps, dt: 1 / fps });
    let peak = 0;
    let peakTime = 0;
    for (let i = 0; i < fps / 2; i += 1) {
      h.frame({ time: 1 + i / fps, dt: 1 / fps, onset: i === 0 ? 1 : 0 });
      const value = h.uniforms.get('uSubBass');
      if (value > peak) { peak = value; peakTime = (i + 1) / fps; }
    }
    h.renderer.dispose();
    assert.ok(peakTime <= 0.1, `peak took ${peakTime}s at ${fps}fps`);
    return { peak, peakTime };
  });
  const heights = runs.map(r => r.peak);
  const times = runs.map(r => r.peakTime);
  assert.ok(Math.max(...heights) / Math.min(...heights) < 1.05);
  assert.ok(Math.max(...times) - Math.min(...times) <= 1 / 30);
});

test('renderer emits one wave per new onset, not from a long hit tail or cooldown expiry', () => {
  const h = rendererHarness({ rippleCooldown: 0.01 });
  h.frame({ onset: 1, kickEnvelope: 1 });
  assert.equal(h.rippleCount(), 1);
  for (let i = 1; i < 30; i += 1) h.frame({ time: i / 60, onset: 0, kickEnvelope: 1 });
  assert.equal(h.rippleCount(), 1);
  h.frame({ time: 0.5, onset: 0.5, kickEnvelope: 1 });
  assert.equal(h.rippleCount(), 2);
  h.frame({ time: 0.6, onset: 1, playing: false });
  assert.equal(h.rippleCount(), 2);
  h.renderer.dispose();
});

test('renderer retains ripple cooldown and onsetRipples=false behavior', () => {
  const h = rendererHarness();
  h.frame({ onset: 1 });
  h.frame({ time: 0.1, onset: 1 });
  assert.equal(h.rippleCount(), 1);
  h.frame({ time: 0.3, onset: 1 });
  assert.equal(h.rippleCount(), 2);
  h.renderer.dispose();
  const disabled = rendererHarness({ onsetRipples: false });
  disabled.frame({ onset: 1 });
  assert.equal(disabled.rippleCount(), 0);
  disabled.renderer.dispose();
});
