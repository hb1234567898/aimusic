const BAND_EDGES_HZ = [86.1, 172.3, 344.5, 818.3, 2024.3, 4072.6, 8077.9, 16086];
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const approach = (value, target, speed, dt) => value + (target - value) * (1 - Math.exp(-speed * dt));

export function readBands(bins, sampleRate) {
  const output = new Float32Array(8);
  if (!bins?.length) return output;
  const hzPerBin = sampleRate / (bins.length * 2);
  let from = 0;
  for (let band = 0; band < output.length; band += 1) {
    const to = Math.min(bins.length, Math.max(from + 1, Math.round(BAND_EDGES_HZ[band] / hzPerBin)));
    let total = 0;
    for (let index = from; index < to; index += 1) total += bins[index];
    output[band] = Math.pow(total / Math.max(1, to - from) / 255, 0.86);
    from = to;
  }
  return output;
}

export function createMoodState() {
  return {
    intensity: 0,
    activity: 0,
    brightness: 0.35,
    warmth: 0.5,
    calm: 1,
    melancholy: 0.55,
    hitDensity: 0,
    previousBands: new Float32Array(8),
    label: '静候播放',
  };
}

export function updateMoodProfile(state, data) {
  const bands = data.bands;
  const dt = Math.min(0.05, data.dt || 0.0167);
  let total = 0;
  let weighted = 0;
  let positiveFlux = 0;
  for (let index = 0; index < 8; index += 1) {
    total += bands[index];
    weighted += bands[index] * index;
    positiveFlux += Math.max(0, bands[index] - state.previousBands[index]);
    state.previousBands[index] = bands[index];
  }
  const average = total / 8;
  const brightnessTarget = total > 0.001 ? weighted / total / 7 : state.brightness;
  const low = bands[0] + bands[1] + bands[2] + bands[3] * 0.55;
  const high = bands[4] * 0.6 + bands[5] + bands[6] + bands[7];
  const warmthTarget = low + high > 0.001 ? low / (low + high) : state.warmth;
  const onset = Math.max(data.onset || 0, (data.onsetHigh || 0) * 0.72);
  const activityTarget = clamp(positiveFlux / 8 * 5.2 + onset * 0.72 + (data.hit || 0) * 0.12);
  const hitTarget = onset > 0.22 ? 1 : 0;

  state.intensity = approach(state.intensity, data.playing ? clamp(average * 1.42) : 0.08, data.playing ? 1.8 : 0.35, dt);
  state.activity = approach(state.activity, data.playing ? activityTarget : 0.06, activityTarget > state.activity ? 3.8 : 0.82, dt);
  state.hitDensity = approach(state.hitDensity, hitTarget, hitTarget ? 5.2 : 0.42, dt);
  state.brightness = approach(state.brightness, brightnessTarget, 0.75, dt);
  state.warmth = approach(state.warmth, warmthTarget, 0.58, dt);
  state.calm = clamp(1 - state.activity * 0.58 - state.hitDensity * 0.18 - state.intensity * 0.18);
  state.melancholy = clamp(state.calm * (0.38 + (1 - state.brightness) * 0.52) + (bands[2] + bands[3]) * 0.08);

  if (!data.playing) state.label = '静候播放';
  else if (state.activity > 0.62 && state.intensity > 0.28) state.label = '高能 / DRIVEN';
  else if (state.melancholy > 0.62) state.label = '低落 / MELANCHOLIC';
  else if (state.warmth > 0.58) state.label = '温暖 / WARM';
  else state.label = '平静 / CALM';
  return state;
}
