import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerQQMusicExpressRoutes } from './server/qq-music.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 45437);
const server = express();

server.use(express.json({ limit: '256kb' }));
registerQQMusicExpressRoutes(server);
server.use(express.static(path.join(__dirname, 'dist')));
server.get('*', (_request, response) => {
  response.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ORBIT Music is running at http://127.0.0.1:${port}`);
});
