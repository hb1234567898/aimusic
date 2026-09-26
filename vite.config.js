import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { registerQQMusicViteMiddlewares } from './server/qq-music.mjs';

const buildVersion = Date.now().toString(36);

function writeJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function qqMusicBridge() {
  return {
    name: 'orbit-qq-music-bridge',
    configureServer(server) {
      registerQQMusicViteMiddlewares(server, writeJson);
    },
  };
}

export default defineConfig({
  // 打包后可以放在任意子目录或 Android WebView 的本地目录中。
  base: './',
  plugins: [react(), qqMusicBridge()],
  // public 目录里的音乐不会被 Vite 改成哈希文件名；给每次构建注入版本号，
  // 由 tracks.js 拼到音频、封面和歌词 URL 上，绕过 ColorOS 的强缓存。
  define: {
    'import.meta.env.VITE_ORBIT_ASSET_VERSION': JSON.stringify(buildVersion),
  },
  build: {
    assetsInlineLimit: 0,
    // 沙箱环境的批量删除保护会拦下 vite 清空 dist 的操作（assets 超过阈值），
    // 改为不清空输出目录：产物带内容哈希，旧文件只是冗余不会冲突。
    emptyOutDir: false,
  },
});
