const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, play, destinations, surrounded } = require('../games/yorunge');
const { startServer, client, ack, next } = require('./helpers');
const stack = (kind = 'kesif', side = 0) => [{ kind, side }];

test('ilk temas, filoya yerleştirme ve dördüncü tur komuta zorunluluğu', () => {
  const g = create(['Ay', 'Güneş']);
  assert.equal(g.moves.length, 8);
  for (const to of ['0,0', '1,0', '-1,0', '2,0', '-2,0', '3,0']) {
    const m = g.moves.find(m => m.to === to && m.kind === 'kesif');
    assert.ok(m);
    assert.ok(g.moves.every(m => !m.from));
    play(g, m);
  }
  assert.ok(g.moves.length);
  assert.ok(g.moves.every(m => m.kind === 'komuta'));
  assert.ok(g.moves.every(m => m.to !== '0,1'));
});

test('bağlantı, dar geçit, sıçrama ve kenetlenme', () => {
  const b = { '0,0': stack('sicrama'), '1,0': stack(), '2,0': stack() };
  assert.deepEqual(destinations(b, '0,0'), ['3,0']);
  assert.deepEqual(destinations(b, '1,0'), []);
  b['0,0'] = stack('kenet');
  assert.ok(destinations(b, '0,0').includes('1,0'));
  const ring = { '0,0': stack('komuta'), '1,-1': stack(), '0,1': stack(), '-1,1': stack(), '-1,0': stack(), '0,-1': stack() };
  assert.ok(!destinations(ring, '0,0').includes('1,0'));
  ring['0,0'].push({ kind: 'kenet', side: 1 });
  assert.ok(destinations(ring, '0,0').includes('1,0'));
});

test('keşif çevrede serbestçe, mekik tam üç adım kayar', () => {
  const board = { '0,0': stack('mekik'), '1,0': stack() };
  assert.deepEqual(destinations(board, '0,0'), ['2,0']);
  board['0,0'] = stack('kesif');
  assert.equal(destinations(board, '0,0').length, 5);
});

test('kapalı komutan ve eşzamanlı kuşatma', () => {
  const g = create(['Ay', 'Güneş']);
  for (const cell of ['0,0', '1,0', '0,1', '-1,1', '-1,0', '0,-1', '1,-1', '2,0', '2,-1']) g.board[cell] = stack();
  g.board['0,0'] = [...stack('komuta'), ...stack('kenet', 1)];
  g.board['1,0'] = stack('komuta', 1);
  assert.deepEqual(surrounded(g.board), [0]);
  play(g, { kind: 'kesif', to: '1,1' });
  assert.equal(g.done, true);
  assert.match(g.result, /Berabere/);
});

test('yasal hamlesi olmayan filo pas geçer, kuşatılan tek komutan maçı kaybeder', () => {
  const g = create(['Ay', 'Güneş']);
  // İkinci filonun tek gemisi yüklü bir kenetçinin altında kaldı.
  g.board['0,0'] = [...stack('komuta', 1), ...stack('kenet', 0)];
  g.stock[1].komuta = 0;
  play(g, { kind: 'komuta', to: '1,0' });
  assert.equal(g.turn, 0);
  assert.equal(g.passed, 'Güneş');
  for (const cell of ['1,-1', '0,-1', '-1,0', '-1,1']) g.board[cell] = stack();
  play(g, { kind: 'kesif', to: '0,1' });
  assert.equal(g.done, true);
  assert.match(g.result, /Ay kuşatmayı tamamladı/);
});

test('lobi, iki oyuncunun sırası, seyirci, geç katılım ve çekilme', async t => {
  const srv = await startServer();
  const clients = [];
  t.after(async () => { for (const s of clients) s.close(); await srv.stop(); });
  async function join(name) {
    const s = await client(srv.url, name);
    clients.push(s);
    const res = await ack(s, 'join', { token: s.token, clientId: name });
    assert.ok(!res.error);
    return { s, res };
  }
  const { s: a } = await join('UzayA');
  const { s: b } = await join('UzayB');
  a.emit('bot:set', false);
  const opened = next(a, 'lobbies');
  a.emit('lobby:open', { game: 'yorunge' });
  await opened;
  const joined = next(a, 'lobbies');
  b.emit('lobby:join', { game: 'yorunge' });
  await joined;
  const started = next(a, 'yorunge');
  a.emit('lobby:start', { game: 'yorunge' });
  const g = await started;
  const move = { ...g.moves[0], id: g.id, revision: 0 };
  b.emit('yorunge:move', move);
  await ack(b, 'hello', { token: b.token });
  const updated = next(b, 'yorunge');
  a.emit('yorunge:move', move);
  const g2 = await updated;
  assert.equal(g2.revision, 1);
  const spectator = await join('UzayC');
  assert.deepEqual(spectator.res.yorunge, g2);
  spectator.s.emit('yorunge:resign', g.id);
  await ack(spectator.s, 'hello', { token: spectator.s.token });
  const second = next(a, 'yorunge');
  b.emit('yorunge:move', { ...g2.moves[0], id: g.id, revision: 1 });
  assert.equal((await second).revision, 2);
  const ended = next(a, 'yorunge');
  a.emit('yorunge:resign', g.id);
  assert.match((await ended).result, /UzayB kazandı/);
});

test('DLC · Yankı kopyalar, yığın üstünde kenetçi olur; Dalış iki dolu hücreyi aşar', () => {
  const b = {'0,0':stack('yanki'), '1,0':stack('sicrama',1), '2,0':stack()};
  assert.deepEqual(destinations(b,'0,0'),['3,0']);
  b['1,0']=stack('yanki',1);
  assert.deepEqual(destinations(b,'0,0'),[]);
  b['0,0'].unshift(...stack());
  assert.ok(destinations(b,'0,0').includes('1,0'));
  b['0,0']=stack('dalis');
  assert.ok(destinations(b,'0,0').includes('3,0'));
  delete b['2,0'];
  assert.deepEqual(destinations(b,'0,0'),[]);
});

test('DLC · Çekici ve Yankı ışını, son hamle kilidi ve yığın kuralı', () => {
  const { legalMoves } = require('../games/yorunge');
  const g=create(['Ay','Güneş']);
  g.stock[0].komuta=0;
  g.board={'0,0':stack('cekici'),'-1,0':stack('yanki'),'0,1':stack('kesif',1),'-1,1':stack('komuta')};
  const moves=legalMoves(g);
  assert.ok(moves.some(m=>m.via==='-1,0' && m.from==='-1,1'));
  const tow=moves.find(m=>m.via==='0,0' && m.from==='0,1');
  assert.ok(tow);
  g.locked='0,1';
  assert.ok(!legalMoves(g).some(m=>m.via && m.from===g.locked));
  g.locked=null;
  g.board['0,1'].push(...stack('kenet'));
  assert.ok(!legalMoves(g).some(m=>m.via && m.from==='0,1'));
  g.board['0,1'].pop();
  g.stock[1].komuta=0;
  play(g,tow);
  assert.equal(g.board[tow.to][0].side,1);
  assert.ok(!g.moves.some(m=>m.from===tow.to || m.via===tow.to));
});
