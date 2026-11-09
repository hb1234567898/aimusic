import { useEffect, useLayoutEffect, useRef } from 'react';
import { lrcWordProgress } from './lyrics.js';

export default function LrcLine({ text, words, active, playing, currentTime, audioRef, analysisRef }) {
  const elements = useRef([]);
  const fallbackTime = useRef(currentTime);
  fallbackTime.current = currentTime;

  useLayoutEffect(() => {
    if (!words) return undefined;
    let frame = 0;
    const previous = [];
    const paint = () => {
      const engine = analysisRef?.current?.engine;
      const latency = engine && engine.mode !== 'none' ? engine.autoLatency || 0 : 0;
      const time = Math.max(0, (audioRef?.current?.currentTime ?? fallbackTime.current) - latency);
      words.forEach((word, index) => {
        const fill = active ? `${(lrcWordProgress(word, time) * 100).toFixed(2)}%` : '0%';
        if (previous[index] === fill) return;
        elements.current[index]?.style.setProperty('--word-fill', fill);
        previous[index] = fill;
      });
    };
    const tick = () => {
      paint();
      frame = requestAnimationFrame(tick);
    };
    paint();
    if (active && playing) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [words, active, playing, audioRef, analysisRef]);

  // Seeking while paused must repaint too; a running line uses the audio clock.
  useEffect(() => {
    if (playing || !active || !words) return;
    const engine = analysisRef?.current?.engine;
    const latency = engine && engine.mode !== 'none' ? engine.autoLatency || 0 : 0;
    const time = Math.max(0, currentTime - latency);
    words.forEach((word, index) => {
      elements.current[index]?.style.setProperty('--word-fill', `${lrcWordProgress(word, time) * 100}%`);
    });
  }, [currentTime, playing, active, words, analysisRef]);

  return (
    <span className={`lyric-original${words ? ' has-word-timing' : ''}`}>
      {words ? words.map((word, index) => (
        <span className="lyric-word" key={index} ref={element => { elements.current[index] = element; }}>{word.text}</span>
      )) : text}
    </span>
  );
}
