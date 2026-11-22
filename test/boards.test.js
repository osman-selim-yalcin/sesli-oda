// Skor tabloları bütün odalarda ortak; geçmiş ve tier listler oda başına kalır
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');

let srv;
const sockets = [];

before(async () => {
  srv = await startServer();
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: 'İkinci Oda' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.id, 'ikinci-oda');
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

let cid = 0;
async function user(name) {
  const s = await client(srv.url, name);
  s.cid = `b${++cid}`;
  sockets.push(s);
  return s;
}
const join = (s, room) => ack(s, 'join', { token: s.token, clientId: s.cid, room });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closeAll = () => { for (const s of sockets.splice(0)) s.close(); };

// Kaydırmaca çözücüsü (genişlik öncelikli): sunucunun beklediği [parça no, dx, dy] adımlarını döner.
// Parça sırası sunucudaki gibi satır satır taranarak bulunur; aynı biçimli parçalar durumda ayırt edilmez.
function solveKlotski(rows) {
  const pieces = [];
  const seen = new Set();
  for (let y = 0; y < 5; y++) for (let x = 0; x < 4; x++) {
    const c = rows[y][x];
    if (c === '.' || seen.has(c)) continue;
    seen.add(c);
    let w = 1, h = 1;
    while (rows[y][x + w] === c) w++;
    while (rows[y + h]?.[x] === c) h++;
    pieces.push({ x, y, w, h });
  }
  const key = (ps) => ps.map((p, i) => `${pieces[i].w}${pieces[i].h}:${p.x}${p.y}`).sort().join(' ');
  const start = pieces.map(({ x, y }) => ({ x, y }));
  const big = pieces.findIndex((p) => p.w === 2 && p.h === 2);
  const prev = new Map([[key(start), null]]);
  let queue = [start];
  while (queue.length) {
    const nextQueue = [];
    for (const ps of queue) {
      if (ps[big].x === 1 && ps[big].y === 3) {
        const steps = [];
        for (let k = key(ps); prev.get(k); k = prev.get(k).from) steps.unshift(prev.get(k).step);
        return steps;
      }
      for (let i = 0; i < ps.length; i++) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const { w, h } = pieces[i];
          const nx = ps[i].x + dx, ny = ps[i].y + dy;
          if (nx < 0 || ny < 0 || nx + w > 4 || ny + h > 5) continue;
          const hit = ps.some((q, j) => j !== i && nx < q.x + pieces[j].w && q.x < nx + w && ny < q.y + pieces[j].h && q.y < ny + h);
          if (hit) continue;
          const moved = ps.map((q, j) => (j === i ? { x: nx, y: ny } : q));
          const k = key(moved);
          if (prev.has(k)) continue;
          prev.set(k, { from: key(ps), step: [i, dx, dy] });
          nextQueue.push(moved);
        }
      }
    }
    queue = nextQueue;
  }
  throw new Error('çözüm yok');
}

test('A odasındaki Kaydırmaca kaydı B odasına yayılır; B\'ye sonradan giren tabloda görür', async () => {
  const ali = await user('Ali');
  const veli = await user('Veli');
  const a = await join(ali, 'genel');
  assert.equal(a.error, undefined);
  assert.equal((await join(veli, 'ikinci-oda')).error, undefined);

  const level = a.klotski.levels.find((l) => l.id === 'isinma');
  const steps = solveKlotski(level.rows);
  const board = next(veli, 'klotski:board');
  ali.emit('klotski:win', { level: 'isinma', steps, ms: 60000 });
  const got = await board;
  assert.ok(got.isinma?.some((r) => r.name === 'Ali'), JSON.stringify(got));

  const ece = await user('Ece');
  const e = await join(ece, 'ikinci-oda');
  assert.equal(e.error, undefined);
  assert.ok(e.klotski.board.isinma?.some((r) => r.name === 'Ali'));
  closeAll();
});

test('şarkı geçmişi ve tier listler oda başına kalır', async () => {
  const ali = await user('Ali');
  const veli = await user('Veli');
  assert.equal((await join(ali, 'genel')).error, undefined);
  assert.equal((await join(veli, 'ikinci-oda')).error, undefined);

  const added = next(ali, 'history:add', 8000);
  ali.emit('media:add', 'dQw4w9WgXcQ');
  await added;
  const created = await ack(ali, 'tierlist:create', 'Genel Liste');
  assert.equal(created.error, undefined);
  await sleep(200);

  const ece = await user('Ece');
  const e = await join(ece, 'ikinci-oda');
  assert.equal(e.error, undefined);
  assert.ok(!e.history.some((h) => h.videoId === 'dQw4w9WgXcQ'));
  assert.ok(!e.tierLists.some((l) => l.title === 'Genel Liste'));
  closeAll();
});

test('A odasındaki süre tahmini B odasına kendi hedefiyle gider', async () => {
  const ali = await user('Ali');
  const veli = await user('Veli');
  assert.equal((await join(ali, 'genel')).error, undefined);
  assert.equal((await join(veli, 'ikinci-oda')).error, undefined);

  // B'nin hedefi 25, A'nınki varsayılan
  const own = next(veli, 'timing');
  veli.emit('timing:target', 25);
  assert.equal((await own).target, 25);

  const seen = new Promise((resolve) => veli.on('timing', (t) => t.results.some((r) => r.name === 'Ali' && r.elapsed === 9876) && resolve(t)));
  ali.emit('timing:result', { elapsed: 9876, target: 10 });
  const t = await Promise.race([seen, sleep(3000).then(() => null)]);
  assert.ok(t, 'B odası A\'nın denemesini almadı');
  assert.equal(t.target, 25);
  closeAll();
});
