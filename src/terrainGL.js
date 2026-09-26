// GPU 版「声波地形」——逐行移植 Sonic Topography 的地形着色器。
//
// 为什么要单独一个 WebGL 画布：对方是 155x155 = 24025 个实例化立方体，每帧在顶点
// 着色器里做顶点位移。Canvas 2D 一个立方体要 3~5 次 path 填充，2.4 万个一帧根本画不完，
// 所以这套效果只能用 GPU 实例化 + 单次 draw call 来做。这里用原生 WebGL2，
// 不引入 three.js——我们只需要一个盒子几何体 + 一对着色器，没必要背一个渲染引擎。
//
// 移植来源（SonicTopography 1.1.1 生产包 app.asar/dist/assets/index-Dz94TLyR.js）：
//   · 顶点/片元着色器：高度模型、simplex 噪声、噪声门、区域划分、配色流程
//   · TERRAIN_BASE_SIZE=168 / 密度→网格 / boxWidth = spacing*(0.9/1.05)
//   · 相机 position(-37.58, 25.72, 92.26) lookAt(0,0,0) fov 45
//   · 频段划分 8 段 + 默认 EQ [90,92,50,50,50,50,50,48]
//   · terrainResponse：Kick 包络混入低频两段
// 颜色主题：按用户站点整体灰阶，默认用 minimal-monochrome；改成 'nocturnal' 就是对方默认外观。

const TERRAIN_SIZE = 168;

// 5 套主题，取自他们的 production bundle
export const TERRAIN_THEMES = {
  'minimal-monochrome': {
    // 与 #101113 拉开一点明度，未播放时也能看见完整棋盘；画布透明度仍由 CSS 控制。
    base1: [0.035, 0.035, 0.038], base2: [0.12, 0.12, 0.13], fog: [0.02, 0.02, 0.022],
    coolCore: [0.9, 0.9, 0.9], coolEdge: [0.4, 0.4, 0.4],
    warmCore: [1, 1, 1], warmEdge: [0.7, 0.7, 0.7],
    ripple: [1, 1, 1], glow: 0.8
  },
  'ink-wash': {
    base1: [1, 1, 1], base2: [1, 1, 1], fog: [1, 1, 1],
    coolCore: [0, 0, 0], coolEdge: [0.35, 0.35, 0.35],
    warmCore: [0, 0, 0], warmEdge: [0.35, 0.35, 0.35],
    ripple: [0.66, 0.74, 0.76], glow: 1.1
  },
  nocturnal: {
    base1: [0.01, 0.02, 0.04], base2: [0.03, 0.05, 0.09], fog: [0.01, 0.02, 0.04],
    coolCore: [0, 0.3, 1], coolEdge: [0.6, 0.2, 1],
    warmCore: [1, 0.2, 0.1], warmEdge: [1, 0.6, 0],
    ripple: [0.2, 0.9, 1], glow: 1
  },
  'neon-tokyo': {
    base1: [0.01, 0.005, 0.02], base2: [0.04, 0.01, 0.06], fog: [0.01, 0.005, 0.02],
    coolCore: [1, 0.1, 0.6], coolEdge: [0.6, 0.1, 1],
    warmCore: [0.1, 1, 0.8], warmEdge: [0.1, 0.4, 1],
    ripple: [1, 1, 1], glow: 1.5
  },
  'cyber-forest': {
    base1: [0.01, 0.02, 0.01], base2: [0.02, 0.05, 0.02], fog: [0.01, 0.02, 0.01],
    coolCore: [0.1, 1, 0.5], coolEdge: [0.05, 0.5, 0.3],
    warmCore: [0.8, 1, 0.1], warmEdge: [0.9, 0.5, 0.1],
    ripple: [0.6, 1, 0.3], glow: 1.3
  }
};

// 默认 EQ 推子，和对方一致：低频两段给到 90/92，地形主要靠低频撑起来
const DEFAULT_EQ = [90, 92, 50, 50, 50, 50, 50, 48];
// 对方把 kick 直接灌进低频两段，纯频谱能量上升太慢，鼓落地那一刻顶不起来
const MAX_KICK_DEFORM = 0.75;
const KICK_SUB_BASS_GAIN = 1.28;
const KICK_BASS_GAIN = 1.15;
const BASE_SUB_BASS_GAIN = 0.22;
const BASE_BASS_GAIN = 0.2;
const MAX_SHADER_SUB_BASS = 1.2;
const MAX_SHADER_BASS = 1.15;
const MAX_RIPPLES = 10;

const VERT = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uSubBass;
uniform float uBass;
uniform float uLowMid;
uniform float uMid;
uniform float uHighMid;
uniform float uSmoothness;
uniform float uDensity;
uniform float uEnergy;
uniform float uAmplitude;
uniform float uYOffset;   // 整片地形在画面里整体上移的世界单位
uniform vec4 uRipples[10];     // xz = 圆心, z = 起始时间, w = 强度
uniform vec2 uRippleMeta[10];  // x = isActive, y = rippleType
uniform float uGridSize;
uniform float uSpacing;
uniform float uBoxWidth;
uniform mat4 uProjection;
uniform mat4 uView;

in vec3 aPosition;
in vec3 aNormal;
in vec2 aUv;

out vec2 vUv;
out float vElevation;
out float vDistance;
out vec2 vRippleAnim;
out vec3 vNormal;
out float vRelativeY;
out vec2 vInstancePos;
out float vInstanceRandom;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy) );
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1; i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m ; m = m*m ;
  vec3 x = 2.0 * fract(p * C.www) - 1.0; vec3 h = abs(x) - 0.5; vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox; m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
  vec3 g; g.x = a0.x * x0.x + h.x * x0.y; g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
}

void main() {
  vUv = aUv;
  vNormal = aNormal;

  // 规则网格不需要实例缓冲：直接用 gl_InstanceID 反推这颗方块所在的格子和世界坐标
  int gs = int(uGridSize);
  float gx = float(gl_InstanceID % gs);
  float gz = float(gl_InstanceID / gs);
  float halfSpan = uGridSize * uSpacing * 0.5;
  vec2 pos2D = vec2(gx, gz) * uSpacing - vec2(halfSpan);
  vInstancePos = pos2D;

  float centerDist = length(pos2D);
  vDistance = centerDist;
  float rnd = random(pos2D);
  vInstanceRandom = rnd;

  // 原作的静止海面：噪声和缓慢波形混合，保证静音时仍有呼吸感。
  vec2 movingPos = pos2D * 0.05 + vec2(uTime * 0.1, uTime * 0.05);
  float baseNoise = (snoise(movingPos) + 1.0) * 0.5;
  float wave = sin(pos2D.x * 0.15 + pos2D.y * 0.1 - uTime * 0.6) * 0.5 + 0.5;
  float globalFalloff = smoothstep(60.0, 30.0, centerDist);
  float idleElevation = mix(baseNoise, wave, uSmoothness * 0.5 + 0.2) * 0.8 * globalFalloff;

  // 与 Sonic Topography 一致的频段地形：中心低频、块状 Bass、流动中频和离散高频尖柱。
  float subRegion = smoothstep(25.0, 0.0, centerDist);
  float subLift = uSubBass * subRegion * 5.0;

  float bassNoise = snoise(pos2D * 0.1 - vec2(0.0, uTime * 0.2));
  float bassRegion = smoothstep(35.0, 5.0, centerDist + bassNoise * 5.0);
  float bassLift = uBass * bassRegion * smoothstep(0.0, 1.0, rnd + uDensity * 0.5) * 4.0;

  float lowMidNoise = snoise(pos2D * 0.05 + vec2(uTime * 0.1, 0.0));
  float lowMidLift = uLowMid * (lowMidNoise * 0.5 + 0.5) * 2.5;

  float riverFlow = sin(pos2D.x * 0.2 + pos2D.y * 0.2 + snoise(pos2D * 0.1) * 2.0 - uTime * 2.0);
  float midLift = uMid * max(0.0, riverFlow) * 3.0;

  float highMidRegion = smoothstep(10.0, 45.0, centerDist);
  float highMidLift = 0.0;
  if (fract(rnd * 13.3) > 0.8) {
    highMidLift = uHighMid * highMidRegion * fract(rnd * 7.7) * 2.5;
  }

  float audioElevation = subLift + bassLift + lowMidLift + midLift + highMidLift;
  if (rnd > 0.99) audioElevation += uEnergy * 5.0;
  audioElevation *= globalFalloff;
  audioElevation = max(0.0, audioElevation - 0.2) * uAmplitude;

  float elevation = idleElevation + audioElevation;

  // 水波纹：高斯波前 + 行进距离衰减
  float rippleElevation = 0.0;
  float rippleIntensityNormal = 0.0;
  float rippleIntensityWhite = 0.0;
  for (int i = 0; i < 10; i++) {
    if (uRippleMeta[i].x > 0.0) {
      float dist = length(pos2D - uRipples[i].xy);
      float timeSince = uTime - uRipples[i].z;
      float curSpeed = 15.0;
      float curWidth = 3.0;
      float curFadeDist = 15.0;
      float elevationScale = 4.0;
      if (uRippleMeta[i].y > 0.5) {
        curSpeed = 20.0;
        curWidth = 1.0;
        curFadeDist = 8.0;
        elevationScale = 1.0;
      }
      float waveRadius = timeSince * curSpeed;
      float d = dist - waveRadius;
      float rippleWave = exp(-d*d / curWidth);
      float fade = exp(-waveRadius / curFadeDist);
      float rPulse = rippleWave * fade * uRipples[i].w;
      rippleElevation += rPulse * elevationScale;
      if (uRippleMeta[i].y > 0.5) {
        rippleIntensityWhite += rPulse;
      } else {
        rippleIntensityNormal += rPulse;
      }
    }
  }

  elevation += rippleElevation;
  vRippleAnim = vec2(clamp(rippleIntensityNormal, 0.0, 1.0), clamp(rippleIntensityWhite, 0.0, 1.0));
  vElevation = elevation;

  float yPos = aPosition.y + 0.5;
  vRelativeY = yPos;
  float totalHeight = 1.0 + elevation;

  // 等价于 instanceMatrix = T(pos2D) * S(boxWidth, 1, boxWidth)，modelMatrix 为单位阵
  vec3 world = vec3(
    pos2D.x + aPosition.x * uBoxWidth,
    -0.5 + yPos * totalHeight + uYOffset,
    pos2D.y + aPosition.z * uBoxWidth
  );
  gl_Position = uProjection * uView * vec4(world, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uPresence;
uniform float uBrilliance;
uniform float uAir;
uniform float uWarmth;
uniform float uBrightness;
uniform float uSharpness;
uniform vec3 uBaseColor1;
uniform vec3 uBaseColor2;
uniform vec3 uFogColor;
uniform vec3 uCoolCore;
uniform vec3 uCoolEdge;
uniform vec3 uWarmCore;
uniform vec3 uWarmEdge;
uniform vec3 uRippleColor;
uniform float uGlowIntensity;

in vec2 vUv;
in float vElevation;
in float vDistance;
in vec2 vRippleAnim;
in vec3 vNormal;
in float vRelativeY;
in vec2 vInstancePos;
in float vInstanceRandom;

out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
}

void main() {
  bool isTop = vNormal.y > 0.5;
  float distFromTop = 1.0 - vRelativeY;
  float rnd = vInstanceRandom;
  float centerDist = length(vInstancePos);
  float normElevation = clamp(vElevation / 8.0, 0.0, 1.0);

  vec3 cBase1 = uBaseColor1;
  vec3 cBase2 = uBaseColor2;
  vec3 coolCore = uCoolCore;
  vec3 coolEdge = uCoolEdge;
  vec3 warmCore = uWarmCore;
  vec3 warmEdge = uWarmEdge;

  float warmBlend = smoothstep(0.0, 1.0, uWarmth * 1.5 + (0.5 - centerDist / 80.0));
  vec3 zoneCore = mix(coolCore, warmCore, warmBlend);
  vec3 zoneEdge = mix(coolEdge, warmEdge, warmBlend);
  vec3 targetGlow = mix(zoneCore, zoneEdge, fract(rnd * 11.0));

  float distFade = 1.0 - smoothstep(40.0, 75.0, centerDist);
  vec3 brightCool = mix(coolCore, vec3(1.0), 0.24);
  targetGlow = mix(targetGlow, brightCool, uBrightness * 0.6);
  vec3 currentGlow = mix(cBase2, targetGlow, normElevation) * uGlowIntensity * distFade;
  currentGlow = mix(currentGlow, uRippleColor, vRippleAnim.x);
  currentGlow = mix(currentGlow, vec3(1.0), vRippleAnim.y);

  vec3 bodyColor = mix(cBase1, cBase2, vRelativeY * distFade);
  vec3 finalColor;

  if (isTop) {
    float topIntensity = smoothstep(0.0, 0.4, normElevation);
    float twinkleDistFalloff = smoothstep(60.0, 30.0, centerDist);
    float twinkleMultiplier = mix(twinkleDistFalloff, 1.0, smoothstep(0.01, 0.1, normElevation));

    bool isSparkleTarget = fract(rnd * 31.0) > 0.95;
    if (isSparkleTarget && normElevation < 0.1) {
      topIntensity += uAir * 2.0 * twinkleMultiplier;
    }

    finalColor = mix(cBase2, currentGlow, topIntensity);
    float edgeX = smoothstep(0.05, 0.01, vUv.x) + smoothstep(0.95, 0.99, vUv.x);
    float edgeY = smoothstep(0.05, 0.01, vUv.y) + smoothstep(0.95, 0.99, vUv.y);
    float edge = min(edgeX + edgeY, 1.0);
    finalColor += currentGlow * edge * 0.8 * (topIntensity + 0.3);

    float flashChance = smoothstep(0.3, 1.0, uPresence);
    if (fract(rnd * 53.0) > 0.98 - flashChance * 0.1) {
      float flashSync = sin(uTime * 40.0 + rnd * 100.0) * 0.5 + 0.5;
      finalColor += mix(vec3(1.0), vec3(0.5, 1.0, 1.0), rnd) * flashSync * uPresence * (1.0 + uSharpness * 2.0) * twinkleMultiplier;
    }

    if (edge > 0.5 && fract(rnd * 89.0 + uTime * 2.0) > 0.98) {
      finalColor += vec3(1.0) * uBrilliance * 3.0 * twinkleMultiplier;
    }
  } else {
    float verticalFalloff = mix(1.0, 3.0, uSharpness);
    float sideGlow = smoothstep(0.5 / verticalFalloff, 0.0, distFromTop) * normElevation;
    if (normElevation < 0.02) sideGlow = 0.0;
    finalColor = mix(bodyColor, currentGlow, sideGlow * 1.5);
    float rimGlow = smoothstep(0.03, 0.0, distFromTop) * normElevation;
    finalColor += currentGlow * rimGlow;
  }

  finalColor += uRippleColor * vRippleAnim.x * 0.6;
  finalColor += vec3(1.0) * vRippleAnim.y * 1.2;

  // 空气透视
  float aerialFog = smoothstep(30.0, 65.0, vDistance);
  vec3 atmosphericColor = mix(cBase1, cBase2, 0.4);
  finalColor = mix(finalColor, atmosphericColor, aerialFog * 0.35);

  // 远处淡出到画布背景色，透明度让站点背景透出来
  float alphaFade = 1.0 - smoothstep(55.0, 78.0, vDistance);
  float alphaBlend = 1.0 - alphaFade;
  finalColor = mix(finalColor, uFogColor, alphaBlend * 0.45);
  fragColor = vec4(finalColor, alphaFade);
}
`;

// ---------- 单位立方体（-0.5~0.5），每面独立 uv ----------
// 六个面按「从外侧看逆时针」排列，这样 +Y 面在 vRelativeY 插值上才有正确的上下梯度，
// 边缘描边也才不会歪。positions / normals / uvs / indices
function buildBox() {
  const faces = [
    { n: [1, 0, 0], v: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { n: [-1, 0, 0], v: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, 1, 0], v: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, -1, 0], v: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
    { n: [0, 0, 1], v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { n: [0, 0, -1], v: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] }
  ];
  const uvList = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  faces.forEach((face, fi) => {
    face.v.forEach((p, vi) => {
      positions.push(p[0], p[1], p[2]);
      normals.push(face.n[0], face.n[1], face.n[2]);
      uvs.push(uvList[vi][0], uvList[vi][1]);
    });
    const b = fi * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices)
  };
}

// ---------- 最小 mat4 工具（避免引入 gl-matrix）----------
function perspective(out, fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
  out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
  return out;
}

function lookAt(out, eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

// 频段边界的 bin 索引（对方在 44.1k / fftSize 1024 下的切法是 1/3/7/18/46/93/186/372，
// 换算成 Hz 上界约 86/172/344/818/2024/4073/8078/16086）。这里按 Hz 反推，采样率不同也不错位。
const BAND_EDGES_HZ = [86.1, 172.3, 344.5, 818.3, 2024.3, 4072.6, 8077.9, 16086];

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// EQ 推子映射：往上乘性放大；往下先削底噪再整体压暗
function applyEq(value, eq) {
  const delta = (eq - 50) / 50;
  if (delta >= 0) return clamp01(value * (1 + delta * 1.8));
  const d = Math.abs(delta);
  return clamp01(Math.max(0, value - d * 0.35) * (1 - d * 0.35));
}

function applyLowBand(value, eq, max) {
  const delta = (eq - 50) / 50;
  const v = delta >= 0
    ? value * (1 + delta * 1.8)
    : Math.max(0, value - Math.abs(delta) * 0.35) * (1 - Math.abs(delta) * 0.35);
  return v < 0 ? 0 : v > max ? max : v;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('shader compile failed: ' + log);
  }
  return shader;
}

export function createTerrainGL(canvas, options = {}) {
  const theme = TERRAIN_THEMES[options.theme] || TERRAIN_THEMES['minimal-monochrome'];
  const mobile = !!options.mobile;
  // 移动端 GPU 弱，网格砍到 110（12100 个方块），桌面保持对方的 155（24025 个）
  const gridSize = options.gridSize || (mobile ? 110 : 155);
  const spacing = TERRAIN_SIZE / gridSize;
  const boxWidth = spacing * (0.9 / 1.05);

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: !mobile,
    premultipliedAlpha: false,
    powerPreference: 'high-performance'
  });
  if (!gl) return null;

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('program link failed: ' + gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  const box = buildBox();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const bind = (name, data, size) => {
    const loc = gl.getAttribLocation(program, name);
    if (loc < 0) return;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  bind('aPosition', box.positions, 3);
  bind('aNormal', box.normals, 3);
  bind('aUv', box.uvs, 2);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, box.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  const U = {};
  const uniformNames = [
    'uTime', 'uSubBass', 'uBass', 'uLowMid', 'uMid', 'uHighMid',
    'uPresence', 'uBrilliance', 'uAir', 'uWarmth', 'uBrightness', 'uSharpness',
    'uSmoothness', 'uDensity', 'uSpectralCentroid', 'uEnergy', 'uAmplitude',
    'uBaseColor1', 'uBaseColor2', 'uFogColor', 'uCoolCore', 'uCoolEdge',
    'uWarmCore', 'uWarmEdge', 'uRippleColor', 'uGlowIntensity',
    'uGridSize', 'uSpacing', 'uBoxWidth', 'uProjection', 'uView', 'uYOffset'
  ];
  uniformNames.forEach(n => { U[n] = gl.getUniformLocation(program, n); });
  U.uRipples = gl.getUniformLocation(program, 'uRipples[0]');
  U.uRippleMeta = gl.getUniformLocation(program, 'uRippleMeta[0]');

  // 静态 uniform：主题色与网格尺寸只设置一次
  gl.uniform3fv(U.uBaseColor1, theme.base1);
  gl.uniform3fv(U.uBaseColor2, theme.base2);
  gl.uniform3fv(U.uFogColor, theme.fog);
  gl.uniform3fv(U.uCoolCore, theme.coolCore);
  gl.uniform3fv(U.uCoolEdge, theme.coolEdge);
  gl.uniform3fv(U.uWarmCore, theme.warmCore);
  gl.uniform3fv(U.uWarmEdge, theme.warmEdge);
  gl.uniform3fv(U.uRippleColor, theme.ripple);
  gl.uniform1f(U.uGlowIntensity, theme.glow);
  gl.uniform1f(U.uGridSize, gridSize);
  gl.uniform1f(U.uSpacing, spacing);
  gl.uniform1f(U.uBoxWidth, boxWidth);
  // 0 = 地面贴底；需要整体浮动效果时可以给 options.heightOffset 传正值
  gl.uniform1f(U.uYOffset, options.heightOffset ?? 0);
  if (U.uSpectralCentroid) gl.uniform1f(U.uSpectralCentroid, 0.2);

  const projection = new Float32Array(16);
  const view = new Float32Array(16);
  // 保留原作的距离和俯视角，只把 X 偏移归零，使地形在播放器中保持居中。
  const eye = mobile ? [0, 25.72, 99.62] : [0, 25.718921, 99.618];
  lookAt(view, eye, [0, 0, 0], [0, 1, 0]);
  gl.uniformMatrix4fv(U.uView, false, view);

  const rippleData = new Float32Array(MAX_RIPPLES * 4);   // x, z, 起始时间, 强度
  const rippleMeta = new Float32Array(MAX_RIPPLES * 2);   // isActive, rippleType
  let rippleCursor = 0;
  let lastRippleTime = -99;

  // 每段的平滑值 / 上一帧频谱（算频谱通量用）
  const smooth = new Float32Array(8);
  const smoothTarget = new Float32Array(8);
  const rawBands = new Float32Array(8);   // 每帧复用，别在 frame 里新建
  let prevBins = new Float32Array(1024);
  let kick = 0;
  let prevBrightness = 0;
  let aspect = 0;   // 0 而不是 1：保证首帧 resize 一定会算出投影矩阵（正方形视口 aspect 正好是 1 时也不会漏）
  let pendingTime = 0;

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  function addRipple(x, z, strength, type) {
    const slot = rippleCursor % MAX_RIPPLES;
    rippleCursor += 1;
    rippleData[slot * 4] = x;
    rippleData[slot * 4 + 1] = z;
    rippleData[slot * 4 + 2] = pendingTime;
    rippleData[slot * 4 + 3] = strength;
    rippleMeta[slot * 2] = 1;
    rippleMeta[slot * 2 + 1] = type ? 1 : 0;
  }

  function resize(width, height, dpr) {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const nextAspect = w / Math.max(1, h);
    if (nextAspect !== aspect) {
      aspect = nextAspect;
      perspective(projection, 45 * Math.PI / 180, aspect, 0.1, 2000);
      gl.uniformMatrix4fv(U.uProjection, false, projection);
    }
    gl.viewport(0, 0, w, h);
  }

  // frame 数据：{ time, bins, sampleRate, energy, kickEnvelope, onset, onsetHigh, playing }
  function frame(input) {
    pendingTime = input.time;
    const bins = input.bins;
    const binCount = bins ? bins.length : 0;
    const binHz = (input.sampleRate || 44100) / (binCount * 2 || 1024);

    // --- 8 段能量 ---
    const raw = rawBands;
    raw.fill(0);
    if (input.playing && binCount) {
      let from = 0;
      for (let i = 0; i < 8; i += 1) {
        const to = Math.min(binCount, Math.max(from + 1, Math.round(BAND_EDGES_HZ[i] / binHz)));
        let sum = 0;
        for (let k = from; k < to; k += 1) sum += bins[k];
        raw[i] = clamp01(sum / (to - from) / 255);
        from = to;
      }
    }

    // BeatEngine 已提供快起慢落的低频包络。高频 onset 不再灌进低频地形，
    // 否则军鼓和镲也会把中心整片顶起，与原作的频段分工不一致。
    const onset = input.onset || 0;
    kick = input.playing ? Math.min(MAX_KICK_DEFORM, Math.max(0, input.kickEnvelope || 0)) : 0;
    const kickNorm = kick / MAX_KICK_DEFORM;

    // --- 低频两段混入 kick（terrainResponse.deriveKickFollowLowBands）---
    const sub = Math.min(MAX_SHADER_SUB_BASS,
      applyLowBand(raw[0] * BASE_SUB_BASS_GAIN + kickNorm * KICK_SUB_BASS_GAIN, DEFAULT_EQ[0], MAX_SHADER_SUB_BASS));
    const bass = Math.min(MAX_SHADER_BASS,
      applyLowBand(raw[1] * BASE_BASS_GAIN + kickNorm * KICK_BASS_GAIN, DEFAULT_EQ[1], MAX_SHADER_BASS));
    const lowMid = applyEq(raw[2], DEFAULT_EQ[2]);
    const mid = applyEq(raw[3], DEFAULT_EQ[3]);
    const highMid = applyEq(raw[4], DEFAULT_EQ[4]);
    const presence = applyEq(raw[5], DEFAULT_EQ[5]);
    const brilliance = applyEq(raw[6], DEFAULT_EQ[6]);
    const air = applyEq(raw[7], DEFAULT_EQ[7]);

    // 快起慢落，帧率无关（对方用 responseRate = lerp(2.2,60,motionSpeed/100)）
    const rate = 12;
    const blend = 1 - Math.exp(-rate * (input.dt || 0.0167));
    const target = smoothTarget;
    target[0] = sub; target[1] = bass; target[2] = lowMid; target[3] = mid;
    target[4] = highMid; target[5] = presence; target[6] = brilliance; target[7] = air;
    for (let i = 0; i < 8; i += 1) {
      smooth[i] += (target[i] - smooth[i]) * (target[i] > smooth[i] ? Math.min(1, blend * 2.2) : blend);
    }

    // --- 派生音色量 ---
    const lowSum = smooth[0] + smooth[1] + smooth[2] + smooth[3];
    const highSum = smooth[4] + smooth[5] + smooth[6] + smooth[7];
    const total = lowSum + highSum;
    const warmth = total > 0.001 ? clamp01(lowSum / total) : 0;
    const brightness = total > 0.001 ? clamp01(highSum / total) : 0;
    const sharpness = Math.max(0, brightness - prevBrightness) * 10;
    prevBrightness = brightness;

    // 频谱通量 / 活跃段数 → smoothness / density
    // prevBins 按实际 bin 数分配：写死 1024 的话，fftSize 更大时会越界读到 undefined 变成 NaN
    if (prevBins.length < binCount) prevBins = new Float32Array(binCount);
    let jump = 0;
    for (let i = 0; i < binCount; i += 1) {
      const v = (input.playing ? bins[i] / 255 : 0);
      jump += Math.abs(v - prevBins[i]);
      prevBins[i] = v;
    }
    const smoothness = binCount ? Math.max(0, 1 - (jump / binCount) * 2) : 1;
    let active = 0;
    for (let i = 0; i < 8; i += 1) if (smooth[i] > 0.05) active += 1;
    const density = active / 8;

    // --- 重拍放水波；留 1.1 秒间隔，密集鼓组里不会一圈叠一圈 ---
    if (input.playing && onset > 0.48 && input.time - lastRippleTime > 0.9) {
      lastRippleTime = input.time;
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 20;
      addRipple(Math.cos(angle) * radius, Math.sin(angle) * radius, Math.min(onset * 2, 2), 0);
    }
    // 清掉过期的水波
    for (let i = 0; i < MAX_RIPPLES; i += 1) {
      if (rippleMeta[i * 2] > 0 && input.time - rippleData[i * 4 + 2] > 6) {
        rippleMeta[i * 2] = 0;
      }
    }

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform1f(U.uTime, input.time);
    gl.uniform1f(U.uSubBass, smooth[0]);
    gl.uniform1f(U.uBass, smooth[1]);
    gl.uniform1f(U.uLowMid, smooth[2]);
    gl.uniform1f(U.uMid, smooth[3]);
    gl.uniform1f(U.uHighMid, smooth[4]);
    gl.uniform1f(U.uPresence, smooth[5]);
    gl.uniform1f(U.uBrilliance, smooth[6]);
    gl.uniform1f(U.uAir, smooth[7]);
    gl.uniform1f(U.uWarmth, warmth);
    gl.uniform1f(U.uBrightness, brightness);
    gl.uniform1f(U.uSharpness, sharpness);
    gl.uniform1f(U.uSmoothness, smoothness);
    gl.uniform1f(U.uDensity, density);
    gl.uniform1f(U.uEnergy, clamp01(input.energy || 0));
    gl.uniform1f(U.uAmplitude, options.amplitude || 1);
    gl.uniform4fv(U.uRipples, rippleData);
    gl.uniform2fv(U.uRippleMeta, rippleMeta);

    gl.bindVertexArray(vao);
    gl.drawElementsInstanced(gl.TRIANGLES, box.indices.length, gl.UNSIGNED_SHORT, 0, gridSize * gridSize);
    gl.bindVertexArray(null);
  }

  return {
    resize,
    frame,
    instanceCount: gridSize * gridSize,
    dispose() {
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    }
  };
}
