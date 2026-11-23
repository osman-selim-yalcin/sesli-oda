// Test yardımcıları: Supabase'siz sunucu başlatır, soket ve HTTP çağrıları sarar.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');

// İşletim sisteminden boş bir port ister.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Sunucuyu preload ile (Supabase kapalı) başlatır; "çalışıyor" satırını bekler.
// env: sunucuya eklenecek ortam değişkenleri (ör. { REJOIN_GRACE_MS: '400' }).
async function startServer({ env = {} } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['-r', './test/preload.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('Sunucu açılmadı:\n' + log)); }, 15000);
    const onData = (d) => {
      log += d;
      if (log.includes('çalışıyor')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { log += d; });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Sunucu kapandı (${code}):\n` + log)); });
  });
  child.removeAllListeners('exit');
  return { url: `http://localhost:${port}`, port, stop };
}

// Bağlı socket.io istemcisi; token 'test:<ad>'. opts socket.io-client'a geçer (ör. extraHeaders).
function client(url, name, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], forceNew: true, ...opts });
    socket.token = 'test:' + name;
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

// Ack'li emit; süre dolarsa reddeder.
function ack(socket, event, payload, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack zaman aşımı: ${event}`)), ms);
    socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

// Bir sonraki olayı bekler; süre dolarsa reddeder.
function next(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`olay zaman aşımı: ${event}`)); }, ms);
    function onEvent(data) { clearTimeout(timer); resolve(data); }
    socket.once(event, onEvent);
  });
}

// HTTP çağrısı; gövde JSON, cevap JSON'a çevrilir (çevrilemezse null). extra: eklenecek başlıklar.
async function http(url, method, p, { token, body, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

module.exports = { startServer, client, ack, http, next };
