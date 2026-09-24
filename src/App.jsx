import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tracks } from './tracks.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const backdropNames = ['星尘点阵', '声波轨道', '呼吸星云', '律动地形'];

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
        <symbol id="i-orbit" viewBox="0 0 40 40"><ellipse cx="20" cy="20" rx="18" ry="8" transform="rotate(-35 20 20)" /><circle cx="20" cy="20" r="5" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-shuffle" viewBox="0 0 24 24"><path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 4-3 5-5m3-4c1-2 2-3 4-3h3m-4-4 4 4-4 4" /></symbol>
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

function isLyricLine(text) {
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  return !/^(作词|作詞|作曲|编曲|編曲|制作人|製作人|监制|監製|混音|录音|錄音|吉他|贝斯|貝斯|和声|和聲|母带|母帶|原唱|翻唱|原曲|二创|二創|中文翻译|中文翻譯|制作|製作|词|詞|曲)\s*[:：\-]/i.test(text);
}

function parseSyncedLyrics(value) {
  return (value || '').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.+)$/);
    if (!match) return [];
    const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
    return [{ time: Number(match[1]) * 60 + Number(match[2]) + fraction, text: match[4].trim() }];
  }).filter(row => row.text && isLyricLine(row.text));
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
    const controller = new AbortController();
    setRows([{ time: 0, text: '正在载入本地同步歌词…' }]);
    setState('loading');
    fetch(track.lyrics, { cache: 'no-store', signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Local lyrics ${response.status}`);
        return response.text();
      })
      .then(value => {
        const parsed = parseSyncedLyrics(value);
        if (parsed.length) {
          setRows(parsed);
          setState('local');
        } else {
          setRows([{ time: 0, text: '当前歌词文件没有可读取的时间轴' }]);
          setState('missing');
        }
      })
      .catch(error => {
        if (error.name === 'AbortError') return;
        setRows([{ time: 0, text: '本地歌词暂时无法读取' }]);
        setState('error');
      });
    return () => controller.abort();
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

  const rowHeight = mobile ? 44 : 56;
  const centerOffset = mobile ? 51 : 63;
  const source = state === 'local' ? '本地同步歌词' : state === 'loading' ? '正在载入本地歌词' : state === 'missing' ? '歌词文件没有时间轴' : '本地歌词暂时无法读取';

  return (
    <div className={`intro ${playing ? 'is-playing' : ''}`} id="lyrics-panel" aria-live="polite">
      <span className="eyebrow">{playing ? 'NOW PLAYING' : 'READY TO PLAY'} · TRACK {String(trackNumber).padStart(2, '0')}</span>
      <div className="lyrics-viewport">
        <div className="lyrics-track" style={{ transform: `translate3d(0,${centerOffset - activeIndex * rowHeight}px,0)` }}>
          {rows.map((row, index) => (
            <div className={`lyric-row ${index === activeIndex ? 'active' : ''} ${Math.abs(index - activeIndex) === 1 ? 'near' : ''}`} key={`${row.time}-${index}`}>
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

    const audioEnergy = () => {
      const analysis = analysisRef.current;
      let target = 0;
      if (analysis.analyser && propsRef.current.playing) {
        analysis.analyser.getByteFrequencyData(analysis.spectrum);
        const usefulBins = Math.min(24, analysis.spectrum.length);
        let total = 0;
        for (let index = 0; index < usefulBins; index += 1) total += analysis.spectrum[index] * (1 - index / usefulBins * 0.35);
        target = total / usefulBins / 255;
      }
      analysis.energy += (target - analysis.energy) * (target > analysis.energy ? 0.3 : 0.075);
      return analysis.energy;
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
          const value = sum / (hi - lo) / 255;
          topoBands[i] += (value - topoBands[i]) * (value > topoBands[i] ? 0.4 : 0.12);
        }
        for (let i = 0; i < 4; i += 1) bass += topoBands[i];
        bass /= 4;
      } else {
        // 没在播放时缓慢回落，最后只剩一层静态的矮格子
        for (let i = 0; i < TOPO_BANDS; i += 1) topoBands[i] += (0 - topoBands[i]) * 0.04;
      }
      if (bass - topoBeatMark > 0.18) {
        topoRipples.push({ t0: time, amp: bass });
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
          const center = Math.exp(-(dist * dist) / (maxR * maxR * 0.10)) * subBass * 185;
          const wave = (Math.sin(x * 0.012 + time * 0.6) * Math.cos(z * 0.010 - time * 0.45) * 0.5 + 0.5) * lowMid * 96;
          const flow = (Math.sin((x + z) * 0.016 - time * 1.1) * 0.5 + 0.5) * mid * 74;
          const spike = Math.sin(x * 0.037 + topoSeed) * Math.cos(z * 0.029 - topoSeed) > 0.86 ? highMid * 145 : 0;
          const spark = Math.sin(x * 0.05 + topoSeed) * Math.cos(z * 0.043 - topoSeed) > 0.87 ? presence * 122 : 0;
          const grain = air * 26 * (Math.sin(x * 0.09 + time * 3) * Math.cos(z * 0.08 - time * 2.4) * 0.5 + 0.5);
          let rip = 0;
          for (let ri = 0; ri < topoRipples.length; ri += 1) {
            const age = time - topoRipples[ri].t0;
            const d = Math.abs(dist - age * 620);
            if (d < 220) rip += Math.cos(d / 220 * Math.PI / 2) * topoRipples[ri].amp * 92 * Math.max(0, 1 - age / 3.2);
          }
          // 静止时也留一层极缓的呼吸，画面不至于完全死掉
          const idle = 6 * (Math.sin(x * 0.006 + time * 0.35) * Math.cos(z * 0.005 - time * 0.28) * 0.5 + 0.5);
          const h = 8 + center + wave + flow + spike + spark + grain + rip + idle;
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

    const drawSoundfield = timestamp => {
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
      const energy = reducedMotion.matches ? 0 : audioEnergy();
      const time = timestamp * 0.001;
      document.getElementById('lyrics-panel')?.style.setProperty('--beat', energy.toFixed(3));

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
            dot(x, y, 0.42 + wave * 0.32 + energy * falloff * 2.4, 0.045 + falloff * 0.055 + energy * falloff * 0.24);
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
            const lift = Math.sin(angle * 3 - time * 2.4) * energy * 12;
            dot(centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY + lift, 0.45 + energy * 1.9, 0.05 + energy * 0.22);
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
          const drift = reducedMotion.matches ? 0 : Math.sin(time * 0.35 + index) * (2 + energy * 8);
          dot(seedX * width + drift, seedY * height, 0.4 + shimmer * 0.65 + energy * 1.8, 0.035 + shimmer * 0.08 + energy * 0.16);
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
        const scale = (0.36 + (depth + 1) * 0.31) * (active ? 1.07 : 1);
        element.style.transform = `translate3d(-50%,-50%,0) translate3d(${x * radiusX}px,${projectedY * radiusY + (mobile ? 45 : 10)}px,0) scale(${scale}) rotateY(${x * -16}deg) rotateZ(${x * projectedY * 5}deg)`;
        // 背面卡片直接淡到不可见，避免在正面卡片后面堆成一列
        const fade = Math.max(0, Math.min(1, (depth + 0.5) / 1.5));
        element.style.opacity = String(active ? 1 : 0.05 + fade * fade * 0.85);
        element.style.visibility = (!active && fade <= 0.002) ? 'hidden' : 'visible';
        element.style.filter = `brightness(${0.45 + (depth + 1) * 0.3})`;
        element.style.zIndex = String(active ? 90 : Math.round((depth + 1) * 30) + 1);
        const interactive = depth >= -0.3;
        element.style.pointerEvents = interactive ? 'auto' : 'none';
        element.tabIndex = interactive ? 0 : -1;
      });
    };

    const animate = timestamp => {
      const dt = Math.min(timestamp - lastFrame || 16, 32);
      lastFrame = timestamp;
      if (propsRef.current.playing && focusedTrack !== propsRef.current.current) {
        focusedTrack = propsRef.current.current;
        focusTrack(focusedTrack);
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
      drawSphere();
      drawSoundfield(timestamp);
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
      if (propsRef.current.playing) focusTrack(propsRef.current.current);
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

function Player({ track, current, playing, currentTime, duration, random, repeat, liked, volume, muted, onPlay, onStep, onSeek, onShuffle, onRepeat, onFavorite, onVolume, onMute, onOpen }) {
  const progress = duration ? currentTime / duration * 100 : 0;
  return (
    <footer className="player glass">
      <div className="now">
        <LiquidArt src={track.cover} alt={`${track.album} 专辑封面`} className="now-art" />
        <div className="now-copy"><div className="now-title">{track.title}</div><div className="now-sub">{track.artist} · {track.album}</div></div>
        <button className={`icon favorite ${liked ? 'liked' : ''}`} onClick={onFavorite} aria-label={liked ? '取消收藏当前歌曲' : '收藏当前歌曲'} aria-pressed={liked}><Icon name="heart" /></button>
      </div>
      <div className="playback">
        <div className="transport">
          <button className="icon secondary" onClick={onShuffle} aria-label="随机播放" aria-pressed={random}><Icon name="shuffle" /></button>
          <button className="icon" onClick={() => onStep(-1)} aria-label="上一首"><Icon name="next" className="flip" /></button>
          <button className="play" onClick={onPlay} aria-label={playing ? '暂停' : '播放'}><Icon name={playing ? 'pause' : 'play'} /></button>
          <button className="icon" onClick={() => onStep(1)} aria-label="下一首"><Icon name="next" /></button>
          <button className="icon secondary" onClick={onRepeat} aria-label="循环播放" aria-pressed={repeat}>↻</button>
        </div>
        <div className="timeline">
          <time>{formatTime(currentTime)}</time>
          <input type="range" min="0" max={duration || 100} value={currentTime} step="0.1" aria-label="播放进度" style={{ '--fill': `${progress}%` }} onChange={event => onSeek(Number(event.target.value))} />
          <time>{formatTime(duration)}</time>
        </div>
      </div>
      <div className="player-right">
        <span>TRACK / {String(current + 1).padStart(2, '0')}</span>
        <button className="icon" onClick={onMute} aria-label={muted ? '取消静音' : '静音'} style={{ opacity: muted ? 0.4 : 1 }}><Icon name="vol" /></button>
        <input type="range" min="0" max="1" step=".01" value={volume} aria-label="音量" style={{ '--fill': `${volume * 100}%` }} onChange={event => onVolume(Number(event.target.value))} />
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
  const analysisRef = useRef({ context: null, analyser: null, spectrum: null, source: null, fine: null, fineBins: null, energy: 0 });
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

  const showToast = useCallback(message => {
    setToastText(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(''), 2200);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => {
    const audio = audioRef.current;
    audio.src = tracks[0].src;
    audio.volume = 0.65;
    audio.load();
  }, []);

  const ensureAudioAnalysis = useCallback(async () => {
    const audio = audioRef.current;
    const analysis = analysisRef.current;
    const AudioEngine = window.AudioContext || window.webkitAudioContext;
    if (!AudioEngine) return;
    if (!analysis.context) {
      analysis.context = new AudioEngine();
      analysis.analyser = analysis.context.createAnalyser();
      analysis.analyser.fftSize = 128;
      analysis.analyser.smoothingTimeConstant = 0.78;
      analysis.spectrum = new Uint8Array(analysis.analyser.frequencyBinCount);
      analysis.source = analysis.context.createMediaElementSource(audio);
      analysis.source.connect(analysis.analyser);
      analysis.analyser.connect(analysis.context.destination);
      // 地形背景需要更细的频谱：单独挂一个高分辨率 analyser，不动上面的能量计算
      analysis.fine = analysis.context.createAnalyser();
      analysis.fine.fftSize = 1024;
      analysis.fine.smoothingTimeConstant = 0.72;
      analysis.fineBins = new Uint8Array(analysis.fine.frequencyBinCount);
      analysis.source.connect(analysis.fine);
    }
    if (analysis.context.state === 'suspended') await analysis.context.resume();
  }, []);

  const startPlayback = useCallback(async () => {
    try {
      await ensureAudioAnalysis();
      await audioRef.current.play();
    } catch {
      showToast('本地音源暂时无法播放');
    }
  }, [ensureAudioAnalysis, showToast]);

  const selectTrack = useCallback((id, shouldPlay = false) => {
    const next = (id + tracks.length) % tracks.length;
    const audio = audioRef.current;
    if (next !== current || audio.currentSrc !== new URL(tracks[next].src, location.href).href) {
      setCurrent(next);
      setCurrentTime(0);
      setDuration(0);
      audio.src = tracks[next].src;
      audio.load();
    }
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
        currentTime={currentTime}
        duration={duration}
        random={random}
        repeat={repeat}
        liked={liked.has(current)}
        volume={volume}
        muted={muted}
        onPlay={() => (audioRef.current.paused ? startPlayback() : audioRef.current.pause())}
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
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime || 0)}
        onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onEnded={() => {
          if (repeat) startPlayback();
          else {
            const next = random ? (current + 1 + Math.floor(Math.random() * (tracks.length - 1))) % tracks.length : current + 1;
            selectTrack(next, true);
          }
        }}
        onError={() => showToast('本地音源暂时无法读取')}
      />
    </>
  );
}
