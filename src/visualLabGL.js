const MODE_INDEX = { veil: 0, terrain: 1, rain: 2, core: 3 };

const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uBandsA;
uniform vec4 uBandsB;
uniform vec4 uMood;    // intensity, activity, brightness, melancholy
uniform vec4 uAccent;  // hit, hitHigh, onset, onsetHigh
uniform vec4 uWeather; // warmth, hit density, calm, playing
uniform float uSensitivity;
uniform int uMode;

#define PI 3.14159265359
#define TAU 6.28318530718

float sat(float value) { return clamp(value, 0.0, 1.0); }
mat2 rot(float angle) { float c = cos(angle), s = sin(angle); return mat2(c, -s, s, c); }

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1,0,0));
  float n010 = hash31(i + vec3(0,1,0));
  float n110 = hash31(i + vec3(1,1,0));
  float n001 = hash31(i + vec3(0,0,1));
  float n101 = hash31(i + vec3(1,0,1));
  float n011 = hash31(i + vec3(0,1,1));
  float n111 = hash31(i + vec3(1,1,1));
  return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),
             mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);
}

float fbm2(vec2 p) {
  float value = 0.0, amplitude = 0.5;
  mat2 turn = rot(0.57);
  for (int i = 0; i < 5; i++) {
    value += noise2(p) * amplitude;
    p = turn * p * 2.03 + 7.17;
    amplitude *= 0.5;
  }
  return value;
}

float fbm3(vec3 p) {
  float value = 0.0, amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += noise3(p) * amplitude;
    p = p * 2.04 + vec3(3.1, 5.7, 7.3);
    amplitude *= 0.5;
  }
  return value;
}

float getBand(int index) {
  if (index < 4) return uBandsA[index];
  return uBandsB[index - 4];
}

float bandAt(float position) {
  float scaled = sat(position) * 7.0;
  int first = int(floor(scaled));
  int second = min(7, first + 1);
  return mix(getBand(first), getBand(second), fract(scaled));
}

vec3 silver(float value, float warmth) {
  vec3 cold = vec3(0.72, 0.77, 0.84);
  vec3 warm = vec3(0.88, 0.86, 0.81);
  return mix(cold, warm, warmth) * value;
}

vec3 renderVeil(vec2 p) {
  float intensity = uMood.x, activity = uMood.y, melancholy = uMood.w;
  float speed = mix(0.035, 0.24, activity);
  float time = uTime * speed;
  vec3 color = vec3(0.0);
  float haze = 0.0;
  for (int layer = 0; layer < 5; layer++) {
    float depth = float(layer) / 4.0;
    vec2 q = p * mix(1.05, 1.72, depth);
    vec2 flow = q * 1.12 + vec2(time, depth * 4.7);
    float warp = noise2(flow) * 0.68 + noise2(flow * 2.03 + 5.7) * 0.32;
    float band = bandAt(depth);
    float sag = melancholy * (q.x * q.x) * 0.085;
    float curve = sin(q.x * mix(1.25, 2.4, activity) + depth * 4.2 + time * 2.2) * (0.055 + melancholy * 0.075);
    curve += (warp - 0.5) * (0.18 + activity * 0.11) + sag - 0.06 + depth * 0.018;
    float distanceToVeil = abs(q.y - curve);
    float filament = exp(-distanceToVeil * mix(20.0, 43.0, 1.0 - depth));
    float body = exp(-distanceToVeil * 6.5) * 0.08;
    float strength = (0.085 + band * (0.2 + activity * 0.2) * uSensitivity) / (0.72 + depth);
    color += silver(filament * strength, uMood.z * 0.45) * (1.0 - depth * 0.42);
    haze += body * (0.02 + intensity * 0.035);
  }
  float verticalFog = fbm2(p * 0.85 + vec2(-time * 0.22, time * 0.1));
  color += silver(haze + verticalFog * 0.018 * melancholy, 0.2);
  color += silver(uAccent.z * 0.08 * exp(-abs(length(p) - fract(uTime * 0.42) * 1.8) * 9.0), 0.3);
  return color;
}

float terrainHeight(vec2 position) {
  float activity = uMood.y;
  float melancholy = uMood.w;
  float distanceFromCenter = length(position);
  vec2 drift = position + vec2(uTime * 0.07, -uTime * 0.035);
  float base = (noise2(drift * 0.38) - 0.48) * (0.24 + melancholy * 0.16);
  float slowWave = sin(position.x * 0.58 + position.y * 0.32 - uTime * mix(0.12, 0.55, activity)) * (0.055 + melancholy * 0.065);
  slowWave += sin(position.x * 1.18 - position.y * 0.46 + uTime * 0.09) * 0.035;
  float spectrum = bandAt(sat(distanceFromCenter * 0.115)) * exp(-distanceFromCenter * 0.075);
  float audioLift = spectrum * (0.18 + activity * 0.7) * uSensitivity;
  float centerBreath = uBandsA.x * exp(-distanceFromCenter * distanceFromCenter * 0.11) * (0.28 + uAccent.x * 0.45);
  return base + slowWave + audioLift + centerBreath;
}

vec3 terrainNormal(vec3 position) {
  float epsilon = 0.018;
  float center = terrainHeight(position.xz);
  return normalize(vec3(
    center - terrainHeight(position.xz + vec2(epsilon, 0.0)),
    epsilon,
    center - terrainHeight(position.xz + vec2(0.0, epsilon))
  ));
}

vec3 renderTerrain(vec2 p) {
  vec3 ro = vec3(0.0, 1.42, -3.1);
  vec3 rd = normalize(vec3(p.x, p.y - 0.08, 1.48));
  rd.yz = rot(-0.48) * rd.yz;
  float travel = 0.0;
  float hit = 0.0;
  vec3 position = ro;
  for (int step = 0; step < 42; step++) {
    position = ro + rd * travel;
    float distanceToSurface = position.y - terrainHeight(position.xz);
    if (distanceToSurface < 0.008) { hit = 1.0; break; }
    travel += max(0.018, distanceToSurface * 0.34);
    if (travel > 13.0 || position.y < -1.2) break;
  }
  if (hit < 0.5) {
    float mist = fbm2(p * 1.15 + uTime * 0.012) * 0.018 * uMood.w;
    return silver(mist, 0.15);
  }
  vec3 normal = terrainNormal(position);
  vec3 lightDir = normalize(vec3(-0.35, 0.82, -0.42));
  float diffuse = max(0.0, dot(normal, lightDir));
  float fresnel = pow(1.0 - max(0.0, dot(normal, -rd)), 2.5);
  vec2 gridPosition = abs(fract(position.xz * 1.42) - 0.5);
  vec2 gridWidth = fwidth(position.xz * 1.42);
  float grid = 1.0 - min(min(gridPosition.x / max(gridWidth.x, 0.001), gridPosition.y / max(gridWidth.y, 0.001)), 1.0);
  float fog = exp(-travel * 0.16);
  float topGlow = 0.08 + diffuse * 0.22 + fresnel * 0.34 + grid * (0.08 + uMood.y * 0.15);
  topGlow += uAccent.x * exp(-length(position.xz) * 0.65) * 0.16;
  return silver(topGlow * fog, uMood.z * 0.55) + silver(grid * 0.035 * fog, 0.0);
}

float rainTrigger() {
  float lowEnergy = (uBandsA.x + uBandsA.y * 0.88 + uBandsA.z * 0.58) / 2.46;
  float dominance = smoothstep(0.53, 0.72, uWeather.x);
  float weight = smoothstep(0.08, 0.3, lowEnergy) * dominance;
  return weight * uWeather.w;
}

vec3 renderRain(vec2 p, float preview) {
  float intensity = uMood.x, activity = uMood.y, melancholy = uMood.w;
  vec3 color = vec3(0.0);
  float drive = max(rainTrigger(), preview);
  if (drive < 0.008) return color;

  float horizon = -0.2;
  float speed = mix(0.16, 0.52, activity) + drive * 0.34;
  float waterMask = 1.0 - smoothstep(horizon - 0.025, horizon + 0.025, p.y);
  float rippleLight = 0.0;
  float rainLight = 0.0;
  for (int index = 0; index < 28; index++) {
    float fi = float(index);
    float seed = hash21(vec2(fi * 4.17, fi * 9.31 + 2.4));
    float phase = fract(uTime * speed * mix(0.72, 1.38, seed) + seed * 8.7);
    float lane = mix(-1.8, 1.8, hash21(vec2(fi * 7.3, 1.7)));
    lane += sin(uTime * 0.09 + fi) * 0.035;
    float visibleDrop = 1.0 - step(0.82, phase);
    float fallPhase = min(1.0, phase / 0.82);
    float dropY = mix(1.22, horizon, fallPhase);
    vec2 dropDelta = p - vec2(lane, dropY);
    float streak = exp(-abs(dropDelta.x) * mix(260.0, 520.0, seed));
    streak *= smoothstep(0.075, -0.25, dropDelta.y) * smoothstep(-0.34, 0.025, dropDelta.y);
    float densityGate = step(seed, 0.22 + drive * 0.78);
    rainLight += streak * visibleDrop * densityGate * (0.1 + drive * 0.34);

    float impactAge = sat((phase - 0.82) / 0.18);
    vec2 waterDelta = vec2(p.x - lane, (p.y - horizon) * 3.2);
    float radius = impactAge * mix(0.18, 0.44, seed) * (0.72 + drive * 0.42);
    float ring = exp(-abs(length(waterDelta) - radius) * 115.0);
    float echo = exp(-abs(length(waterDelta) - radius * 0.58) * 150.0) * 0.42;
    rippleLight += (ring + echo) * (1.0 - impactAge) * densityGate * waterMask;
  }

  float waterNoise = noise2(vec2(p.x * 4.2 + uTime * 0.035, p.y * 18.0));
  float water = waterMask * (0.007 + waterNoise * 0.012) * drive;
  float horizonGlow = exp(-abs(p.y - horizon) * 90.0) * drive * 0.055;
  float impactBoost = 1.0 + max(uAccent.x, uWeather.y * 0.55) * 0.8;
  color += silver(rainLight + rippleLight * impactBoost * (0.28 + drive * 0.55), uMood.z * 0.35);
  color += silver(water + horizonGlow, 0.12);
  float cloud = fbm2(vec2(p.x * 0.72, p.y * 0.42 + uTime * 0.014));
  color += silver(cloud * 0.012 * drive * (0.35 + melancholy), 0.1);
  return color;
}

float orbMap(vec3 position) {
  position.xz = rot(uTime * mix(0.018, 0.13, uMood.y)) * position.xz;
  float radius = length(position);
  vec3 direction = position / max(radius, 0.001);
  float longitude = atan(direction.z, direction.x) / TAU + 0.5;
  float latitude = direction.y * 0.5 + 0.5;
  float spectrum = bandAt(fract(longitude * 0.74 + latitude * 0.26));
  float organic = sin(direction.x * 5.1 + uTime * 0.07) * sin(direction.y * 6.3 - uTime * 0.045);
  organic += sin(direction.z * 7.4 + direction.x * 2.7 + uTime * 0.035) * 0.52;
  organic *= 0.34;
  float deformation = organic * (0.055 + uMood.w * 0.085 + uMood.y * 0.07);
  deformation += spectrum * (0.025 + uMood.y * 0.12) * uSensitivity;
  deformation += uAccent.x * 0.035;
  return radius - (0.92 + deformation);
}

vec3 orbNormal(vec3 position) {
  float epsilon = 0.0035;
  float center = orbMap(position);
  return normalize(vec3(
    center - orbMap(position - vec3(epsilon, 0, 0)),
    center - orbMap(position - vec3(0, epsilon, 0)),
    center - orbMap(position - vec3(0, 0, epsilon))
  ));
}

vec3 renderCore(vec2 p) {
  vec3 ro = vec3(0.0, 0.0, 3.15);
  vec3 rd = normalize(vec3(p, -1.72));
  float travel = 0.0;
  float hit = 0.0;
  vec3 position = ro;
  for (int step = 0; step < 44; step++) {
    position = ro + rd * travel;
    float distanceToOrb = orbMap(position);
    if (distanceToOrb < 0.0025) { hit = 1.0; break; }
    travel += max(0.01, distanceToOrb * 0.64);
    if (travel > 6.0) break;
  }
  vec3 color = vec3(0.0);
  if (hit > 0.5) {
    vec3 normal = orbNormal(position);
    vec3 lightDir = normalize(vec3(-0.45, 0.7, 0.62));
    float diffuse = max(0.0, dot(normal, lightDir));
    float fresnel = pow(1.0 - max(0.0, dot(normal, -rd)), 2.15);
    float grain = noise3(position * 19.0 + uTime * 0.08);
    float shell = 0.055 + diffuse * 0.23 + fresnel * (0.44 + uMood.w * 0.18);
    shell += smoothstep(0.78, 1.0, grain) * (0.08 + uMood.y * 0.11);
    color = silver(shell, uMood.z * 0.48);
  }
  float radius = length(p);
  float atmosphere = exp(-abs(radius - 0.54) * 13.0) * (0.035 + uMood.x * 0.06 + uAccent.x * 0.08);
  float innerFog = exp(-radius * radius * 2.7) * 0.018 * (0.5 + uMood.w);
  color += silver(atmosphere + innerFog, 0.18);
  return color;
}

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= uResolution.x / max(uResolution.y, 1.0);
  vec3 color;
  if (uMode == 0) color = renderVeil(p);
  else if (uMode == 1) color = renderTerrain(p);
  else if (uMode == 2) color = renderRain(p, 0.14);
  else color = renderCore(p);
  if (uMode != 2 && rainTrigger() > 0.008) color += renderRain(p, 0.0) * 0.72;

  float vignette = smoothstep(1.42, 0.22, length(p * vec2(0.72, 1.0)));
  color *= 0.54 + vignette * 0.72;
  color *= 1.32;
  color = color / (1.0 + color);
  color = pow(color, vec3(0.86));
  float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(color + dither, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${log}`);
  }
  return shader;
}

export function createVisualLabGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('当前设备不支持 WebGL2');

  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(program)}`);

  const vao = gl.createVertexArray();
  const uniform = name => gl.getUniformLocation(program, name);
  const uniforms = {
    resolution: uniform('uResolution'),
    time: uniform('uTime'),
    bandsA: uniform('uBandsA'),
    bandsB: uniform('uBandsB'),
    mood: uniform('uMood'),
    accent: uniform('uAccent'),
    weather: uniform('uWeather'),
    sensitivity: uniform('uSensitivity'),
    mode: uniform('uMode'),
  };

  gl.useProgram(program);
  gl.bindVertexArray(vao);
  gl.clearColor(0.025, 0.028, 0.034, 1);

  function resize(width, height, dpr) {
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      gl.viewport(0, 0, pixelWidth, pixelHeight);
    }
  }

  function frame(data) {
    const bands = data.bands;
    const mood = data.mood;
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, data.time);
    gl.uniform4f(uniforms.bandsA, bands[0], bands[1], bands[2], bands[3]);
    gl.uniform4f(uniforms.bandsB, bands[4], bands[5], bands[6], bands[7]);
    gl.uniform4f(uniforms.mood, mood.intensity, mood.activity, mood.brightness, mood.melancholy);
    gl.uniform4f(uniforms.accent, data.hit, data.hitHigh, data.onset, data.onsetHigh);
    gl.uniform4f(uniforms.weather, mood.warmth, mood.hitDensity, mood.calm, data.playing ? 1 : 0);
    gl.uniform1f(uniforms.sensitivity, data.sensitivity);
    gl.uniform1i(uniforms.mode, MODE_INDEX[data.mode] ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    resize,
    frame,
    dispose() {
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
