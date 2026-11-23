// Oda teması: tema listesi, denemelik test teması (yalnız önyüklemeyle), yetki, bilinmeyen tema, odaya yayın,
// birleşik odada ev sahibinin teması.
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, client, ack, http, next } = require('./helpers');

const ROOT = path.join(__dirname, '..');
let srv;
const ADMIN = 'test:osyalcin';
const OWNER = 'test:Temasahip';
const OTHER = 'test:Temabaska';
const sockets = [];

before(async () => {
  srv = await startServer();
  for (const name of ['Temasahip', 'Temabaska']) {
    const r = await http(srv.url, 'POST', '/auth/register', { body: { name, password: 'hesap-sifre' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  for (const [name, owner] of [['Tema Oda', 'Temasahip'], ['Diger Oda', 'Temabaska']]) {
    const r = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name, owner } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

let cid = 0;
async function user(name) {
  const s = await client(srv.url, name);
  s.cid = `t${++cid}`;
  sockets.push(s);
  return s;
}
const join = (s, room) => ack(s, 'join', { token: s.token, clientId: s.cid, room });
const patch = (id, token, body) => http(srv.url, 'PATCH', `/rooms/${id}`, { token, body });
const listed = async (id) => (await http(srv.url, 'GET', '/rooms', { token: ADMIN })).json.rooms.find((r) => r.id === id);
// Belirtilen süre içinde olay gelmemeli.
const silent = (s, event, ms = 400) => next(s, event, ms).then((d) => assert.fail(`${event} gelmemeliydi: ${JSON.stringify(d)}`), () => {});

test('test önyüklemesiyle tema listesinde Gece Odası ve denemelik tema var; dosyaları sunulur', async () => {
  const r = await http(srv.url, 'GET', '/theme-list');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.themes.map((t) => t.id), ['gece', 'deneme']);
  const deneme = r.json.themes[1];
  assert.equal(deneme.icons, 'deneme');
  for (const k of ['bg', 'surface', 'text', 'accent']) assert.match(deneme.preview[k], /^#[0-9A-F]{6}$/i);
  const css = await fetch(`${srv.url}/themes/deneme.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(await css.text(), /--bg:/);
  const icons = await fetch(`${srv.url}/icons/ui/deneme.svg`);
  assert.equal(icons.status, 200);
  assert.match(await icons.text(), /<symbol id="i-play"[^>]*><g stroke-width="3"/);
});

test('denemelik tema önyükleme olmadan yok: rooms.js listesi, public/ ve istemci listesi yalnız gerçek temalar', () => {
  // rooms.js önyüklemesiz ayrı süreçte yüklenir (sunucu açılmaz, veritabanına gidilmez; ortam temizlenir).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/SUPABASE|TURN|CF_/.test(k)));
  const out = spawnSync(process.execPath, ['-e', "const r = require('./rooms'); process.stdout.write(JSON.stringify({ themes: r.THEMES, info: r.THEME_INFO }))"], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { themes: ['gece'], info: {} });
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/themes/deneme.css')), 'deneme.css public/ altında olmamalı');
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/icons/ui/deneme.svg')));
  const themeJs = fs.readFileSync(path.join(ROOT, 'public/theme.js'), 'utf8');
  assert.deepEqual(JSON.parse(themeJs.match(/const LIST = (\[[^\]]*\])/)[1].replace(/'/g, '"')), ['gece']);
  for (const f of ['server.js', 'rooms.js', 'public/theme.js', 'public/lobby.js', 'public/app.js']) {
    assert.ok(!/['"`/]deneme(\.css|\.svg|['"`])/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} denemelik temayı tanımamalı`);
  }
});

test('tema yetkisi: üye ve başka odanın sahibi 403; sahip ve site yöneticisi 200', async () => {
  const uye = await user('Temauye');
  assert.equal((await join(uye, 'tema-oda')).error, undefined);
  assert.equal((await patch('tema-oda', 'test:Temauye', { theme: 'deneme' })).status, 403);
  assert.equal((await patch('tema-oda', OTHER, { theme: 'deneme' })).status, 403);
  assert.equal((await listed('tema-oda')).theme, 'gece', 'reddedilen istek temayı değiştirmemeli');
  const r = await patch('tema-oda', OWNER, { theme: 'deneme' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.theme, 'deneme');
  const a = await patch('tema-oda', ADMIN, { theme: 'gece' });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal((await listed('tema-oda')).theme, 'gece');
});

test('bilinmeyen tema 400 ve değişmez; tür hatası da 400', async () => {
  for (const theme of ['yok-tema', 'Deneme', '', 7, null]) {
    const r = await patch('tema-oda', OWNER, { theme });
    assert.equal(r.status, 400, `${JSON.stringify(theme)} → ${r.status}`);
  }
  assert.equal((await listed('tema-oda')).theme, 'gece');
  const req = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name: 'Temasiz Oda', theme: 'yok-tema' } });
  assert.equal(req.status, 400);
});

test('tema değişince odadaki herkes room:theme alır, başka odadakiler almaz; listedekiler yeni temayı görür', async () => {
  const sahip = await user('Temasahip');
  const uye = await user('Temauye2');
  const baska = await user('Temabaska');
  const lobi = await user('Temalobi');
  assert.equal((await join(sahip, 'tema-oda')).error, undefined);
  assert.equal((await join(uye, 'tema-oda')).error, undefined);
  assert.equal((await join(baska, 'diger-oda')).error, undefined);
  assert.ok((await ack(lobi, 'hello', { token: lobi.token })).rooms);
  const got = [next(sahip, 'room:theme'), next(uye, 'room:theme')];
  const none = silent(baska, 'room:theme');
  const lobbyRooms = new Promise((resolve) => lobi.on('rooms', ({ rooms }) => {
    const r = rooms.find((x) => x.id === 'tema-oda');
    if (r?.theme === 'deneme') resolve(r);
  }));
  assert.equal((await patch('tema-oda', OWNER, { theme: 'deneme' })).status, 200);
  for (const g of await Promise.all(got)) assert.deepEqual(g, { id: 'tema-oda', theme: 'deneme' });
  await none;
  assert.equal((await lobbyRooms).theme, 'deneme');
  // Yeni giren odanın temasını join cevabında alır
  const yeni = await user('Temayeni');
  assert.equal((await join(yeni, 'tema-oda')).room.theme, 'deneme');
  assert.equal((await patch('tema-oda', OWNER, { theme: 'gece' })).status, 200);
});

test('birleşik odada ev sahibinin teması herkese gider; misafir odanın teması değişince kimseye gitmez, ayrılınca uygulanır', async () => {
  const host = await user('Temasahip');
  const guestOwner = await user('Temabaska');
  const guest = await user('Temamisafir');
  assert.equal((await join(host, 'tema-oda')).error, undefined);
  assert.equal((await join(guestOwner, 'diger-oda')).error, undefined);
  assert.equal((await join(guest, 'diger-oda')).error, undefined);
  // tema-oda (ev sahibi) birleşme ister, diger-oda sahibi kabul eder: diger-oda'dakiler tema-oda'ya taşınır
  const incoming = next(guestOwner, 'merge:incoming');
  assert.equal((await ack(host, 'merge:request', { from: 'tema-oda', to: 'diger-oda' })).error, undefined);
  const inc = await incoming;
  const moved = next(guest, 'room:moved');
  assert.equal((await ack(guestOwner, 'merge:answer', { id: inc.id, accept: true })).error, undefined);
  const m = await moved;
  assert.equal(m.room.id, 'tema-oda');
  assert.equal(m.room.theme, 'gece');

  const toGuest = next(guest, 'room:theme');
  assert.equal((await patch('tema-oda', OWNER, { theme: 'deneme' })).status, 200);
  assert.deepEqual(await toGuest, { id: 'tema-oda', theme: 'deneme' });

  const none = silent(guest, 'room:theme');
  assert.equal((await patch('diger-oda', OTHER, { theme: 'deneme' })).status, 200);
  await none;
  assert.equal((await patch('diger-oda', OTHER, { theme: 'gece' })).status, 200);

  // Ayrılınca misafirler kendi odalarına, kendi temalarıyla döner
  const back = next(guest, 'room:moved');
  assert.equal((await ack(host, 'merge:split', { room: 'tema-oda' })).error, undefined);
  const b = await back;
  assert.equal(b.room.id, 'diger-oda');
  assert.equal(b.room.theme, 'gece');
  assert.equal((await patch('tema-oda', OWNER, { theme: 'gece' })).status, 200);
});

// Değişken sözleşmesi: base.css'teki :where(:root) yedekleri sözleşmenin tam listesidir; her tema dosyası
// (public/themes/*.css ve denemelik tema) :root üstünde tam olarak bu değişkenleri tanımlar.
test('her tema dosyası sözleşmedeki değişkenlerin hepsini tanımlar, fazlası yok', () => {
  const vars = (css) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const base = fs.readFileSync(path.join(ROOT, 'public/css/base.css'), 'utf8');
  const start = base.indexOf(':where(:root) {');
  assert.ok(start >= 0, 'base.css sözleşme bloğu bulunamadı');
  const contract = [...vars(base.slice(start, base.indexOf('}', start)))].sort();
  assert.ok(contract.includes('--accent-2') && contract.length > 30, contract.join(' '));
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'public/themes')).filter((f) => f.endsWith('.css')).map((f) => `public/themes/${f}`),
    'test/tools/themes/deneme.css',
  ];
  for (const f of files) {
    const css = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual([...vars(css)].sort(), contract, f);
  }
});
