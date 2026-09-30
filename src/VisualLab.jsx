import React, { useEffect, useRef, useState } from 'react';
import { BeatEngine } from './beatEngine.js';
import { tracks } from './tracks.js';
import { createMoodState, readBands, updateMoodProfile } from './visualLabRenderer.js';
import { createTerrainGL } from './terrainGL.js';
import './visual-lab.css';

const MODES = [
  { id: 'native', index: '01', name: '原生地形', en: 'SONIC TOPOGRAPHY', note: '直接复用播放器的 24,025 根实例音柱、八频段地形模型和原作相机，不做简化。', terrain: { theme: 'minimal-monochrome', amplitude: 1 } },
  { id: 'tide', index: '02', name: '缓潮地形', en: 'SLOW TIDE', note: '保留原生音柱与透视，把整体振幅压低，并用稳定的宽波纹承接舒缓和低落段落。', terrain: { theme: 'soft-graphite', amplitude: 0.72, rippleInterval: 1.8, rippleStrength: 0.72, rippleType: 0, onsetRipples: false } },
  { id: 'impact', index: '03', name: '节拍波阵', en: 'IMPACT FIELD', note: '固定间隔向原生地形注入落点，波前沿音柱传播；音乐仍负责地形高度和频段分区。', terrain: { theme: 'minimal-monochrome', amplitude: 0.96, rippleInterval: 0.72, rippleStrength: 0.9, rippleType: 1, onsetRipples: false } },
  { id: 'peaks', index: '04', name: '峰值矩阵', en: 'PEAK MATRIX', note: '提高原生地形的频段振幅和明暗反差，让重拍、低频核心与高频尖柱更直接。', terrain: { theme: 'high-contrast', amplitude: 1.32 } },
];

export default function VisualLab() {
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const graphRef = useRef(null);
  const glRef = useRef(null);
  const sensitivityRef = useRef(1);
  const meterRef = useRef(null);
  const fpsRef = useRef(null);
  const moodLabelRef = useRef(null);
  const moodStateRef = useRef(createMoodState());
  const customUrlRef = useRef('');
  const [mode, setMode] = useState('native');
  const [trackIndex, setTrackIndex] = useState(0);
  const [customTrack, setCustomTrack] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [sensitivity, setSensitivity] = useState(1);
  const [error, setError] = useState('');

  const selectedMode = MODES.find(item => item.id === mode) || MODES[0];
  const track = tracks[trackIndex] || tracks[0];
  const activeSource = customTrack?.url || track.src;

  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const profile = MODES.find(item => item.id === mode) || MODES[0];
    let renderer = null;
    try {
      renderer = createTerrainGL(canvas, {
        mobile: window.innerWidth < 760,
        ...profile.terrain,
      });
      if (!renderer) throw new Error('当前设备不支持 WebGL2');
      glRef.current = renderer;
      setError('');
    } catch (reason) {
      setError(reason?.message || '声波地形初始化失败');
    }
    return () => {
      renderer?.dispose();
      if (glRef.current === renderer) glRef.current = null;
    };
  }, [mode]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.load();
    moodStateRef.current = createMoodState();
    setPlaying(false);
    setError('');
  }, [trackIndex, customTrack]);

  useEffect(() => () => {
    if (customUrlRef.current) URL.revokeObjectURL(customUrlRef.current);
  }, []);

  const chooseLocalAudio = event => {
    const file = event.target.files?.[0];
    if (!file) return;
    audioRef.current?.pause();
    if (customUrlRef.current) URL.revokeObjectURL(customUrlRef.current);
    const url = URL.createObjectURL(file);
    customUrlRef.current = url;
    setCustomTrack({ name: file.name.replace(/\.[^.]+$/, ''), url });
    event.target.value = '';
  };

  const chooseBuiltInTrack = event => {
    audioRef.current?.pause();
    if (customUrlRef.current) URL.revokeObjectURL(customUrlRef.current);
    customUrlRef.current = '';
    setCustomTrack(null);
    setTrackIndex(Number(event.target.value));
  };

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
    let frameId = 0;
    let last = performance.now();
    let fpsTime = last;
    let fpsFrames = 0;
    const render = timestamp => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, rect.width < 760 ? 0.9 : 1);
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
        playing: Boolean(graph && !audioRef.current?.paused),
      };
      data.mood = updateMoodProfile(moodStateRef.current, data);
      const renderer = glRef.current;
      if (renderer) {
        renderer.resize(rect.width, rect.height, dpr);
        renderer.frame({
          time,
          dt,
          bins,
          sampleRate,
          energy: data.energy,
          kickEnvelope: data.hit,
          onset: data.onset,
          onsetHigh: data.onsetHigh,
          playing: data.playing,
          interacting: false,
          sensitivity: sensitivityRef.current,
        });
      }
      const pulse = Math.max(data.hit, data.hitHigh * 0.7, data.energy * 0.45);
      document.documentElement.style.setProperty('--lab-beat', pulse.toFixed(3));
      if (meterRef.current) meterRef.current.style.transform = `scaleX(${Math.max(0.018, data.energy)})`;
      if (moodLabelRef.current) moodLabelRef.current.textContent = data.mood.label;
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
          <span ref={moodLabelRef}>静候播放</span>
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
          <div className="lab-track-head">
            <label htmlFor="lab-track-select">当前测试音乐</label>
            <label className="lab-import">选择本地慢歌<input type="file" accept="audio/*" onChange={chooseLocalAudio} /></label>
          </div>
          <select id="lab-track-select" value={customTrack ? '' : trackIndex} onChange={chooseBuiltInTrack}>
            {customTrack ? <option value="">本地 · {customTrack.name}</option> : null}
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
        <span>WEBGL2 · 24,025 INSTANCED COLUMNS</span>
        <span>点击左侧编号切换</span>
      </footer>
      {error ? <div className="lab-error">{error}</div> : null}
      <audio
        ref={audioRef}
        src={activeSource}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </main>
  );
}
