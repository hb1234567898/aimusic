// 低频 / 鼓点检测引擎。
//
// 手机上「律动对不上鼓点」其实是好几个问题叠在一起，这里逐个拆开处理：
//
// 1) 采样太粗。原来检测链和地形共用 fftSize=1024 的那一路 analyser，44.1kHz 下
//    每个 bin 是 43Hz，150Hz 以下只有 3 个 bin —— 底鼓基频（50~120Hz）根本分辨不出来，
//    只表现为「低频整体变响」，于是判定出来的点漂移得厉害。
//    现在检测单独走一路：AudioWorklet 直接在音频线程上做滤波+包络，没有 bin 的概念。
//
// 2) 频谱被平滑。smoothingTimeConstant 会把鼓点的起振沿抹平（0.25 在 60fps 下等效几十毫秒），
//    起振沿正是判定「这一下是不是一拍」的全部信息。检测链上一律不用平滑。
//
// 3) 采样时机。rAF 只有 30~60Hz，一帧错过起振点就整拍丢失，低端安卓掉到 20fps 时尤其明显。
//    AudioWorklet 每 3 个 render quantum（约 8ms）上报一次能量并在音频线程算 onset，
//    主线程只取结果，不再受帧率牵制。不支持 AudioWorklet 的内核退回高分辨率 AnalyserNode。
//
// 4) 画面比声音早。Web Audio 的输出缓冲让「看到的」早于「听到的」，安卓 AudioTrack 常见
//    100~300ms。这里用 outputLatency 把整条可视化链延后，让画面和耳朵对齐；
//    蓝牙 A2DP 还有一段 Web Audio 不知道的延迟，留一个手动校准量给用户微调。
//
// 5) 只有底鼓会动，律动就稀。低频走 30~170Hz 一条链，高频（1.8kHz 以上，军鼓和镲）
//    单独走一条，两条各自判定、各自出强度。画面就能把「砸下来的鼓」和「碎拍的镲」分开展示。

const PROBE_SOURCE = `
class OrbitBassProbe extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const dt = 1 / sampleRate;
    const rc = f => 1 / (2 * Math.PI * f);
    const lowRc = rc(opts.cutoff || 170);      // 底鼓 / 贝斯基频上限
    const rumbleRc = rc(opts.rumble || 30);    // 掐掉直流和次声
    const trebleRc = rc(opts.treble || 1800);  // 高频分支的分界
    this.lpA = dt / (lowRc + dt);
    this.hpA = rumbleRc / (rumbleRc + dt);
    this.trebleA = trebleRc / (trebleRc + dt);
    this.lp = 0;
    this.hp = 0;
    this.prevLp = 0;
    this.lpTreble = 0;
    this.acc = [0, 0];
    this.blocks = 0;
    this.reportEvery = opts.reportEvery || 3;   // 3 * 128 样本 ≈ 8ms @48k
    this.prevRms = [0, 0];
    this.hist = [new Float32Array(56), new Float32Array(56)];
    this.histAt = [0, 0];
    this.histLen = [0, 0];
    this.lastHit = [-1, -1];
    // 低频不应期略长（防止一个鼓点被切成两下），高频可以更短（密集的镲才跟得上）
    this.refract = [opts.refract || 0.085, opts.refractHigh || 0.055];
    // 高频段噪声本底更抖，阈值给得比低频严一点
    this.sensitivity = [1.25, 1.7];
    this.floor = [1e-6, 4e-5];
  }

  // 只看「突增」（正 flux），与最近约 0.5s 的均值+方差比较：
  // 持续的低音不会一直被判成节拍，突然砸下来的那一下才会。
  onset(band, rms, t) {
    const flux = Math.max(0, rms - this.prevRms[band]);
    this.prevRms[band] = rms;
    const hist = this.hist[band];
    const len = this.histLen[band];
    let mean = 0;
    for (let i = 0; i < len; i += 1) mean += hist[i];
    mean = len ? mean / len : flux;
    let variance = 0;
    for (let i = 0; i < len; i += 1) {
      const d = hist[i] - mean;
      variance += d * d;
    }
    const std = Math.sqrt(len ? variance / len : 0);
    hist[this.histAt[band]] = flux;
    this.histAt[band] = (this.histAt[band] + 1) % hist.length;
    if (len < hist.length) this.histLen[band] = len + 1;
    if (flux <= mean + std * this.sensitivity[band] + this.floor[band]) return 0;
    if (t - this.lastHit[band] <= this.refract[band]) return 0;
    this.lastHit[band] = t;
    // 强度按「超出阈值多少」归一化，重拍和轻拍能分开
    return 0.45 + Math.min(1, (flux - mean) / (std * 2.0 + mean * 1.4 + 1e-6)) * 0.55;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const channels = input.length;
    const length = input[0].length;
    let lp = this.lp;
    let hp = this.hp;
    let prevLp = this.prevLp;
    let lpTreble = this.lpTreble;
    let accLow = 0;
    let accHigh = 0;
    for (let i = 0; i < length; i += 1) {
      let sample = 0;
      for (let c = 0; c < channels; c += 1) sample += input[c][i];
      sample /= channels;
      lp += this.lpA * (sample - lp);
      hp = this.hpA * (hp + lp - prevLp);
      prevLp = lp;
      lpTreble += this.trebleA * (sample - lpTreble);
      const treble = sample - lpTreble;
      accLow += hp * hp;
      accHigh += treble * treble;
    }
    this.lp = lp;
    this.hp = hp;
    this.prevLp = prevLp;
    this.lpTreble = lpTreble;
    this.acc[0] += accLow / length;
    this.acc[1] += accHigh / length;
    this.blocks += 1;
    if (this.blocks < this.reportEvery) return true;

    const rms = Math.sqrt(this.acc[0] / this.blocks);
    const rmsHigh = Math.sqrt(this.acc[1] / this.blocks);
    this.acc[0] = 0;
    this.acc[1] = 0;
    this.blocks = 0;
    const t = currentTime;
    this.port.postMessage({
      t: t,
      rms: rms,
      rmsHigh: rmsHigh,
      hit: this.onset(0, rms, t),
      hitHigh: this.onset(1, rmsHigh, t)
    });
    return true;
  }
}
registerProcessor('orbit-bass-probe', OrbitBassProbe);
`;

// AnalyserNode 兜底时的两个频段边界（Hz）
const FALLBACK_BANDS = [[32, 165], [1800, 9000]];

let probeUrlPromise = null;
function probeModuleUrl() {
  if (probeUrlPromise) return probeUrlPromise;
  probeUrlPromise = Promise.resolve(URL.createObjectURL(new Blob([PROBE_SOURCE], { type: 'text/javascript' })));
  return probeUrlPromise;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class BeatEngine {
  constructor(context, source, { lowLatency = false, onMode = null } = {}) {
    this.context = context;
    this.source = source;
    this.lowLatency = lowLatency;
    this.onMode = onMode;

    this.mode = 'none';        // worklet | analyser | none
    this.node = null;
    this.silent = null;
    this.analyser = null;
    this.bins = null;
    this.binRange = [[1, 4], [40, 200]];

    // 宽频能量（整首歌的响度，用来做底色呼吸）
    this.wide = context.createAnalyser();
    this.wide.fftSize = 256;
    this.wide.smoothingTimeConstant = lowLatency ? 0.25 : 0.55;
    this.wideBins = new Uint8Array(this.wide.frequencyBinCount);
    source.connect(this.wide);

    // 音频线程上报的能量流 + 节拍事件，延后 outputLatency 之后再给画面用
    this.stream = [];
    this.events = [];
    this.pendingHit = 0;
    this.pendingHigh = 0;

    this.autoLatency = 0;
    this.latency = 0;          // 当前实际使用的补偿量，歌词对位也要跟着走
    this.manualOffset = 0;     // 秒，正数 = 画面再晚一点（蓝牙场景常用）

    // 两条链各自一套：峰值跟随（自动增益）、当前归一化电平、打击包络
    this.peak = [0.02, 0.004];
    this.level = [0, 0];
    this.hit = [0, 0];
    this.energy = 0;
    this.lastFireTime = -1;    // 最近一次「低频」判定成功的渲染时刻
    this.bpm = 0;
    this.hitTimes = [];

    // 退回 AnalyserNode 时要在主线程自己算 onset
    this.prevRaw = [0, 0];
    this.fluxHist = [[], []];
  }

  async start() {
    if (this.mode !== 'none') return this.mode;
    if (this.context.addModule && this.context.audioWorklet) {
      try {
        const url = await probeModuleUrl();
        await this.context.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(this.context, 'orbit-bass-probe', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { cutoff: 170, rumble: 30, treble: 1800, reportEvery: 3, refract: this.lowLatency ? 0.075 : 0.09 }
        });
        node.port.onmessage = event => this.#ingest(event.data);
        this.source.connect(node);
        // AudioWorklet 有输出就必须接到 destination，否则部分内核不调度它
        const silent = this.context.createGain();
        silent.gain.value = 0;
        node.connect(silent);
        silent.connect(this.context.destination);
        this.node = node;
        this.silent = silent;
        this.mode = 'worklet';
        this.onMode?.('worklet');
        return this.mode;
      } catch { /* 老内核 / 微信 X5 之类不支持，走下面的兜底 */ }
    }
    this.#demote();
    return this.mode;
  }

  dispose() {
    try { this.node?.disconnect(); } catch { /* already gone */ }
    try { this.silent?.disconnect(); } catch { /* already gone */ }
    try { this.analyser?.disconnect(); } catch { /* already gone */ }
    try { this.wide?.disconnect(); } catch { /* already gone */ }
    this.node = null;
    this.silent = null;
    this.analyser = null;
    this.wide = null;
    this.stream.length = 0;
    this.events.length = 0;
    this.mode = 'none';
  }

  // AudioWorklet 回调：这里只做入队，真正的时间对齐放到 sample() 里
  #ingest(data) {
    if (!data) return;
    this.stream.push({ t: data.t, rms: data.rms, rmsHigh: data.rmsHigh });
    if (this.stream.length > 240) this.stream.splice(0, this.stream.length - 240);
    if (data.hit > 0) this.events.push({ t: data.t, band: 0, strength: data.hit });
    if (data.hitHigh > 0) this.events.push({ t: data.t, band: 1, strength: data.hitHigh });
    if (this.events.length > 32) this.events.splice(0, this.events.length - 32);
  }

  // 手动校准：蓝牙耳机那段 Web Audio 不知道的延迟靠这个补
  setManualOffset(seconds) {
    this.manualOffset = clamp(Number(seconds) || 0, -0.4, 0.4);
  }

  #latency() {
    const context = this.context;
    const reported = Number(context.outputLatency);
    const base = Number(context.baseLatency);
    let target;
    if (Number.isFinite(reported) && reported > 0) target = reported;
    else if (Number.isFinite(base) && base > 0) target = base * 4 + 0.02;
    else target = 0.05;
    // 安卓 AudioTrack 偶尔会报出跳变很大的值（蓝牙切换瞬间），慢慢跟，别让画面抖
    target = clamp(target, 0, 0.4);
    this.autoLatency += (target - this.autoLatency) * 0.06;
    this.latency = clamp(this.autoLatency + this.manualOffset, -0.1, 0.6);
    return this.latency;
  }

  // 主干：每帧调一次，返回已经对齐到「此刻听到的声音」的各通道强度
  //   hit     —— 低频（底鼓）
  //   hitHigh —— 高频（军鼓、镲）
  sample(ctxTime, dt) {
    const latency = this.#latency();
    const audibleAt = ctxTime - latency;
    // 看门狗：AudioWorklet 在个别内核上可能建得起来但永远不调度，
    // 那样画面会彻底不跳。长时间判不出低频拍就自动退回 AnalyserNode。
    if (this.mode === 'worklet' && ctxTime - this.lastFireTime > 8 && this.peak[0] > 0.05) this.#demote();

    if (this.mode === 'worklet') {
      // 丢掉已经听过的样本，取「此刻正在响」的那一段
      let index = -1;
      for (let i = this.stream.length - 1; i >= 0; i -= 1) {
        if (this.stream[i].t <= audibleAt) { index = i; break; }
      }
      if (index >= 0) {
        const frame = this.stream[index];
        this.stream.splice(0, index);
        this.#pushLevel(frame.rms, frame.rmsHigh, dt);
      }
      // 渲染时间 + 输出延迟 <= 现在，说明这一拍刚好传到耳朵
      while (this.events.length && this.events[0].t + latency <= ctxTime) {
        const event = this.events.shift();
        this.#fire(event.band, event.strength, event.t);
      }
    } else if (this.mode === 'analyser') {
      this.analyser.getByteFrequencyData(this.bins);
      const raw = [0, 0];
      for (let band = 0; band < 2; band += 1) {
        const lo = this.binRange[band][0];
        const hi = this.binRange[band][1];
        let total = 0;
        for (let i = lo; i <= hi; i += 1) total += this.bins[i];
        raw[band] = total / (hi - lo + 1) / 255;
      }
      this.#detectOnMainThread(raw[0], raw[1], ctxTime, dt);
    } else {
      const fall = Math.min(1, dt * 3);
      this.level[0] += (0 - this.level[0]) * fall;
      this.level[1] += (0 - this.level[1]) * fall;
    }

    // 宽频响度：整首歌的「音量」，给呼吸和点阵用
    if (this.wide) {
      this.wide.getByteFrequencyData(this.wideBins);
      const useful = Math.min(48, this.wideBins.length);
      let total = 0;
      let weight = 0;
      for (let i = 0; i < useful; i += 1) {
        const w = 1 - i / useful * 0.55;
        total += this.wideBins[i] * w;
        weight += w;
      }
      this.energy = clamp(Math.pow(total / weight / 255 * 1.6, 0.85), 0, 1);
    }

    // 快起慢落：起振立刻顶上去，收得慢一点才看得出「砰」的一下。
    // 高频是碎拍，落得要比底鼓快，否则连成一片糊掉。
    const decayLow = Math.pow(0.05, dt / (this.lowLatency ? 0.26 : 0.32));
    const decayHigh = Math.pow(0.05, dt / 0.17);
    this.hit[0] *= decayLow;
    if (this.pendingHit > this.hit[0]) this.hit[0] = this.pendingHit;
    this.hit[1] *= decayHigh;
    if (this.pendingHigh > this.hit[1]) this.hit[1] = this.pendingHigh;
    this.pendingHit = 0;
    this.pendingHigh = 0;

    return {
      bass: this.level[0],
      treble: this.level[1],
      hit: this.hit[0],
      hitHigh: this.hit[1],
      level: this.energy
    };
  }

  // 自动增益：不同歌母带响度差很多，跟一个缓慢衰减的峰值走，
  // 这样「律动幅度」始终占满 0~1，手机小屏上也看得出来。
  #pushLevel(rms, rmsHigh, dt) {
    this.#normalize(0, rms, 0.012, 0.72, dt);
    this.#normalize(1, rmsHigh, 0.004, 0.8, dt);
  }

  #normalize(band, raw, floor, curve, dt) {
    this.peak[band] = Math.max(raw, this.peak[band] * 0.9985);
    const shaped = Math.pow(clamp(raw / Math.max(this.peak[band], floor), 0, 1), curve);
    const current = this.level[band];
    this.level[band] += (shaped - current) * (shaped > current ? Math.min(1, dt * 44) : Math.min(1, dt * 8));
  }

  #fire(band, strength, t) {
    if (band === 0) {
      if (strength > this.pendingHit) this.pendingHit = strength;
      this.lastFireTime = t;
      this.hitTimes.push(t);
      while (this.hitTimes.length > 12) this.hitTimes.shift();
      this.#estimateBpm();
    } else if (strength > this.pendingHigh) {
      this.pendingHigh = strength;
    }
  }

  #detectOnMainThread(rawLow, rawHigh, ctxTime, dt) {
    const raw = [rawLow, rawHigh];
    for (let band = 0; band < 2; band += 1) {
      const value = raw[band];
      const flux = Math.max(0, value - this.prevRaw[band]);
      this.prevRaw[band] = value;
      const hist = this.fluxHist[band];
      hist.push(flux);
      if (hist.length > 48) hist.shift();
      let mean = 0;
      for (let i = 0; i < hist.length; i += 1) mean += hist[i];
      mean /= hist.length || 1;
      let variance = 0;
      for (let i = 0; i < hist.length; i += 1) {
        const d = hist[i] - mean;
        variance += d * d;
      }
      const std = Math.sqrt(variance / (hist.length || 1));
      const sensitivity = band === 0 ? 1.35 : 1.7;
      const floor = band === 0 ? 0.004 : 0.002;
      if (flux > mean + std * sensitivity + floor && this.hit[band] < 0.35) {
        const strength = clamp(0.45 + (flux - mean) / (std * 2.2 + mean * 1.5 + 1e-5) * 0.55, 0, 1);
        this.#fire(band, strength, ctxTime);
      }
      this.#normalize(band, value, band === 0 ? 0.05 : 0.02, band === 0 ? 0.75 : 0.85, dt);
    }
  }

  // 粗略估计 BPM，只用来在极稀疏的段落里给画面一点提示，不做预测
  #estimateBpm() {
    const times = this.hitTimes;
    if (times.length < 5) return;
    const gaps = [];
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      if (gap > 0.22 && gap < 1.4) gaps.push(gap);
    }
    if (gaps.length < 3) return;
    gaps.sort((a, b) => a - b);
    const bpm = 60 / gaps[gaps.length >> 1];
    // 常见的记谱区间，超出就当成误判
    if (bpm >= 55 && bpm <= 200) this.bpm = Math.round(bpm);
  }

  // worklet 不干活时的退路：现搭一个高分辨率 analyser 顶上，UI 无需感知
  #demote() {
    this.mode = 'none';
    try { this.node?.disconnect(); } catch { /* 已断开 */ }
    try { this.silent?.disconnect(); } catch { /* 已断开 */ }
    this.node = null;
    this.silent = null;
    try {
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 2048;
      // 检测链绝不能平滑：平滑会把起振沿抹掉，判定出来的点就飘了
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -95;
      analyser.maxDecibels = -12;
      this.bins = new Uint8Array(analyser.frequencyBinCount);
      const perBin = this.context.sampleRate / 2 / analyser.frequencyBinCount;
      this.binRange = FALLBACK_BANDS.map(([lo, hi]) => {
        const start = Math.max(1, Math.floor(lo / perBin));
        return [start, Math.min(analyser.frequencyBinCount - 1, Math.max(start + 1, Math.ceil(hi / perBin)))];
      });
      this.source.connect(analyser);
      this.analyser = analyser;
      this.mode = 'analyser';
    } catch {
      this.mode = 'none';
    }
    this.onMode?.(this.mode);
  }
}
