import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// dvh 兜底：Chrome 108 以下、微信 X5、部分安卓 WebView 不认识 100dvh，
// 一旦不认识整条 height 声明就被丢掉，页面会塌成 header 那点高度。
// 这些内核上改用 JS 量出来的视口高度，通过 --app-vh 喂给样式表。
if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('height', '100dvh')) {
  const sync = () => {
    const height = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--app-vh', `${Math.round(height)}px`);
  };
  sync();
  window.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('resize', sync);
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
