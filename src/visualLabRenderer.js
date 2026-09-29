const TAU = Math.PI * 2;
const BAND_EDGES_HZ = [86.1, 172.3, 344.5, 818.3, 2024.3, 4072.6, 8077.9, 16086];

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function readBands(bins, sampleRate) {
  const output = new Float32Array(8);
  if (!bins?.length) return output;
  const hzPerBin = sampleRate / (bins.length * 2);
  let from = 0;
  for (let band = 0; band < output.length; band += 1) {
    const to = Math.min(bins.length, Math.max(from + 1, Math.round(BAND_EDGES_HZ[band] / hzPerBin)));
    let total = 0;
    for (let index = from; index < to; index += 1) total += bins[index];
    output[band] = Math.pow(total / Math.max(1, to - from) / 255, 0.78);
    from = to;
  }
  return output;
}

export function createVisualState() {
  return {
    lastHistoryAt: 0,
    canyon: [],
    ribbons: Array.from({ length: 8 }, () => []),
    pulses: [],
    previousOnset: 0,
  };
}

function prepare(ctx, width, height, time, energy) {
  ctx.clearRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width * 0.54, height * 0.5, 0, width * 0.54, height * 0.5, Math.max(width, height) * 0.68);
  glow.addColorStop(0, `rgba(72,76,84,${0.045 + energy * 0.025})`);
  glow.addColorStop(0.5, 'rgba(24,26,30,.025)');
  glow.addColorStop(1, 'rgba(7,8,10,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,.055)';
  const gap = width < 700 ? 42 : 54;
  const drift = (time * 2.3) % gap;
  for (let y = -gap + drift; y < height + gap; y += gap) {
    for (let x = gap * 0.5; x < width; x += gap) ctx.fillRect(x, y, 1, 1);
  }
}

function sampleBin(bins, ratio) {
  if (!bins?.length) return 0;
  const index = Math.min(bins.length - 1, Math.max(0, Math.floor(Math.pow(clamp(ratio), 2.15) * bins.length * 0.72)));
  return Math.pow(bins[index] / 255, 1.18);
}

function updatePulses(state, data) {
  if (data.onset > 0.36 && data.onset !== state.previousOnset) {
    state.pulses.push({ born: data.time, strength: data.onset });
    if (state.pulses.length > 8) state.pulses.shift();
  }
  state.previousOnset = data.onset;
  state.pulses = state.pulses.filter(pulse => data.time - pulse.born < 1.8);
}

function drawOrbit(ctx, width, height, data, state) {
  const cx = width * (width < 720 ? 0.5 : 0.55);
  const cy = height * 0.5;
  const base = Math.min(width, height) * 0.205;
  const amount = width < 700 ? 112 : 176;
  updatePulses(state, data);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(data.time * 0.035);
  for (let index = 0; index < amount; index += 1) {
    const angle = index / amount * TAU - Math.PI / 2;
    const folded = index <= amount / 2 ? index / (amount / 2) : (amount - index) / (amount / 2);
    const spectrum = sampleBin(data.bins, folded);
    const band = data.bands[Math.min(7, Math.floor(folded * 8))];
    const lift = (8 + spectrum * base * 0.58 + band * base * 0.18) * data.sensitivity;
    const inner = base - 3 - data.hit * 9;
    const outer = base + lift;
    const alpha = 0.16 + spectrum * 0.7 + data.hit * 0.12;
    ctx.strokeStyle = `rgba(240,242,245,${alpha})`;
    ctx.lineWidth = spectrum > 0.7 ? 1.7 : 0.85;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  for (const pulse of state.pulses) {
    const age = data.time - pulse.born;
    const radius = base * (0.82 + age * 0.72);
    const alpha = (1 - age / 1.8) * pulse.strength * 0.42;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([Math.max(5, radius * 0.08), Math.max(10, radius * 0.16)]);
    ctx.lineDashOffset = -age * 32;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, base * 0.92);
  core.addColorStop(0, `rgba(255,255,255,${0.035 + data.energy * 0.06})`);
  core.addColorStop(0.65, 'rgba(255,255,255,.012)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, base * (0.86 + data.hit * 0.04), 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawCanyon(ctx, width, height, data, state) {
  if (data.time - state.lastHistoryAt > 0.045) {
    const row = new Float32Array(64);
    for (let index = 0; index < row.length; index += 1) row[index] = sampleBin(data.bins, index / (row.length - 1));
    state.canyon.unshift(row);
    if (state.canyon.length > 46) state.canyon.pop();
    state.lastHistoryAt = data.time;
  }
  const horizon = height * 0.2;
  const floor = height * 0.94;
  const center = width * 0.54;
  for (let rowIndex = state.canyon.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = state.canyon[rowIndex];
    const depth = 1 - rowIndex / Math.max(1, state.canyon.length - 1);
    const perspective = Math.pow(depth, 1.65);
    const yBase = horizon + (floor - horizon) * perspective;
    const span = width * (0.12 + perspective * 0.57);
    const liftScale = height * (0.025 + perspective * 0.19) * data.sensitivity;
    ctx.strokeStyle = `rgba(226,229,234,${0.035 + perspective * 0.34})`;
    ctx.lineWidth = 0.6 + perspective * 0.9;
    ctx.beginPath();
    for (let index = 0; index < row.length; index += 1) {
      const ratio = index / (row.length - 1);
      const x = center + (ratio - 0.5) * span * 2;
      const centerWeight = 0.48 + Math.sin(ratio * Math.PI) * 0.52;
      const lift = row[index] * liftScale * centerWeight + (rowIndex === 0 ? data.hit * height * 0.045 : 0);
      const y = yBase - lift;
      if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const columns = 18;
  ctx.strokeStyle = 'rgba(255,255,255,.055)';
  ctx.lineWidth = 0.7;
  for (let index = 0; index <= columns; index += 1) {
    const ratio = index / columns;
    ctx.beginPath();
    ctx.moveTo(center + (ratio - 0.5) * width * 0.24, horizon);
    ctx.lineTo(center + (ratio - 0.5) * width * 1.14, floor);
    ctx.stroke();
  }
}

function drawRibbons(ctx, width, height, data, state) {
  if (data.time - state.lastHistoryAt > 0.025) {
    data.bands.forEach((value, index) => {
      state.ribbons[index].unshift(value);
      if (state.ribbons[index].length > 190) state.ribbons[index].pop();
    });
    state.lastHistoryAt = data.time;
  }
  const left = width * (width < 700 ? 0.07 : 0.24);
  const right = width * 0.96;
  const usable = right - left;
  const centerY = height * 0.52;
  const gap = Math.min(42, height * 0.055);
  for (let band = 0; band < 8; band += 1) {
    const history = state.ribbons[band];
    const baseY = centerY + (band - 3.5) * gap;
    const direction = band % 2 ? 1 : -1;
    const strength = (26 + (7 - band) * 4.5) * data.sensitivity;
    const gradient = ctx.createLinearGradient(left, 0, right, 0);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.22, `rgba(255,255,255,${0.08 + (7 - band) * 0.012})`);
    gradient.addColorStop(0.72, `rgba(255,255,255,${0.2 + data.bands[band] * 0.28})`);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = band < 2 ? 1.6 : 0.8;
    ctx.beginPath();
    for (let index = 0; index < 190; index += 1) {
      const ratio = index / 189;
      const value = history[index] || 0;
      const x = right - ratio * usable;
      const envelope = Math.sin(ratio * Math.PI);
      const detail = Math.sin(index * 0.22 + data.time * (1.1 + band * 0.08)) * value * 5;
      const y = baseY + direction * value * strength * envelope + detail;
      if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  if (data.onsetHigh > 0.38) {
    const x = right - usable * 0.12;
    const flare = ctx.createLinearGradient(0, centerY - gap * 5, 0, centerY + gap * 5);
    flare.addColorStop(0, 'rgba(255,255,255,0)');
    flare.addColorStop(0.5, `rgba(255,255,255,${data.onsetHigh * 0.42})`);
    flare.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = flare;
    ctx.beginPath();
    ctx.moveTo(x, centerY - gap * 5);
    ctx.lineTo(x, centerY + gap * 5);
    ctx.stroke();
  }
}

function drawSphere(ctx, width, height, data) {
  const cx = width * (width < 720 ? 0.5 : 0.56);
  const cy = height * 0.51;
  const radius = Math.min(width, height) * (0.26 + data.hit * 0.018);
  const points = [];
  const latitudes = width < 700 ? 20 : 28;
  const longitudes = width < 700 ? 42 : 64;
  const rotation = data.time * 0.13;
  for (let lat = 1; lat < latitudes; lat += 1) {
    const phi = lat / latitudes * Math.PI;
    for (let lon = 0; lon < longitudes; lon += 1) {
      const theta = lon / longitudes * TAU + rotation;
      const bandIndex = Math.min(7, Math.floor(Math.abs(Math.cos(phi)) * 8));
      const band = data.bands[bandIndex];
      const grain = sampleBin(data.bins, lon / longitudes);
      const deformation = 1 + (band * 0.14 + grain * 0.075 + data.hit * 0.035) * data.sensitivity;
      const x = Math.sin(phi) * Math.cos(theta) * deformation;
      const y = Math.cos(phi) * deformation;
      const z = Math.sin(phi) * Math.sin(theta);
      const perspective = 1 / (1.62 - z * 0.22);
      points.push({
        x: cx + x * radius * perspective,
        y: cy + y * radius * perspective,
        z,
        alpha: 0.08 + (z + 1) * 0.16 + band * 0.42,
        size: 0.55 + (z + 1) * 0.62 + grain * 1.4,
      });
    }
  }
  points.sort((a, b) => a.z - b.z);
  for (const point of points) {
    ctx.fillStyle = `rgba(242,244,247,${clamp(point.alpha, 0.03, 0.82)})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, point.size, 0, TAU);
    ctx.fill();
  }
  const halo = ctx.createRadialGradient(cx, cy, radius * 0.12, cx, cy, radius * 1.25);
  halo.addColorStop(0, `rgba(255,255,255,${0.018 + data.energy * 0.022})`);
  halo.addColorStop(0.74, 'rgba(255,255,255,0)');
  halo.addColorStop(1, `rgba(255,255,255,${data.hit * 0.035})`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.28, 0, TAU);
  ctx.fill();
}

export function drawVisual(ctx, width, height, mode, data, state) {
  prepare(ctx, width, height, data.time, data.energy);
  if (mode === 'orbit') drawOrbit(ctx, width, height, data, state);
  else if (mode === 'canyon') drawCanyon(ctx, width, height, data, state);
  else if (mode === 'ribbons') drawRibbons(ctx, width, height, data, state);
  else drawSphere(ctx, width, height, data, state);
}
