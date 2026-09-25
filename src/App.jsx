import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tracks } from './tracks.js';
import { ensureLrc, prefetchLrc, waitForLrc } from './lyrics.js';
import { OUTPUT_MODES, applySink, listOutputs, readOutputPref, requestDeviceLabels, resumeAt, saveOutputPref, saveProgress } from './audioOut.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const backdropNames = ['星尘点阵', '声波轨道', '呼吸星云', '律动地形'];

// 音源是否已经有足够数据连续播放（HAVE_FUTURE_DATA 及以上）
function waitUntilPlayable(audio, timeout = 8000) {
  if (!audio || audio.readyState >= 3) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.removeEventListener('canplay', finish);
      audio.removeEventListener('canplaythrough', finish);
      audio.removeEventListener('loadedmetadata', check);
      audio.removeEventListener('error', finish);
      resolve();
    };
    const check = () => { if (audio.readyState >= 3) finish(); };
    const timer = setTimeout(finish, timeout);
    audio.addEventListener('canplay', finish);
    audio.addEventListener('canplaythrough', finish);
    audio.addEventListener('loadedmetadata', check);
    audio.addEventListener('error', finish);
  });
}

// 提前把下一首的音频拉进浏览器缓存，切歌时不用从头下
const audioPrefetch = new Map();
function prefetchAudio(src) {
  if (!src || audioPrefetch.has(src)) return;
  const probe = new Audio();
  probe.preload = 'auto';
  probe.src = src;
  probe.load();
  audioPrefetch.set(src, probe);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function SvgDefs() {
  return (
    <svg className="svgdefs" aria-hidden="true">
      <defs>
        <symbol id="i-play" viewBox="0 0 24 24"><path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" strokeWidth="4" /></symbol>
        <symbol id="i-next" viewBox="0 0 24 24"><path d="m5 5 10 7-10 7Z" fill="currentColor" stroke="none" /><path d="M18 5v14" strokeWidth="2" /></symbol>
        <symbol id="i-vol" viewBox="0 0 24 24"><path d="m11 5-5 4H3v6h3l5 4Z" /><path d="M15 8q5 4 0 8m3-11q8 7 0 14" /></symbol>
        <symbol id="i-heart" viewBox="0 0 24 24"><path d="M20.5 5.5C17 2 12 6 12 6S7 2 3.5 5.5C-1 10 12 20 12 20S25 10 20.5 5.5Z" /></symbol>
        <symbol id="i-speaker" viewBox="0 0 24 24"><path d="M4 9h4l4-3v12l-4-3H4Z" fill="currentColor" stroke="none" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12" /></symbol>
        <symbol id="i-orbit" viewBox="0 0 40 40"><ellipse cx="20" cy="20" rx="18" ry="8" transform="rotate(-35 20 20)" /><circle cx="20" cy="20" r="5" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-shuffle" viewBox="0 0 24 24"><path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 4-3 5-5m3-4c1-2 2-3 4-3h3m-4-4 4 4-4 4" /></symbol>
        <symbol id="i-wait" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9" /></symbol>
      </defs>
    </svg>
  );
}

function Icon({ name, className = '' }) {
  return <svg className={className}><use href={`#i-${name}`} /></svg>;
}

function LiquidArt({ src, alt = '', className = '' }) {
  return (
    <span className={`liquid-art ${className}`}>
      <img className="art-blur" src={src} alt="" aria-hidden="true" draggable="false" />
      <img className="art-image" src={src} alt={alt} draggable="false" />
    </span>
  );
}

function Header({ journal, onChangeView }) {
  return (
    <header>
      <a className="brand" href="./" aria-label="ORBIT 首页">
        <Icon name="orbit" />ORBIT<span className="brand-note">私人音乐频率</span>
      </a>
      <nav className="glass" aria-label="视图切换">
        <button className={journal ? '' : 'active'} onClick={() => onChangeView(false)}>音乐宇宙</button>
        <button className={journal ? 'active' : ''} onClick={() => onChangeView(true)}>听觉手记 <span>{tracks.length}</span></button>
      </nav>
      <div className="edition"><span className="live-dot" /> VOL. 024 <span>/</span> SEP 2026</div>
    </header>
  );
}

function useMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 600);
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 600);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mobile;
}

function LyricsPanel({ track, trackNumber, currentTime, duration, playing, audioRef }) {
  const [rows, setRows] = useState([{ time: 0, text: '正在载入本地同步歌词…' }]);
  const [state, setState] = useState('loading');
  const mobile = useMobile();

  useEffect(() => {
    let alive = true;
    setRows([{ time: 0, text: '正在载入本地同步歌词…' }]);
    setState('loading');
    // 复用 App 里的加载结果：播放前已经等过一次，这里通常是命中缓存
    ensureLrc(track.lyrics).then(parsed => {
      if (!alive || !parsed) return;
      if (parsed.rows.length) {
        setRows(parsed.rows);
        setState('local');
      } else {
        setRows([{ time: 0, text: '当前歌词文件没有可读取的时间轴' }]);
        setState('missing');
      }
    }).catch(() => {
      if (!alive) return;
      setRows([{ time: 0, text: '本地歌词暂时无法读取' }]);
      setState('error');
    });
    return () => { alive = false; };
  }, [track]);

  const fallbackIndex = useMemo(() => {
    let index = 0;
    rows.forEach((row, rowIndex) => {
      if (currentTime >= row.time) index = rowIndex;
    });
    return index;
  }, [currentTime, rows]);

  // timeupdate 只有约 4Hz，切换会慢半拍；播放时改为逐帧采样，定位更跟手
  const [liveIndex, setLiveIndex] = useState(null);
  useEffect(() => {
    const audio = audioRef?.current;
    if (!audio || !playing) {
      setLiveIndex(null);
      return undefined;
    }
    let frame = 0;
    const tick = () => {
      const time = audio.currentTime || 0;
      let index = 0;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (time >= rows[rowIndex].time) index = rowIndex;
        else break;
      }
      setLiveIndex(previous => (previous === index ? previous : index));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [audioRef, playing, rows]);

  const activeIndex = liveIndex !== null && liveIndex < rows.length ? liveIndex : fallbackIndex;

  // 歌词允许折行，每行高度不再统一，滚动量必须按实际位置量出来，
  // 否则长句换行后整条轨道会对不上。
  const headRef = useRef(null);
  const trackRef = useRef(null);
  const rowRefs = useRef([]);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
    const target = rowRefs.current[activeIndex] || rowRefs.current[0] || headRef.current;
    const track = trackRef.current;
    const viewport = track?.parentElement;
    if (!target || !track || !viewport) return;
    const center = viewport.clientHeight / 2;
    // 别滚出边界：开头时歌名必须完整可见（否则只剩半截标题挂在顶部），
    // 结尾时最后一行也别孤零零地飘在视窗中间。
    const raw = center - (target.offsetTop + target.offsetHeight / 2);
    // 开头第一行时强制轨道贴顶：视窗太小时「把第一行居中」会把歌名裁掉半截，
    // 干脆整块从顶上开始，歌名完整可见，歌词跟在下面。
    const aligned = activeIndex === 0 ? 0 : raw;
    const min = Math.min(0, viewport.clientHeight - track.offsetHeight);
    setShift(Math.max(min, Math.min(0, aligned)));
  };
    measure();
    // 字体替换、窗口变化、换行重排都会改高度，监听到就重新量一次
    const observer = new ResizeObserver(measure);
    if (trackRef.current) observer.observe(trackRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeIndex, rows, mobile]);

  const source = state === 'local' ? '本地同步歌词' : state === 'loading' ? '正在载入本地歌词' : state === 'missing' ? '歌词文件没有时间轴' : '本地歌词暂时无法读取';

  return (
    <div className={`intro ${playing ? 'is-playing' : ''}`} id="lyrics-panel" aria-live="polite">
      <span className="eyebrow">{playing ? 'NOW PLAYING' : 'READY TO PLAY'} · TRACK {String(trackNumber).padStart(2, '0')}</span>
      <div className="lyrics-viewport">
        <div className="lyrics-track" ref={trackRef} style={{ transform: `translate3d(0,${shift}px,0)` }}>
          {/* 歌名也排在轨道里，跟着歌词往回滚，不钉在面板顶部 */}
          <div className="lyrics-head" ref={headRef}>
            <h1 className="lyrics-title">{track.title}</h1>
          </div>
          {rows.map((row, index) => (
            <div
              className={`lyric-row ${row.meta ? 'meta' : ''} ${index === activeIndex ? 'active' : ''} ${Math.abs(index - activeIndex) === 1 ? 'near' : ''}`}
              key={`${row.time}-${index}`}
              ref={element => { rowRefs.current[index] = element; }}
            >
              {row.text}
            </div>
          ))}
        </div>
      </div>
      <span className="lyrics-note">{playing ? `${source} · ${formatTime(currentTime)} / ${formatTime(duration)}` : source}</span>
    </div>
  );
}

function makeCardCoordinates() {
  const rowCounts = tracks.length === 19 ? [3, 4, 5, 4, 3] : [4, 7, 8, 7, 4];
  const result = [];
  let cardIndex = 0;
  rowCounts.forEach((amount, rowIndex) => {
    const lat = (rowIndex - (rowCounts.length - 1) / 2) * 0.52;
    for (let column = 0; column < amount && cardIndex < tracks.length; column += 1) {
      result.push({
        track: tracks[cardIndex],
        lat,
        lon: column / amount * Math.PI * 2 + rowIndex * 0.27,
      });
      cardIndex += 1;
    }
  });
  return result;
}

function Universe({ current, playing, currentTime, duration, onSelect, zoom, backdropMode, onBackdrop, onRotateToast, onZoom, analysisRef, audioRef }) {
  const universeRef = useRef(null);
  const canvasRef = useRef(null);
  const cardRefs = useRef([]);
  const suppressClickUntil = useRef(0);
  const propsRef = useRef({ current, playing, zoom, backdropMode });
  const coordinates = useMemo(makeCardCoordinates, []);

  useEffect(() => {
    propsRef.current = { current, playing, zoom, backdropMode };
  }, [current, playing, zoom, backdropMode]);

  useEffect(() => {
    const universe = universeRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const tiltLimit = 1.08;
    let rotation = -0.1;
    let tilt = 0.1;
    let autoRotate = !reducedMotion.matches;
    let dragging = false;
    let pointerId = null;
    let captureTarget = null;
    let lastX = 0;
    let lastY = 0;
    let lastPointerTime = 0;
    let moved = 0;
    let velocityX = 0;
    let velocityY = 0;
    let focusRotation = rotation;
    let focusTilt = tilt;
    let focusing = false;
    let focusedTrack = -1;
    let lastFrame = 0;
    let animationFrame = 0;
    let refocusTimer = 0;
    let wasPlaying = false;

    const focusTrack = id => {
      const card = coordinates.find(item => item.track.id === id);
      if (!card) return;
      const exactRotation = -card.lon;
      focusRotation = rotation + Math.atan2(Math.sin(exactRotation - rotation), Math.cos(exactRotation - rotation));
      focusTilt = clamp(card.lat, -tiltLimit, tiltLimit);
      velocityX = 0;
      velocityY = 0;
      focusing = true;
    };

    let beatPulse = 0;
    let playerElement = null;

    const audioEnergy = (time = 0) => {
      const analysis = analysisRef.current;
      let target = 0;
      if (analysis.analyser && propsRef.current.playing) {
        analysis.analyser.getByteFrequencyData(analysis.spectrum);
        const usefulBins = Math.min(24, analysis.spectrum.length);
        let total = 0;
        let weight = 0;
        for (let index = 0; index < usefulBins; index += 1) {
          const w = 1 - index / usefulBins * 0.55;
          total += analysis.spectrum[index] * w;
          weight += w;
        }
        // 平均出来的能量常年趴在 0.2 上下，抬一点增益画面才动得起来
        target = clamp(Math.pow(total / weight / 255 * 1.55, 0.85), 0, 1);
      } else if (propsRef.current.playing) {
        // 原生输出模式拿不到频谱，用一段缓慢的假呼吸顶上，画面不至于彻底死掉
        target = 0.2 + Math.sin(time * 1.1) * 0.07 + Math.sin(time * 0.37) * 0.05;
      }
      // 快起慢落：鼓点一上来就顶上去，收得慢一些
      analysis.energy += (target - analysis.energy) * (target > analysis.energy ? 0.45 : 0.07);
      return analysis.energy;
    };

    // 低频 onset 检测：低频能量突然冲起来就是一拍，给出一个 0~1 的打击值后快速衰减
    const readBeat = dt => {
      const analysis = analysisRef.current;
      const playing = propsRef.current.playing;
      let bass = 0;
      if (analysis.fine && playing) {
        analysis.fine.getByteFrequencyData(analysis.fineBins);
        const nyquist = (analysis.context?.sampleRate || 44100) / 2;
        const end = clamp(Math.round(150 / nyquist * analysis.fineBins.length), 3, analysis.fineBins.length - 1);
        let total = 0;
        for (let index = 1; index <= end; index += 1) total += analysis.fineBins[index];
        bass = total / end / 255;
      }
      // 与一条慢速参考线比较，只看「增量」，低频持续响也不会一直判定成节拍
      const flux = Math.max(0, bass - analysis.bassRef);
      analysis.bassRef += (bass - analysis.bassRef) * 0.3;
      analysis.fluxAvg += (flux - analysis.fluxAvg) * Math.min(1, dt * 0.7);
      analysis.beatGap = Math.max(0, analysis.beatGap - dt);
      const threshold = Math.max(0.006, analysis.fluxAvg * 1.45 + 0.008);
      let hit = 0;
      if (playing && flux > threshold && analysis.beatGap <= 0) {
        hit = 0.6 + clamp((flux - threshold) / 0.05, 0, 1) * 0.4;
        analysis.beatGap = 0.1;
      }
      analysis.beat = Math.max(analysis.beat * Math.pow(0.05, dt / 0.32), hit);
      return analysis.beat;
    };

    const dot = (x, y, radius, alpha) => {
      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    };

    // ---------- 背景模式 3：律动地形 ----------
    // 一块倾斜的棋盘，柱子高度由 6 个频段分区驱动：低频抬中心、中低频走慢波、中频方向流动、
    // 中高频点尖峰、高频闪光、空气段撒颗粒。冲击力大时从中心扩散一圈涟漪。
    // 一律灰阶 + 半透明：低处的柱子几乎融进 #101113 底色，只有被音乐顶起来的那些才显形。
    const TOPO_PITCH = 0.92, TOPO_CAMD = 1500, TOPO_BANDS = 32;
    const topoLut = [];
    (function buildTopoLut() {
      const stops = [
        [0.00, 40, 42, 48],
        [0.30, 90, 93, 102],
        [0.55, 145, 149, 160],
        [0.78, 199, 203, 213],
        [1.00, 246, 248, 253]
      ];
      for (let i = 0; i < 256; i += 1) {
        const tv = i / 255;
        let s = 0;
        while (s < stops.length - 2 && tv > stops[s + 1][0]) s += 1;
        const p = stops[s];
        const q = stops[s + 1];
        const f = clamp((tv - p[0]) / (q[0] - p[0]), 0, 1);
        topoLut.push([
          Math.round(p[1] + (q[1] - p[1]) * f),
          Math.round(p[2] + (q[2] - p[2]) * f),
          Math.round(p[3] + (q[3] - p[3]) * f)
        ]);
      }
    })();
    const topoBands = new Float32Array(TOPO_BANDS);
    const topoSeed = Math.random() * 10;
    let topoRipples = [];
    let topoBeatMark = 0;

    const sampleTopo = time => {
      const analysis = analysisRef.current;
      let bass = 0;
      if (analysis.fine && propsRef.current.playing) {
        const bins = analysis.fineBins;
        analysis.fine.getByteFrequencyData(bins);
        const usable = Math.floor(bins.length * 0.62);
        for (let i = 0; i < TOPO_BANDS; i += 1) {
          const lo = Math.floor(Math.pow(i / TOPO_BANDS, 1.7) * usable);
          const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / TOPO_BANDS, 1.7) * usable));
          let sum = 0;
          for (let k = lo; k < hi; k += 1) sum += bins[k];
          // 频谱平均值偏小，统一抬增益，柱子才顶得起来
          const value = clamp(sum / (hi - lo) / 255 * 1.25, 0, 1);
          topoBands[i] += (value - topoBands[i]) * (value > topoBands[i] ? 0.5 : 0.1);
        }
        for (let i = 0; i < 4; i += 1) bass += topoBands[i];
        bass /= 4;
      } else {
        // 没在播放时缓慢回落，最后只剩一层静态的矮格子
        for (let i = 0; i < TOPO_BANDS; i += 1) topoBands[i] += (0 - topoBands[i]) * 0.04;
      }
      const lastRipple = topoRipples[topoRipples.length - 1];
      const canRipple = !lastRipple || time - lastRipple.t0 > 0.2;
      if (canRipple && (bass - topoBeatMark > 0.16 || beatPulse > 0.92)) {
        topoRipples.push({ t0: time, amp: Math.max(bass, 0.6) });
        topoBeatMark = bass;
      }
      if (bass < topoBeatMark) topoBeatMark = bass * 0.92;
      while (topoRipples.length && time - topoRipples[0].t0 > 3.2) topoRipples.shift();
      return bass;
    };

    const drawTopography = (width, height, time) => {
      const mobile = width < 600;
      const grid = mobile ? 20 : 28;
      const cell = mobile ? 40 : 46;
      const q = cell * 0.29;
      const half = (grid - 1) / 2;
      const maxR = half * cell;
      const cx = width * 0.5;
      const cy = height * (mobile ? 0.62 : 0.68);
      // 移动端歌词块在左上角，而节拍隆起原本发生在地形正中，两者完全不呼应。
      // 这里只把「节拍中心」往歌词那侧平移（横向 + 纵向往屏幕上方），
      // 普通波形、噪点、气流仍以地形原点为基准，整体构图不变。
      const beatX = mobile ? -maxR * 0.04 : 0;
      const beatZ = mobile ? maxR * 0.82 : 0;
      const cosP = Math.cos(TOPO_PITCH);
      const sinP = Math.sin(TOPO_PITCH);
      // 焦距按屏宽反算：让最近一排刚好铺出屏幕外，避免只有中间一小块、四周留空
      const nearSpan = width * (mobile ? 1.5 : 1.35);
      const fov = nearSpan * (TOPO_CAMD - maxR * cosP) / (2 * maxR);
      const bandAvg = (lo, hi) => {
        let sum = 0;
        for (let i = lo; i <= hi; i += 1) sum += topoBands[i];
        return sum / (hi - lo + 1);
      };
      const subBass = bandAvg(0, 2);
      const lowMid = bandAvg(5, 8);
      const mid = bandAvg(9, 14);
      const highMid = bandAvg(15, 19);
      const presence = bandAvg(20, 26);
      const air = bandAvg(29, 31);
      const proj = (x, y, z) => {
        const ry = y * cosP + z * sinP;
        const rz = -y * sinP + z * cosP;
        const s = fov / (rz + TOPO_CAMD);
        return [cx + x * s, cy - ry * s];
      };

      // 底盘只做极轻的压暗，避免变成一块挡住页面底色的实心板
      const gA = proj(-maxR - cell, 0, -maxR - cell);
      const gB = proj(maxR + cell, 0, -maxR - cell);
      const gC = proj(maxR + cell, 0, maxR + cell);
      const gD = proj(-maxR - cell, 0, maxR + cell);
      context.beginPath();
      context.moveTo(gA[0], gA[1]);
      context.lineTo(gB[0], gB[1]);
      context.lineTo(gC[0], gC[1]);
      context.lineTo(gD[0], gD[1]);
      context.closePath();
      context.fillStyle = 'rgba(12,13,16,0.30)';
      context.fill();

      // 从远到近画，保证近处的柱子盖住远处的（画家算法）
      for (let row = grid - 1; row >= 0; row -= 1) {
        const z = (row - half) * cell;
        for (let col = 0; col < grid; col += 1) {
          const x = (col - half) * cell;
          const dist = Math.sqrt(x * x + z * z);
          // 节拍中心：鼓点隆起、涟漪、整拍抬升都以它为核心（移动端已挪到歌词附近）
          const bd = Math.sqrt((x - beatX) * (x - beatX) + (z - beatZ) * (z - beatZ));
          const center = Math.exp(-(bd * bd) / (maxR * maxR * (mobile ? 0.07 : 0.10))) * subBass * 190;
          const wave = (Math.sin(x * 0.012 + time * 0.6) * Math.cos(z * 0.010 - time * 0.45) * 0.5 + 0.5) * lowMid * 96;
          const flow = (Math.sin((x + z) * 0.016 - time * 1.1) * 0.5 + 0.5) * mid * 74;
          const spike = Math.sin(x * 0.037 + topoSeed) * Math.cos(z * 0.029 - topoSeed) > 0.86 ? highMid * 145 : 0;
          const spark = Math.sin(x * 0.05 + topoSeed) * Math.cos(z * 0.043 - topoSeed) > 0.87 ? presence * 122 : 0;
          const grain = air * 20 * (Math.sin(x * 0.09 + time * 3) * Math.cos(z * 0.08 - time * 2.4) * 0.5 + 0.5);
          let rip = 0;
          for (let ri = 0; ri < topoRipples.length; ri += 1) {
            const age = time - topoRipples[ri].t0;
            const d = Math.abs(bd - age * 620);
            if (d < 220) rip += Math.cos(d / 220 * Math.PI / 2) * topoRipples[ri].amp * 92 * Math.max(0, 1 - age / 3.2);
          }
          // 每一拍把整块地形整体顶一下，节奏看得见
          const kick = beatPulse * 17 * Math.exp(-(bd * bd) / (maxR * maxR * (mobile ? 0.35 : 0.5)));
          // 静止时也留一层极缓的呼吸，画面不至于完全死掉
          const idle = 7 * (Math.sin(x * 0.006 + time * 0.35) * Math.cos(z * 0.005 - time * 0.28) * 0.5 + 0.5);
          const h = 8 + center + wave + flow + spike + spark + grain + rip + kick + idle;
          const tt = clamp(h / 212, 0, 1);
          const c = topoLut[(tt * 255) | 0];

          const t0 = proj(x - q, h, z - q);
          const t1 = proj(x + q, h, z - q);
          const t2 = proj(x + q, h, z + q);
          const t3 = proj(x - q, h, z + q);
          const f0 = proj(x - q, 0, z - q);
          const f1 = proj(x + q, 0, z - q);

          // 侧面只画朝向视轴的那一侧
          if (x > cell * 0.5) {
            const sA = proj(x - q, 0, z + q);
            const sB = proj(x - q, h, z + q);
            context.fillStyle = 'rgba(' + Math.round(c[0] * 0.42) + ',' + Math.round(c[1] * 0.42) + ',' + Math.round(c[2] * 0.42) + ',' + (0.06 + tt * 0.11) + ')';
            context.beginPath();
            context.moveTo(f0[0], f0[1]);
            context.lineTo(sA[0], sA[1]);
            context.lineTo(sB[0], sB[1]);
            context.lineTo(t0[0], t0[1]);
            context.closePath();
            context.fill();
          } else if (x < -cell * 0.5) {
            const sC = proj(x + q, 0, z + q);
            const sD = proj(x + q, h, z + q);
            context.fillStyle = 'rgba(' + Math.round(c[0] * 0.42) + ',' + Math.round(c[1] * 0.42) + ',' + Math.round(c[2] * 0.42) + ',' + (0.06 + tt * 0.11) + ')';
            context.beginPath();
            context.moveTo(f1[0], f1[1]);
            context.lineTo(sC[0], sC[1]);
            context.lineTo(sD[0], sD[1]);
            context.lineTo(t1[0], t1[1]);
            context.closePath();
            context.fill();
          }

          // 正面
          context.fillStyle = 'rgba(' + Math.round(c[0] * 0.58) + ',' + Math.round(c[1] * 0.58) + ',' + Math.round(c[2] * 0.58) + ',' + (0.14 + tt * 0.26) + ')';
          context.beginPath();
          context.moveTo(f0[0], f0[1]);
          context.lineTo(f1[0], f1[1]);
          context.lineTo(t1[0], t1[1]);
          context.lineTo(t0[0], t0[1]);
          context.closePath();
          context.fill();

          // 顶面：越高的柱子越实
          context.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (0.30 + tt * 0.46) + ')';
          context.beginPath();
          context.moveTo(t0[0], t0[1]);
          context.lineTo(t1[0], t1[1]);
          context.lineTo(t2[0], t2[1]);
          context.lineTo(t3[0], t3[1]);
          context.closePath();
          context.fill();
        }
      }
    };

    const drawSoundfield = (timestamp, dtSeconds) => {
      const width = universe.clientWidth;
      const height = universe.clientHeight;
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#fff';
      const beatTime = timestamp * 0.001;
      const energy = reducedMotion.matches ? 0 : audioEnergy(beatTime);
      const beat = reducedMotion.matches ? 0 : readBeat(dtSeconds);
      // 打击感为主、音量打底，两者叠加后归一化成 0~1 的 --beat
      beatPulse = clamp(beat * 0.5 + energy * 0.36, 0, 1);
      const time = timestamp * 0.001;
      const beatText = beatPulse.toFixed(3);
      document.getElementById('lyrics-panel')?.style.setProperty('--beat', beatText);
      if (!playerElement) playerElement = document.querySelector('.player');
      playerElement?.style.setProperty('--beat', beatText);

      if (propsRef.current.backdropMode === 0) {
        const step = width < 600 ? 34 : 42;
        const centerX = width * 0.52;
        const centerY = height * 0.43;
        const maxDistance = Math.hypot(width, height) * 0.58;
        for (let y = step * 0.5; y < height; y += step) {
          for (let x = step * 0.5; x < width; x += step) {
            const distance = Math.hypot(x - centerX, y - centerY);
            const falloff = Math.max(0, 1 - distance / maxDistance);
            const wave = Math.sin(distance * 0.04 - time * 3.2) * 0.5 + 0.5;
            dot(x, y, 0.42 + wave * 0.32 + (energy * 2.4 + beatPulse * 1.5) * falloff, 0.045 + falloff * 0.055 + (energy * 0.24 + beatPulse * 0.2) * falloff);
          }
        }
      } else if (propsRef.current.backdropMode === 1) {
        const centerX = width * 0.52;
        const centerY = height * 0.43;
        for (let ring = 1; ring <= 9; ring += 1) {
          const amount = 18 + ring * 8;
          const radiusX = ring / 9 * width * 0.56;
          const radiusY = ring / 9 * height * 0.44;
          for (let index = 0; index < amount; index += 1) {
            const angle = index / amount * Math.PI * 2 + time * (0.012 + ring * 0.001) * (ring % 2 ? 1 : -1);
            const lift = Math.sin(angle * 3 - time * 2.4) * (energy * 10 + beatPulse * 6);
            dot(centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY + lift, 0.45 + energy * 1.7 + beatPulse * 1.1, 0.05 + energy * 0.2 + beatPulse * 0.15);
          }
        }
      } else if (propsRef.current.backdropMode === 3) {
        sampleTopo(time);
        drawTopography(width, height, reducedMotion.matches ? 0 : time);
      } else {
        const amount = width < 600 ? 150 : 280;
        for (let index = 0; index < amount; index += 1) {
          const seedX = ((Math.sin(index * 91.417) * 43758.5453) % 1 + 1) % 1;
          const seedY = ((Math.sin(index * 47.853 + 2) * 24634.6345) % 1 + 1) % 1;
          const shimmer = Math.sin(time * (1.1 + seedX) + index) * 0.5 + 0.5;
          const drift = reducedMotion.matches ? 0 : Math.sin(time * 0.35 + index) * (2 + energy * 7 + beatPulse * 5);
          dot(seedX * width + drift, seedY * height, 0.4 + shimmer * 0.65 + energy * 1.8 + beatPulse * 1.2, 0.035 + shimmer * 0.08 + energy * 0.15 + beatPulse * 0.11);
        }
      }
      context.globalAlpha = 1;
    };

    const drawSphere = () => {
      const width = innerWidth;
      const height = universe.clientHeight;
      const mobile = width < 600;
      // 移动端屏幕窄，不能沿用桌面的下限，否则卡片会被推出可视区
      const radiusX = Math.max(width * 0.3, mobile ? 140 : 300) * propsRef.current.zoom;
      const radiusY = Math.max((height - 130) * (mobile ? 0.3 : 0.4), mobile ? 140 : 200) * propsRef.current.zoom;
      coordinates.forEach((card, index) => {
        const element = cardRefs.current[index];
        if (!element) return;
        const angle = card.lon + rotation;
        const x = Math.cos(card.lat) * Math.sin(angle);
        const z = Math.cos(card.lat) * Math.cos(angle);
        const y = Math.sin(card.lat);
        const projectedY = y * Math.cos(tilt) - z * Math.sin(tilt);
        const depth = y * Math.sin(tilt) + z * Math.cos(tilt);
        const active = card.track.id === propsRef.current.current && propsRef.current.playing;
        // 正在播的那张卡片跟着节拍一起呼吸
        const scale = (0.36 + (depth + 1) * 0.31) * (active ? 1.05 + beatPulse * 0.045 : 1);
        element.style.transform = `translate3d(-50%,-50%,0) translate3d(${x * radiusX}px,${projectedY * radiusY + (mobile ? 45 : 10)}px,0) scale(${scale}) rotateY(${x * -16}deg) rotateZ(${x * projectedY * 5}deg)`;
        if (active) {
          element.style.boxShadow = `0 12px 35px #0008, 0 0 0 2px #ffffff3d, 0 0 ${(16 + beatPulse * 34).toFixed(1)}px rgba(255,255,255,${(0.06 + beatPulse * 0.2).toFixed(3)})`;
          element.dataset.glow = '1';
        } else if (element.dataset.glow) {
          element.style.boxShadow = '';
          delete element.dataset.glow;
        }
        // 背面卡片直接淡到不可见，避免在正面卡片后面堆成一列。
        // 移动端卡片更密、屏幕更小，用更陡的三次方曲线：只有最前一层保持清晰，
        // 后面的卡片大幅透明，不然整个画面糊成一团。
        const fade = Math.max(0, Math.min(1, (depth + 0.5) / 1.5));
        const alpha = mobile ? 0.04 + fade * fade * fade * 0.96 : 0.05 + fade * fade * 0.85;
        element.style.opacity = String(active ? 1 : alpha);
        element.style.visibility = (!active && fade <= 0.002) ? 'hidden' : 'visible';
        element.style.filter = `brightness(${mobile ? 0.4 + (depth + 1) * 0.25 : 0.45 + (depth + 1) * 0.3})`;
        element.style.zIndex = String(active ? 90 : Math.round((depth + 1) * 30) + 1);
        const interactive = depth >= -0.3;
        element.style.pointerEvents = interactive ? 'auto' : 'none';
        element.tabIndex = interactive ? 0 : -1;
      });
    };

    const animate = timestamp => {
      const dt = Math.min(timestamp - lastFrame || 16, 32);
      lastFrame = timestamp;
      // 直接点播放（没换歌）也要把镜头转到正在播的那首，否则按了播放却看不见它在哪。
      if (propsRef.current.playing && !wasPlaying && !dragging) {
        focusedTrack = propsRef.current.current;
        focusTrack(focusedTrack);
      }
      wasPlaying = propsRef.current.playing;
      // 播放时也允许自由拖着浏览：只在「换歌」的瞬间自动对焦，
      // 不再每帧把镜头硬拽回当前曲目（那样一松手就被拉回去，等于没法翻）。
      if (focusedTrack !== propsRef.current.current) {
        focusedTrack = propsRef.current.current;
        if (!dragging) focusTrack(focusedTrack);
      }
      if (!dragging) {
        if (focusing) {
          const easing = 1 - Math.pow(0.001, dt / 420);
          rotation += (focusRotation - rotation) * easing;
          tilt += (focusTilt - tilt) * easing;
          if (Math.abs(focusRotation - rotation) < 0.001 && Math.abs(focusTilt - tilt) < 0.001) focusing = false;
        } else if (autoRotate && !propsRef.current.playing) {
          rotation += dt * 0.000022;
        }
        if (!focusing && (Math.abs(velocityX) > 0.000001 || Math.abs(velocityY) > 0.000001)) {
          rotation += velocityX * dt;
          tilt = clamp(tilt + velocityY * dt, -tiltLimit, tiltLimit);
          const friction = Math.pow(0.91, dt / 16.67);
          velocityX *= friction;
          velocityY *= friction;
        }
      }
      drawSoundfield(timestamp, dt / 1000);
      drawSphere();
      animationFrame = requestAnimationFrame(animate);
    };

    const startDrag = event => {
      if (event.button !== 0 || event.target.closest('.view-controls')) return;
      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      lastPointerTime = event.timeStamp;
      moved = 0;
      velocityX = 0;
      velocityY = 0;
      focusing = false;
      // 又上手拖了，取消上一次的「转回当前歌曲」倒计时
      clearTimeout(refocusTimer);
      universe.classList.add('dragging');
      captureTarget = event.target.closest('.card') || universe;
      captureTarget.setPointerCapture(event.pointerId);
    };
    const moveDrag = event => {
      if (!dragging || event.pointerId !== pointerId) return;
      const samples = event.getCoalescedEvents?.() || [event];
      samples.forEach(sample => {
        const dx = sample.clientX - lastX;
        const dy = sample.clientY - lastY;
        const dt = Math.max(1, sample.timeStamp - lastPointerTime);
        moved += Math.hypot(dx, dy);
        rotation += dx * 0.004;
        tilt = clamp(tilt - dy * 0.002, -tiltLimit, tiltLimit);
        velocityX = velocityX * 0.68 + dx / dt * 0.004 * 0.32;
        velocityY = velocityY * 0.68 - dy / dt * 0.002 * 0.32;
        lastX = sample.clientX;
        lastY = sample.clientY;
        lastPointerTime = sample.timeStamp;
      });
    };
    const endDrag = event => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      if (moved > 7) suppressClickUntil.current = performance.now() + 280;
      if (reducedMotion.matches) {
        velocityX = 0;
        velocityY = 0;
      }
      universe.classList.remove('dragging');
      try { captureTarget?.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
      captureTarget = null;
      pointerId = null;
      // 播放中松手后先让你随便看，3 秒内没拖到别的歌（也没点开别的卡）
      // 就平滑转回正在播的那首；中途切了歌则以新的当前曲目为准。
      clearTimeout(refocusTimer);
      if (propsRef.current.playing) {
        refocusTimer = setTimeout(() => {
          if (dragging) return;
          focusedTrack = propsRef.current.current;
          focusTrack(propsRef.current.current);
        }, 3000);
      }
    };
    const preventSelection = event => event.preventDefault();
    const onKeyDown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      rotation += event.key === 'ArrowLeft' ? -0.15 : event.key === 'ArrowRight' ? 0.15 : 0;
      focusing = false;
      tilt = clamp(tilt + (event.key === 'ArrowUp' ? -0.1 : event.key === 'ArrowDown' ? 0.1 : 0), -tiltLimit, tiltLimit);
    };
    const toggleRotate = event => {
      autoRotate = !autoRotate;
      event.currentTarget.style.opacity = autoRotate ? 1 : 0.4;
      event.currentTarget.setAttribute('aria-label', autoRotate ? '暂停自动旋转' : '开启自动旋转');
      onRotateToast(autoRotate ? '自动旋转已开启' : '自动旋转已暂停');
    };

    universe.addEventListener('pointerdown', startDrag);
    universe.addEventListener('pointermove', moveDrag);
    universe.addEventListener('pointerup', endDrag);
    universe.addEventListener('pointercancel', endDrag);
    universe.addEventListener('selectstart', preventSelection);
    universe.addEventListener('dragstart', preventSelection);
    universe.addEventListener('keydown', onKeyDown);
    universe.querySelector('#rotate')?.addEventListener('click', toggleRotate);
    animationFrame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animationFrame);
      clearTimeout(refocusTimer);
      // 离开宇宙视图时把节拍值归零，免得停在某一帧的亮度上
      document.getElementById('lyrics-panel')?.style.setProperty('--beat', '0');
      playerElement?.style.setProperty('--beat', '0');
      universe.removeEventListener('pointerdown', startDrag);
      universe.removeEventListener('pointermove', moveDrag);
      universe.removeEventListener('pointerup', endDrag);
      universe.removeEventListener('pointercancel', endDrag);
      universe.removeEventListener('selectstart', preventSelection);
      universe.removeEventListener('dragstart', preventSelection);
      universe.removeEventListener('keydown', onKeyDown);
      universe.querySelector('#rotate')?.removeEventListener('click', toggleRotate);
    };
  }, [analysisRef, coordinates, onRotateToast]);

  return (
    <main ref={universeRef} id="universe" aria-label="拖动旋转歌单宇宙" tabIndex="0">
      <canvas ref={canvasRef} id="soundfield" aria-hidden="true" />
      <div className="ambient" /><div className="orbit-line one" /><div className="orbit-line two" />
      <LyricsPanel track={tracks[current]} trackNumber={current + 1} currentTime={currentTime} duration={duration} playing={playing} audioRef={audioRef} />
      <div id="sphere">
        {coordinates.map(({ track }, index) => (
          <button
            className={`card ${track.id === current && playing ? 'active' : ''}`}
            type="button"
            data-track={track.id}
            aria-label={`播放歌曲：${track.title}`}
            key={track.id}
            ref={element => { cardRefs.current[index] = element; }}
            onClick={event => {
              if (performance.now() < suppressClickUntil.current) {
                event.preventDefault();
                return;
              }
              onSelect(track.id, true);
            }}
          >
            <LiquidArt src={track.cover} className="card-art" />
            <span className="number">ORBIT · {String(track.id + 1).padStart(2, '0')}</span>
            <span className="card-play"><Icon name="play" /></span>
            <span className="caption"><strong>{track.title}</strong><small>{track.album}</small></span>
          </button>
        ))}
      </div>
      <div className="side-label">VALORANT · LEAGUE OF LEGENDS · LOCAL ARCHIVE</div>
      <div className="coordinates">FULL LOCAL AUDIO<br />{tracks.length} TRACKS</div>
      <div className="universe-footer">
        <div className="drag-hint"><span>↔</span> 拖动漫游 <i /> 点击即播</div>
        <div className="view-controls glass">
          <button onClick={onBackdrop} aria-label={`切换背景：${backdropNames[backdropMode]}`} title={`切换背景：${backdropNames[backdropMode]}`}>✦</button>
          <span /><button id="rotate" aria-label="暂停自动旋转" title="暂停自动旋转">◉</button>
          <span /><button onClick={() => onZoom(-0.1)} aria-label="缩小">−</button><button onClick={() => onZoom(0.1)} aria-label="放大">＋</button>
        </div>
      </div>
    </main>
  );
}

function Journal({ onOpen }) {
  return (
    <section id="journal-view">
      <div className="journal-heading"><span className="eyebrow">NOTES BETWEEN TRACKS</span><h1>声音之外，<br />留下一点什么。</h1><p>{tracks.length} 首完整本地歌曲，音源、歌词与封面逐首对应。</p></div>
      <div id="journal-grid">
        {tracks.map(track => (
          <button className="journal-card" onClick={() => onOpen(track.id)} key={track.id}>
            <LiquidArt src={track.cover} alt={`${track.album} 专辑封面`} className="journal-art" />
            <span>{track.genre} / TRACK {String(track.id + 1).padStart(2, '0')}</span>
            <h2>{track.title}</h2><p>{track.artist} · {track.album}</p>
          </button>
        ))}
      </div>
    </section>
  );
}

function Player({ track, current, playing, preparing, currentTime, duration, random, repeat, liked, volume, muted, outputPref, outputs, outputMenu, onOutputToggle, onOutputPick, onPlay, onStep, onSeek, onShuffle, onRepeat, onFavorite, onVolume, onMute, onOpen }) {
  // duration 未知（metadata 没到 / iOS 对 mp3 常报 Infinity）时进度条必须整体禁用，
  // 千万不能用 100 当 max：断点续播把 currentTime 设到 120s 的话，滑块会顶到最右边。
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  // 拖动进度条期间用本地值渲染，否则 timeupdate 每 250ms 一次的重渲染
  // 会和手指拖动打架，表现就是滑块往回跳、松手位置不对。
  const [scrub, setScrub] = useState(null);
  const shownTime = scrub ?? Math.min(currentTime, safeDuration || currentTime);
  const progress = safeDuration ? Math.min(shownTime, safeDuration) / safeDuration * 100 : 0;
  const commitScrub = () => {
    if (scrub !== null) {
      onSeek(scrub);
      setScrub(null);
    }
  };
  return (
    <footer className="player glass">
      <div className="now">
        <LiquidArt src={track.cover} alt={`${track.album} 专辑封面`} className="now-art" />
        <div className="now-copy">
          <div className="now-title">{track.title}</div>
          <div className={`now-sub ${preparing ? 'is-preparing' : ''}`}>{preparing ? '正在准备歌词与音源…' : `${track.artist} · ${track.album}`}</div>
        </div>
        <button className={`icon favorite ${liked ? 'liked' : ''}`} onClick={onFavorite} aria-label={liked ? '取消收藏当前歌曲' : '收藏当前歌曲'} aria-pressed={liked}><Icon name="heart" /></button>
      </div>
      <div className="playback">
        <div className="transport">
          <button className="icon secondary" onClick={onShuffle} aria-label="随机播放" aria-pressed={random}><Icon name="shuffle" /></button>
          <button className="icon" onClick={() => onStep(-1)} aria-label="上一首"><Icon name="next" className="flip" /></button>
          <button
            className={`play ${preparing ? 'preparing' : ''}`}
            onClick={onPlay}
            disabled={preparing}
            aria-busy={preparing}
            aria-label={preparing ? '正在准备歌词与音源' : playing ? '暂停' : '播放'}
          ><Icon name={preparing ? 'wait' : playing ? 'pause' : 'play'} /></button>
          <button className="icon" onClick={() => onStep(1)} aria-label="下一首"><Icon name="next" /></button>
          <button className="icon secondary" onClick={onRepeat} aria-label="循环播放" aria-pressed={repeat}>↻</button>
        </div>
        <div className="timeline">
          <time>{formatTime(shownTime)}</time>
          <input
            type="range"
            min="0"
            max={safeDuration || 1}
            step="0.1"
            disabled={!safeDuration}
            aria-label="播放进度"
            style={{ '--fill': `${progress}%` }}
            value={scrub ?? shownTime}
            onChange={event => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) {
                setScrub(value);
                onSeek(value);
              }
            }}
            onPointerUp={commitScrub}
            onTouchEnd={commitScrub}
            onMouseUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={commitScrub}
          />
          <time>{formatTime(safeDuration)}</time>
        </div>
      </div>
      <div className="player-right">
        <span>TRACK / {String(current + 1).padStart(2, '0')}</span>
        <button className="icon" onClick={onMute} aria-label={muted ? '取消静音' : '静音'} style={{ opacity: muted ? 0.4 : 1 }}><Icon name="vol" /></button>
        <input type="range" min="0" max="1" step=".01" value={volume} aria-label="音量" style={{ '--fill': `${volume * 100}%` }} onChange={event => onVolume(Number(event.target.value))} />
        <div className="output-wrap">
          <button className={`icon output-btn ${outputMenu ? 'on' : ''}`} onClick={onOutputToggle} aria-label="选择音频输出设备" aria-expanded={outputMenu} title="音频输出"><Icon name="speaker" /></button>
          {outputMenu && (
            <div className="output-menu glass" role="menu">
              <div className="output-head">音频输出</div>
              {Object.entries(OUTPUT_MODES).map(([mode, info]) => (
                <button key={mode} className={`output-item ${outputPref.mode === mode ? 'on' : ''}`} role="menuitemradio" aria-checked={outputPref.mode === mode} onClick={() => onOutputPick({ mode })}>
                  <strong>{info.label}</strong>
                  <small>{info.hint}</small>
                </button>
              ))}
              <div className="output-sep">指定输出设备（律动保持开启）</div>
              <button className={`output-item ${!outputPref.deviceId ? 'on' : ''}`} role="menuitemradio" aria-checked={!outputPref.deviceId} onClick={() => onOutputPick({ deviceId: '' })}>
                <strong>跟随系统默认</strong>
                <small>接了外接音箱却很小声时，先试这个</small>
              </button>
              {outputs.map(device => (
                <button key={device.id} className={`output-item ${outputPref.deviceId === device.id ? 'on' : ''}`} role="menuitemradio" aria-checked={outputPref.deviceId === device.id} onClick={() => onOutputPick({ deviceId: device.id })}>
                  <strong>{device.label}</strong>
                </button>
              ))}
              {!outputs.length && <div className="output-empty">当前浏览器不支持列出输出设备，可在系统音量里切换默认设备</div>}
            </div>
          )}
        </div>
        <button className="icon note-icon" onClick={onOpen} aria-label="阅读当前歌曲手记">☷</button>
      </div>
    </footer>
  );
}

function DetailDialog({ track, onClose, onPlay }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      id="detail"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      <button className="close" onClick={onClose} aria-label="关闭">×</button>
      <LiquidArt src={track.cover} alt={`${track.album} 专辑封面`} className="detail-art" />
      <div className="detail-copy">
        <span className="eyebrow">TRACK {String(track.id + 1).padStart(2, '0')} / {track.genre}</span>
        <h2>{track.title}</h2><p>{track.note}</p>
        <div className="detail-meta"><span>{track.artist}</span><span>·</span><a href={track.sourceUrl} target="_blank" rel="noreferrer">查看歌曲来源 ↗</a></div>
        <button className="listen" onClick={() => onPlay(track.id)}>播放完整歌曲 <Icon name="play" /></button>
        <small>音源、歌词与封面来自本地 assets 目录</small>
      </div>
    </dialog>
  );
}

export default function App() {
  const audioRef = useRef(null);
  const toastTimer = useRef(null);
  const analysisRef = useRef({
    context: null, analyser: null, spectrum: null, source: null,
    fine: null, fineBins: null,
    energy: 0, beat: 0, bassRef: 0, fluxAvg: 0.02, beatGap: 0,
  });
  const [journal, setJournal] = useState(false);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [random, setRandom] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [liked, setLiked] = useState(() => new Set());
  const [volume, setVolume] = useState(0.65);
  const [muted, setMuted] = useState(false);
  const [selected, setSelected] = useState(null);
  const [toastText, setToastText] = useState('');
  const [backdropMode, setBackdropMode] = useState(3);
  const [zoom, setZoom] = useState(1);
  const [preparing, setPreparing] = useState(false);
  const [outputPref, setOutputPref] = useState(readOutputPref);
  const [outputs, setOutputs] = useState([]);
  const [outputMenu, setOutputMenu] = useState(false);
  const currentRef = useRef(0);
  const preparingRef = useRef(false);
  const cancelPlayRef = useRef(false);
  const slowHintTimer = useRef(null);
  const outputPrefRef = useRef(outputPref);
  outputPrefRef.current = outputPref;
  const playingRef = useRef(false);
  playingRef.current = playing;
  const resumeWantedRef = useRef(0);

  const showToast = useCallback(message => {
    setToastText(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(''), 2200);
  }, []);

  useEffect(() => () => { clearTimeout(toastTimer.current); clearTimeout(slowHintTimer.current); }, []);
  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => {
    const audio = audioRef.current;
    audio.src = tracks[0].src;
    audio.volume = 0.65;
    audio.load();
    // 首屏就把当前歌词和下一首准备好，点播放时基本不用再等
    prefetchLrc(tracks[0].lyrics);
    prefetchLrc(tracks[1 % tracks.length].lyrics);
    // 上次选了具体输出设备的话，启动时就把它接回去（此时还没被 Web Audio 接管，元素级即可）
    if (outputPrefRef.current.deviceId) {
      applySink(audio, null, outputPrefRef.current.deviceId).then(ok => {
        if (!ok) showToast('上次的输出设备不可用，已回到系统默认');
      });
    }
  }, [showToast]);

  // 断点续播：切歌（含首屏）时把上次听到的位置接回去，但不自动播放
  useEffect(() => {
    const audio = audioRef.current;
    const id = currentRef.current;
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      const at = resumeAt(id, Number.isFinite(audio.duration) ? audio.duration : 0);
      if (!at) return;
      audio.currentTime = at;
      setCurrentTime(at);
      resumeWantedRef.current = at;
      showToast(`已回到上次听到 ${formatTime(at)}`);
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener('loadedmetadata', apply, { once: true });
    return () => { cancelled = true; audio.removeEventListener('loadedmetadata', apply); };
  }, [current, showToast]);

  // 音源中断后自动重连：蓝牙/外接设备回来、文件未就绪时兜底重新拉取
  const reconnect = useCallback(() => {
    const audio = audioRef.current;
    if (!playingRef.current) return;
    const at = audio.currentTime || resumeWantedRef.current;
    audio.src = tracks[currentRef.current].src;
    audio.load();
    const resume = () => {
      audio.currentTime = at || 0;
      audio.play().then(() => showToast(`已从 ${formatTime(audio.currentTime)} 继续播放`)).catch(() => {});
    };
    audio.addEventListener('canplay', resume, { once: true });
  }, [showToast]);

  // 外接设备插拔变化时：如果之前选中的设备没了（蓝牙断开），自动退回系统默认，
  // 否则会卡在一个已经不存在的输出口上，整页都没声音。
  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    const sync = async () => {
      const devices = await listOutputs();
      setOutputs(devices);
      if (!outputPrefRef.current.deviceId) return;
      if (devices.some(item => item.id === outputPrefRef.current.deviceId)) return;
      const next = { ...outputPrefRef.current, deviceId: '' };
      saveOutputPref(next);
      setOutputPref(next);
      await applySink(audioRef.current, analysisRef.current.context, '');
      showToast('原来的输出设备已断开，已切回系统默认');
    };
    navigator.mediaDevices.addEventListener('devicechange', sync);
    return () => navigator.mediaDevices.removeEventListener('devicechange', sync);
  }, [showToast]);

  const openOutputMenu = async () => {
    const nextOpen = !outputMenu;
    setOutputMenu(nextOpen);
    if (!nextOpen) return;
    let devices = await listOutputs();
    // Chrome 不给标签就拿不到设备名，先申请一次麦克风权限（拿完立刻停掉录音）
    if (devices.every(item => /未命名|^\s*$/.test(item.label))) {
      await requestDeviceLabels();
      devices = await listOutputs();
    }
    setOutputs(devices);
  };

  const chooseOutput = async patch => {
    setOutputMenu(false);
    const next = { ...outputPref, ...patch };
    if (next.mode === outputPref.mode && next.deviceId === outputPref.deviceId) return;
    saveOutputPref(next);
    const taken = Boolean(analysisRef.current.context);
    // 音频被接管之后没法原地还原成原生路由（浏览器限制），这里刻意不 reload：
    // 强制刷新会打断外接音箱和蓝牙的连接。模式本来就不持久化，刷新后自然回到律动。
    if (next.mode === 'direct' && taken) {
      showToast('音频已被律动接管，刷新页面后可按原生输出播放');
      return;
    }
    setOutputPref(next);
    if (next.mode === 'direct') {
      showToast('已切到原生输出，律动暂停；刷新页面后恢复默认律动');
      return;
    }
    if (next.mode === 'viz' && !outputPref.deviceId) {
      showToast('已恢复律动可视化，下次播放生效');
      return;
    }
    const ok = await applySink(audioRef.current, analysisRef.current.context, next.deviceId);
    if (!ok) {
      const fallback = { ...next, deviceId: '' };
      saveOutputPref(fallback);
      setOutputPref(fallback);
      applySink(audioRef.current, analysisRef.current.context, '');
      showToast('这个设备切不过去，已保持系统默认');
      return;
    }
    const picked = outputs.find(item => item.id === next.deviceId);
    showToast(picked ? `输出到「${picked.label}」` : '已跟随系统默认设备');
  };

  const ensureAudioAnalysis = useCallback(async () => {
    const audio = audioRef.current;
    const analysis = analysisRef.current;
    // 原生输出模式：绝不接管音频。外接音箱/蓝牙的路由交给浏览器，音质优先。
    if (outputPrefRef.current.mode === 'direct') return;
    const AudioEngine = window.AudioContext || window.webkitAudioContext;
    // 内核不支持或之前接管失败过：直接按原生输出放，别把播放一起拖死
    if (!AudioEngine || analysis.takeoverFailed) return;
    if (!analysis.context) {
      try {
        // latencyHint 默认是 interactive（约 128 帧的小缓冲），蓝牙和 USB 声卡上
        // 很容易 buffer underrun，表现就是声音断续、咔哒声。playback 用大缓冲，稳得多。
        try {
          analysis.context = new AudioEngine({ latencyHint: 'playback' });
        } catch {
          analysis.context = new AudioEngine();
        }
        analysis.analyser = analysis.context.createAnalyser();
        analysis.analyser.fftSize = 128;
        analysis.analyser.smoothingTimeConstant = 0.6;
        analysis.spectrum = new Uint8Array(analysis.analyser.frequencyBinCount);
        analysis.source = analysis.context.createMediaElementSource(audio);
        analysis.source.connect(analysis.analyser);
        analysis.analyser.connect(analysis.context.destination);
        // 地形背景需要更细的频谱：单独挂一个高分辨率 analyser，节拍检测也走它
        analysis.fine = analysis.context.createAnalyser();
        analysis.fine.fftSize = 1024;
        analysis.fine.smoothingTimeConstant = 0.55;
        analysis.fineBins = new Uint8Array(analysis.fine.frequencyBinCount);
        analysis.source.connect(analysis.fine);
        // 只有在菜单里明确挑了设备才去改输出口，否则一律不碰，
        // 免得每次开播都把外接音箱/蓝牙的链路重新协商一遍。
        if (outputPrefRef.current.deviceId) applySink(audio, analysis.context, outputPrefRef.current.deviceId);
      } catch {
        // 部分移动端内核（老 WebView / WeChat X5）createMediaElementSource 会抛异常，
        // 之前这里直接把 startPlayback 一起 catch 掉了，表现是根本不出声。
        // 现在兜底：标记失败并退回原生输出，律动没了但声音必须正常。
        analysis.context = null;
        analysis.analyser = null;
        analysis.source = null;
        analysis.fine = null;
        analysis.takeoverFailed = true;
        setOutputPref(previous => (previous.mode === 'direct' ? previous : { ...previous, mode: 'direct' }));
        showToast('当前浏览器不支持律动接管，已用原生输出播放');
        return;
      }
    }
    if (analysis.context.state === 'suspended') await analysis.context.resume();
  }, [setOutputPref, showToast]);

  // 播放前先把歌词和音源都等齐：歌词最慢等 2.6s，音源最慢等 8s，
  // 超时就直接开播，宁可歌词晚一点到，也不能卡住不出声。
  const startPlayback = useCallback(async () => {
    if (preparingRef.current) return;
    preparingRef.current = true;
    cancelPlayRef.current = false;
    setPreparing(true);
    clearTimeout(slowHintTimer.current);
    slowHintTimer.current = setTimeout(() => showToast('正在准备歌词与音源…'), 700);
    try {
      await ensureAudioAnalysis();
      await waitForLrc(tracks[currentRef.current].lyrics, 2600);
      await waitUntilPlayable(audioRef.current, 8000);
      // 等待期间用户又点了暂停，就别再自作主张地播出来
      if (!cancelPlayRef.current) await audioRef.current.play();
    } catch {
      showToast('本地音源暂时无法播放');
    } finally {
      clearTimeout(slowHintTimer.current);
      preparingRef.current = false;
      setPreparing(false);
    }
  }, [ensureAudioAnalysis, showToast]);

  const selectTrack = useCallback((id, shouldPlay = false) => {
    const next = (id + tracks.length) % tracks.length;
    const audio = audioRef.current;
    if (next !== current || audio.currentSrc !== new URL(tracks[next].src, location.href).href) {
      setCurrent(next);
      currentRef.current = next;
      setCurrentTime(0);
      setDuration(0);
      audio.src = tracks[next].src;
      audio.load();
    }
    // 选歌的那一刻就开始拉歌词，真正点播放时通常已经就绪
    prefetchLrc(tracks[next].lyrics);
    if (shouldPlay) startPlayback();
  }, [current, startPlayback]);

  const step = direction => {
    const next = random ? (current + 1 + Math.floor(Math.random() * (tracks.length - 1))) % tracks.length : current + direction;
    selectTrack(next, !audioRef.current.paused);
  };

  const track = tracks[current];
  return (
    <>
      <SvgDefs />
      <Header journal={journal} onChangeView={setJournal} />
      {journal ? <Journal onOpen={setSelected} /> : (
        <Universe
          current={current}
          playing={playing}
          currentTime={currentTime}
          duration={duration}
          onSelect={selectTrack}
          zoom={zoom}
          backdropMode={backdropMode}
          onBackdrop={() => {
            const next = (backdropMode + 1) % backdropNames.length;
            setBackdropMode(next);
            showToast(`背景已切换为「${backdropNames[next]}」`);
          }}
          onRotateToast={showToast}
          onZoom={amount => setZoom(value => clamp(value + amount, 0.65, 1.35))}
          analysisRef={analysisRef}
          audioRef={audioRef}
        />
      )}
      <Player
        track={track}
        current={current}
        playing={playing}
        preparing={preparing}
        currentTime={currentTime}
        duration={duration}
        random={random}
        repeat={repeat}
        liked={liked.has(current)}
        volume={volume}
        muted={muted}
        outputPref={outputPref}
        outputs={outputs}
        outputMenu={outputMenu}
        onOutputToggle={openOutputMenu}
        onOutputPick={chooseOutput}
        onPlay={() => {
          if (audioRef.current.paused) startPlayback();
          else { cancelPlayRef.current = true; audioRef.current.pause(); }
        }}
        onStep={step}
        onSeek={value => { audioRef.current.currentTime = value; setCurrentTime(value); }}
        onShuffle={() => { setRandom(value => !value); showToast(random ? '按顺序播放' : '随机漫游已开启'); }}
        onRepeat={() => { setRepeat(value => !value); showToast(repeat ? '播放结束后自动切歌' : '单曲循环'); }}
        onFavorite={() => setLiked(value => {
          const next = new Set(value);
          next.has(current) ? next.delete(current) : next.add(current);
          showToast(next.has(current) ? '已收藏这首歌曲' : '已取消收藏');
          return next;
        })}
        onVolume={value => { setVolume(value); setMuted(false); audioRef.current.volume = value; audioRef.current.muted = false; }}
        onMute={() => { const value = !muted; setMuted(value); audioRef.current.muted = value; }}
        onOpen={() => setSelected(current)}
      />
      {selected !== null && <DetailDialog track={tracks[selected]} onClose={() => setSelected(null)} onPlay={id => { selectTrack(id, true); setSelected(null); }} />}
      <div id="toast" className={toastText ? 'show' : ''} role="status">{toastText}</div>
      <audio
        ref={audioRef}
        preload="auto"
        onPlay={() => {
          setPlaying(true);
          // iOS 上 AudioContext 的 resume 必须贴近用户手势，播放事件里再兜一次底，
          // 否则会出现「进度在走但没有声音」的假播放状态。
          analysisRef.current.context?.resume?.().catch(() => {});
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={event => {
          const time = event.currentTarget.currentTime || 0;
          setCurrentTime(time);
          // 断点记忆每 2 秒写一次，够还原又不会一直打本地存储
          if (Math.floor(time) % 2 === 0) saveProgress(currentRef.current, time);
        }}
        onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onCanPlay={() => {
          // 当前这首已经能播了，顺手把下一首的歌词和音频一并预热
          const next = tracks[(currentRef.current + 1) % tracks.length];
          prefetchLrc(next.lyrics);
          prefetchAudio(next.src);
        }}
        onEnded={() => {
          if (repeat) startPlayback();
          else {
            const next = random ? (current + 1 + Math.floor(Math.random() * (tracks.length - 1))) % tracks.length : current + 1;
            selectTrack(next, true);
          }
        }}
        // 蓝牙/外接设备断开或切换时音源会被掐掉，等它回来自动接上
        onEmptied={() => { if (playingRef.current) showToast('音源已断开，等待重连…'); }}
        onStalled={() => { if (playingRef.current) reconnect(); }}
        onWaiting={() => { if (playingRef.current) showToast('正在缓冲音源…'); }}
        onError={() => {
          saveProgress(currentRef.current, audioRef.current.currentTime || 0);
          showToast('音源中断，正在重连…');
          reconnect();
        }}
      />
    </>
  );
}
