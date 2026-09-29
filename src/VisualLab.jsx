import React, { useEffect, useRef, useState } from 'react';
import { BeatEngine } from './beatEngine.js';
import { tracks } from './tracks.js';
import { createVisualState, drawVisual, readBands } from './visualLabRenderer.js';
import './visual-lab.css';

const MODES = [
  { id: 'orbit', index: '01', name: '轨道冠冕', en: 'ORBIT CROWN', note: '频谱沿圆周折叠，低频推动内核，重拍向外发射断续波前。' },
  { id: 'canyon', index: '02', name: '频谱峡谷', en: 'SPECTRAL CANYON', note: '把连续频谱保存成纵深切片，鼓点抬高近景，形成向前流动的声场。' },
  { id: 'ribbons', index: '03', name: '液态丝带', en: 'LIQUID RIBBONS', note: '八个频段各自保留运动轨迹，军鼓和镲片变成穿过丝带的瞬态闪光。' },
  { id: 'sphere', index: '04', name: '脉冲球体', en: 'PULSE SPHERE', note: '频段能量映射到球面纬度，细频谱控制颗粒起伏，底鼓负责整体呼吸。' },
];

export default function VisualLab() {
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const graphRef = useRef(null);
  const modeRef = useRef('orbit');
  const sensitivityRef = useRef(1);
  const meterRef = useRef(null);
  const fpsRef = useRef(null);
  const visualStates = useRef(Object.fromEntries(MODES.map(mode => [mode.id, createVisualState()])));
  const [mode, setMode] = useState('orbit');
  const [trackIndex, setTrackIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sensitivity, setSensitivity] = useState(1);
  const [error, setError] = useState('');

  const selectedMode = MODES.find(item => item.id === mode) || MODES[0];
  const track = tracks[trackIndex] || tracks[0];

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.load();
    setPlaying(false);
    setError('');
  }, [trackIndex]);

  const ensureGraph = async () => {
    if (graphRef.current) {
      await graphRef.current.context.resume();
      return graphRef.current;
    }
    const audio = audioRef.current;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio');
    const context = new AudioContextClass({ latencyHint: 'interactive' });
    const source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.42;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);
    source.connect(context.destination);
    const engine = new BeatEngine(context, source, { lowLatency: true });
    await engine.start();
    graphRef.current = { context, source, analyser, bins, engine };
    return graphRef.current;
  };

  const toggle = async () => {
    const audio = audioRef.current;
    try {
      await ensureGraph();
      if (audio.paused) await audio.play(); else audio.pause();
    } catch (reason) {
      setError(reason?.message || '音频无法播放');
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const context2d = canvas.getContext('2d', { alpha: true });
    let frameId = 0;
    let last = performance.now();
    let fpsTime = last;
    let fpsFrames = 0;
    const render = timestamp => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
      const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
      const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      const dt = Math.min(0.05, Math.max(0.001, (timestamp - last) / 1000));
      last = timestamp;
      const graph = graphRef.current;
      let sample = { bass: 0, treble: 0, hit: 0, hitHigh: 0, onset: 0, onsetHigh: 0, level: 0 };
      let bins = null;
      let sampleRate = 44100;
      if (graph) {
        graph.analyser.getByteFrequencyData(graph.bins);
        bins = graph.bins;
        sampleRate = graph.context.sampleRate;
        sample = graph.engine.sample(graph.context.currentTime, dt);
      }
      const bands = readBands(bins, sampleRate);
      const time = timestamp / 1000;
      const data = {
        time,
        dt,
        bins,
        bands,
        energy: sample.level || 0,
        bass: sample.bass || 0,
        treble: sample.treble || 0,
        hit: sample.hit || 0,
        hitHigh: sample.hitHigh || 0,
        onset: sample.onset || 0,
        onsetHigh: sample.onsetHigh || 0,
        sensitivity: sensitivityRef.current,
      };
      drawVisual(context2d, rect.width, rect.height, modeRef.current, data, visualStates.current[modeRef.current]);
      const pulse = Math.max(data.hit, data.hitHigh * 0.7, data.energy * 0.45);
      document.documentElement.style.setProperty('--lab-beat', pulse.toFixed(3));
      if (meterRef.current) meterRef.current.style.transform = `scaleX(${Math.max(0.018, data.energy)})`;
      fpsFrames += 1;
      if (timestamp - fpsTime > 700) {
        if (fpsRef.current) fpsRef.current.textContent = `${Math.round(fpsFrames * 1000 / (timestamp - fpsTime))} FPS`;
        fpsFrames = 0;
        fpsTime = timestamp;
      }
      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => () => {
    const graph = graphRef.current;
    graph?.engine.dispose();
    graph?.context.close().catch(() => {});
  }, []);

  return (
    <main className="lab-shell">
      <canvas ref={canvasRef} className="lab-canvas" aria-hidden="true" />
      <div className="lab-vignette" aria-hidden="true" />

      <header className="lab-header">
        <a className="lab-brand" href="./index.html" aria-label="返回 ORBIT 播放器">
          <span className="lab-mark"><i /></span>
          <b>ORBIT</b>
          <em>RHYTHM LAB</em>
        </a>
        <div className="lab-status">
          <span ref={fpsRef}>60 FPS</span>
          <i />
          <span>LIVE AUDIO / 8 BANDS</span>
        </div>
      </header>

      <section className="lab-copy" aria-live="polite">
        <span>{selectedMode.index} / 04 · {selectedMode.en}</span>
        <h1>{selectedMode.name}</h1>
        <p>{selectedMode.note}</p>
      </section>

      <nav className="lab-modes" aria-label="选择律动算法">
        {MODES.map(item => (
          <button
            key={item.id}
            className={item.id === mode ? 'active' : ''}
            onPointerDown={() => setMode(item.id)}
            onClick={() => setMode(item.id)}
          >
            <span>{item.index}</span>
            <strong>{item.name}</strong>
            <small>{item.en}</small>
          </button>
        ))}
      </nav>

      <section className="lab-transport">
        <img src={track.cover} alt="" />
        <div className="lab-track">
          <label htmlFor="lab-track-select">当前测试音乐</label>
          <select id="lab-track-select" value={trackIndex} onChange={event => setTrackIndex(Number(event.target.value))}>
            {tracks.map((item, index) => <option value={index} key={item.id}>{item.title} — {item.artist}</option>)}
          </select>
        </div>
        <button className="lab-play" onClick={toggle} aria-label={playing ? '暂停' : '播放'}>
          <span>{playing ? 'Ⅱ' : '▶'}</span>
        </button>
        <div className="lab-sensitivity">
          <label htmlFor="lab-sensitivity">灵敏度 <b>{sensitivity.toFixed(1)}×</b></label>
          <input id="lab-sensitivity" type="range" min="0.6" max="1.8" step="0.1" value={sensitivity} onChange={event => setSensitivity(Number(event.target.value))} />
        </div>
        <div className="lab-level" aria-label="实时音量"><i ref={meterRef} /></div>
      </section>

      <footer className="lab-footer">
        <span>同一套频段数据 · 四种空间映射</span>
        <span>点击左侧编号切换</span>
      </footer>
      {error ? <div className="lab-error">{error}</div> : null}
      <audio
        ref={audioRef}
        src={track.src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </main>
  );
}
