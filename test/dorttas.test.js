// Dört Taş ve Beş Harf: kurallar (taş düşmesi, dörtlüler, bilgisayar; harf boyama, günün kelimesi) ve sunucu akışı.
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http } = require('./helpers');
const dt = require('../games/dorttas');
const bh = require('../games/besharf');
const VALID = new Set(require('../public/besharf-words'));
const ANSWERS = require('../games/besharf-answers');

const at = (r, c) => r * dt.COLS + c;
function play(cols) {
  let b = Array(dt.ROWS * dt.COLS).fill(null);
  cols.forEach((c, k) => (b = dt.apply(b, c, k % 2 ? 'Y' : 'R').board));
  return b;
}

test('Dört Taş kural: taş en alttaki boş yuvaya düşer, dolu sütuna atılmaz', () => {
  let b = play([3, 3]);
  assert.equal(b[at(5, 3)], 'R');
  assert.equal(b[at(4, 3)], 'Y');
  b = play([0, 0, 0, 0, 0, 0]);
  assert.equal(dt.dropRow(b, 0), -1);
  assert.equal(dt.apply(b, 0, 'R'), null);
  assert.equal(dt.apply(b, 7, 'R'), null, 'tahta dışı');
});

test('Dört Taş kural: yatay, dikey ve çapraz dörtlü', () => {
  assert.deepEqual(dt.winCells(play([0, 0, 1, 1, 2, 2, 3]), 'R').sort((a, b) => a - b), [at(5, 0), at(5, 1), at(5, 2), at(5, 3)]);
  assert.equal(dt.winCells(play([0, 1, 0, 1, 0, 1, 0]), 'R').length, 4);
  // Çapraz: R 0, 1, 2, 3 sütunlarında yükselir
  const diag = play([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3]);
  assert.deepEqual(dt.winCells(diag, 'R').sort((a, b) => a - b), [at(2, 3), at(3, 2), at(4, 1), at(5, 0)]);
  assert.equal(dt.winCells(play([0, 1, 2]), 'R').length, 0);
});

test('Dört Taş bilgisayar: kazanan hamleyi yapar, rakibin dörtlüsünü keser (orta ve zor)', () => {
  const win = play([0, 6, 1, 6, 2]); // Y sırada değil; R üçlüde: R oynasın
  const r = play([0, 6, 1, 6, 2, 5]);
  assert.equal(dt.botMove(r, 'R', 'kolay', () => 0.99), 3);
  for (const level of ['orta', 'zor']) {
    assert.equal(dt.botMove(win, 'Y', level, () => 0.99), 3, `${level} keser`);
  }
});

test('Beş Harf: harf boyama, tekrarlanan harfler kelimedeki kadar boyanır', () => {
  assert.equal(bh.marks('kalem', 'kalem'), 'ggggg');
  assert.equal(bh.marks('melek', 'kalem'), 'yxggy', 'ikinci e boyanmaz');
  assert.equal(bh.marks('aaaaa', 'kalem'), 'xgxxx');
  assert.equal(bh.marks('sarar', 'araba'), 'xyyyx');
  assert.equal(bh.marks('ışığı', 'ılgın'), 'gxyxx');
});

test('Beş Harf: kelimeler 5 harfli, hepsi kabul listesinde; günün kelimesi her gün değişir, sırası belli', () => {
  assert.ok(ANSWERS.length > 1000);
  assert.ok(ANSWERS.every((w) => [...w].length === 5 && VALID.has(w)));
  assert.equal(new Set(ANSWERS).size, ANSWERS.length, 'tekrar yok');
  const d = bh.dayOf(Date.UTC(2026, 10, 28, 12));
  assert.equal(d, bh.FIRST);
  assert.equal(bh.dayOf(Date.UTC(2026, 10, 28, 20, 59)), d, 'Türkiye 23:59');
  assert.equal(bh.dayOf(Date.UTC(2026, 10, 28, 21, 0)), d + 1, 'Türkiye gece yarısı');
  assert.equal(bh.answerOf(d), ANSWERS[0]);
  assert.notEqual(bh.answerOf(d), bh.answerOf(d + 1));
  assert.equal(bh.answerOf(d + ANSWERS.length), ANSWERS[0], 'liste bitince başa döner');
});

let srv;
const sockets = [];
before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

let seq = 0;
async function joined(id, name) {
  const s = await client(srv.url, name);
  sockets.push(s);
  const r = await ack(s, 'join', { token: s.token, clientId: name, room: id });
  assert.equal(r.error, undefined, JSON.stringify(r));
  s.joinRes = r;
  return s;
}
const until = (s, event, ok, ms = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { s.off(event, on); reject(new Error(`${event} gelmedi`)); }, ms);
  function on(data) {
    if (!ok(data)) return;
    clearTimeout(timer);
    s.off(event, on);
    resolve(data);
  }
  s.on(event, on);
});

test('Dört Taş sunucu: iki kişi lobiden başlar, sırası olmayan oynayamaz, dörtlü kazanır, yeniden oyna', async () => {
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: `Dört ${++seq}` } });
  const a = await joined(r.json.room.id, 'Ayse');
  const b = await joined(r.json.room.id, 'Bora');
  const opened = until(b, 'lobbies', (l) => l.dorttas);
  a.emit('lobby:open', { game: 'dorttas' });
  await opened;
  const both = until(a, 'lobbies', (l) => l.dorttas?.players.length === 2);
  b.emit('lobby:join', { game: 'dorttas' });
  await both;
  const started = until(a, 'dorttas', (g) => g && !g.done);
  a.emit('lobby:start', { game: 'dorttas' });
  let g = await started;
  const [first, second] = g.players[0] === 'Ayse' ? [a, b] : [b, a];
  second.emit('dorttas:move', { col: 0 }); // sırası değil
  const moveAs = async (s, col, n) => {
    const p = until(a, 'dorttas', (x) => x.moves === n);
    s.emit('dorttas:move', { col });
    return p;
  };
  g = await moveAs(first, 0, 1);
  assert.equal(g.board[at(5, 0)], 'R');
  assert.equal(g.last.row, 5);
  await moveAs(second, 6, 2);
  await moveAs(first, 1, 3);
  await moveAs(second, 6, 4);
  await moveAs(first, 2, 5);
  await moveAs(second, 5, 6);
  g = await moveAs(first, 3, 7);
  assert.equal(g.done, true);
  assert.equal(g.winner, g.players[0]);
  assert.equal(g.line.length, 4);
  const again = until(a, 'dorttas', (x) => x && !x.done && x.moves === 0 && x.id !== g.id);
  b.emit('dorttas:again');
  assert.deepEqual([...(await again).players].sort(), ['Ayse', 'Bora']);
});

test('Dört Taş sunucu: tek başına bilgisayara karşı, zorluk lobiden', async () => {
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: `Dört ${++seq}` } });
  const a = await joined(r.json.room.id, 'Cem');
  const opened = until(a, 'lobbies', (l) => l.dorttas);
  a.emit('lobby:open', { game: 'dorttas' });
  await opened;
  const set = until(a, 'lobbies', (l) => l.dorttas?.opts.level === 'zor');
  a.emit('lobby:opts', { game: 'dorttas', level: 'zor' });
  await set;
  const started = until(a, 'dorttas', (g) => g && !g.done);
  a.emit('lobby:start', { game: 'dorttas' });
  let g = await started;
  assert.equal(g.level, 'zor');
  if (g.players[0] === 'Cem') {
    const p = until(a, 'dorttas', (x) => x.moves === 1);
    a.emit('dorttas:move', { col: 3 });
    await p;
  }
  g = await until(a, 'dorttas', (x) => x.players[x.turn] === 'Cem' && x.moves >= 1, 4000);
  assert.ok(g.board.filter(Boolean).length >= 1);
});

test('Beş Harf sunucu: tahminler boyanır, listede olmayan reddedilir, bitince kelime açılır, günde bir kez', async () => {
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: `Kelime ${++seq}` } });
  const a = await joined(r.json.room.id, 'Deniz');
  const b = await joined(r.json.room.id, 'Ece');
  const answer = bh.answerOf(bh.dayOf());
  let st = a.joinRes.besharf;
  assert.equal(st.rows.length, 0);
  assert.equal(st.answer, null, 'kelime baştan gelmez');

  let res = await ack(a, 'besharf:guess', { word: 'qqqqq' });
  assert.match(res.error, /listede yok/);
  res = await ack(a, 'besharf:guess', { word: 'abc' });
  assert.ok(res.error);

  const wrong = ANSWERS.find((w) => w !== answer);
  const board = until(b, 'besharf:board', (x) => x.board.some((p) => p.name === 'Deniz'));
  res = await ack(a, 'besharf:guess', { word: wrong.toLocaleUpperCase('tr') });
  assert.equal(res.ok, true);
  assert.equal(res.state.rows[0].w, wrong);
  assert.equal(res.state.rows[0].m, bh.marks(wrong, answer));
  assert.equal(res.state.answer, null);
  const seen = await board;
  assert.equal(seen.board[0].m[0], bh.marks(wrong, answer));
  assert.equal(seen.board[0].w, undefined, 'başkasına harfler gitmez');
  assert.match((await ack(a, 'besharf:guess', { word: wrong })).error, /zaten/);

  // Ece'nin durumu ayrı
  st = await ack(b, 'besharf:get', null);
  assert.equal(st.rows.length, 0);

  const chat = until(b, 'chat', (m) => /Beş Harf #\d+ kelimesini 2\/6/.test(m.text || ''));
  res = await ack(a, 'besharf:guess', { word: answer });
  assert.equal(res.state.done, true);
  assert.equal(res.state.won, true);
  assert.equal(res.state.answer, answer);
  assert.equal(res.state.stats.wins, 1);
  assert.equal(res.state.stats.streak, 1);
  assert.equal(res.state.stats.dist[1], 1);
  await chat;
  assert.match((await ack(a, 'besharf:guess', { word: wrong })).error, /oynadın/);
});
