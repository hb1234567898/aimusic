import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const preferredPort = Number(process.env.ORBIT_ELECTRON_DEV_PORT || '8765');

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findPort(start) {
  for (let port = start; port < start + 30; port += 1) if (await isPortAvailable(port)) return port;
  throw new Error(`没有可用端口：${start}-${start + 29}`);
}

function run(command, args, options = {}) {
  return spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
}

function waitForHttp(url, timeout = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => { response.resume(); resolve(); });
      request.on('error', () => Date.now() - started > timeout ? reject(new Error(`等待 ${url} 超时`)) : setTimeout(check, 250));
      request.setTimeout(1000, () => request.destroy());
    };
    check();
  });
}

const port = await findPort(preferredPort);
const url = `http://127.0.0.1:${port}`;
const vite = run('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort']);
let electron = null;
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  if (electron && !electron.killed) electron.kill();
  if (!vite.killed) vite.kill();
  process.exit(code);
};
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
vite.on('exit', (code) => { if (!stopping) stop(code ?? 1); });

try {
  await waitForHttp(url);
  electron = run('npx', ['electron', '.'], { env: { ...process.env, ORBIT_ELECTRON_DEV_URL: url } });
  electron.on('exit', (code) => stop(code ?? 0));
} catch (error) {
  console.error(error);
  stop(1);
}
