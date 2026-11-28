// Kağıt oyunları: kurallar (el değeri, blackjack toplamı, arasında ödemeleri, pişti puanı, batak zorunlu kart,
// kemal çağrıları), yalnız bilgisayarlarla baştan sona oynatma ve sunucu akışı (lobi, gizli kartlar, bilgisayar).
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http } = require('./helpers');
const { evaluate, compare, card, seatPlayers } = require('../games/kart/cards');
const { ENGINES } = require('../games/kart');
const bj = require('../games/kart/blackjack');
const arasinda = require('../games/kart/arasinda');
const poker = require('../games/kart/poker');
const pisti = require('../games/kart/pisti');
const batak = require('../games/kart/batak');
const kemal = require('../games/kart/kemal');

const C = (s) => s.split(' ').map((x) => {
  const r = { A: 14, K: 13, Q: 12, J: 11, T: 10 }[x[0]] || Number(x[0]);
  return card(r, x[1]);
});
// Tekrarlanabilir rastgele
const seeded = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test('poker: el değerleri doğru sıralanır', () => {
  const rank = (s) => evaluate(C(s));
  assert.equal(rank('AS KS QS JS TS 2H 3D')[0], 8, 'floş kent');
  assert.equal(rank('9S 9H 9D 9C 2S 3H 4D')[0], 7, 'kare');
  assert.equal(rank('9S 9H 9D 4C 4S 3H 2D')[0], 6, 'ful');
  assert.equal(rank('AH 9H 7H 4H 2H 3S 5D')[0], 5, 'floş');
  assert.deepEqual(rank('AS 2H 3D 4C 5S 9H KD'), [4, 5], 'as ile küçük kent');
  assert.equal(rank('9S 9H 9D 4C 5S KH 2D')[0], 3);
  assert.equal(rank('9S 9H 4D 4C 5S KH 2D')[0], 2);
  assert.ok(compare(rank('AS AH KD 4C 5S 9H 2D'), rank('AS AH QD 4C 5S 9H 2D')) > 0, 'yan kart');
  assert.equal(compare(rank('AS AH KD QC JS 2H 3D'), rank('AD AC KH QS JH 2S 3C')), 0, 'eşit');
});

test('masa: eksik koltuklar bilgisayarla dolar', () => {
  assert.deepEqual(seatPlayers(['Ali'], 4, 4), ['Ali', 'Bilgisayar 1', 'Bilgisayar 2', 'Bilgisayar 3']);
  assert.deepEqual(seatPlayers(['Ali', 'Can'], 8, 1), ['Ali', 'Can']);
});

test('blackjack: as 1 ya da 11 sayılır; kazanç, blackjack ve beraberlik ödemeleri', () => {
  assert.equal(bj.value(C('AS 9H')).total, 20);
  assert.equal(bj.value(C('AS 9H 5D')).total, 15);
  assert.equal(bj.value(C('AS AH 9D')).total, 21);
  const g = bj.create(['Ali'], [], { rounds: 5 }, seeded(1));
  assert.equal(g.phase, 'bet');
  assert.ok(!bj.act(g, 'Ali', { type: 'bet', amount: 7 }), 'listede olmayan bahis');
  // Elleri elle kur: oyuncu 20, kurpiyer 19
  bj.act(g, 'Ali', { type: 'bet', amount: 100 });
  g.hands.Ali = [{ cards: C('KS QH'), bet: 100, done: false }];
  g.dealer = C('9S TH');
  g.phase = 'play';
  g.turn = 0;
  g.hand = 0;
  assert.equal(bj.view(g).dealer[1], null, 'kapalı kart görünmez');
  bj.act(g, 'Ali', { type: 'stand' });
  assert.equal(g.phase, 'dealer');
  while (g.phase === 'dealer') bj.step(g);
  assert.equal(g.results.Ali, 100);
  assert.equal(g.chips.Ali, 1100);
});

test('arasında: arasına düşen kazanır, dışarı düşen öder, direğe çarpan iki kat öder; arası yoksa sıra geçer', () => {
  const play = (posts, third, amount = 50) => {
    const g = arasinda.create(['Ali', 'Can'], [], {}, seeded(3));
    g.phase = 'bet';
    g.turn = 0;
    g.posts = C(posts);
    g.deck.push(C(third)[0]);
    const before = { chips: g.chips.Ali, pot: g.pot };
    assert.ok(arasinda.act(g, 'Ali', { type: 'bet', amount }));
    return { g, dChips: g.chips.Ali - before.chips, dPot: g.pot - before.pot };
  };
  let r = play('3S 9H', '6D', 40);
  assert.equal(r.g.outcome, 'win');
  assert.deepEqual([r.dChips, r.dPot], [40, -40]);
  r = play('3S 9H', 'KD', 30);
  assert.deepEqual([r.g.outcome, r.dChips, r.dPot], ['lose', -30, 30]);
  r = play('3S 9H', '9D', 30);
  assert.deepEqual([r.g.outcome, r.dChips, r.dPot], ['post', -60, 60]);
  const g = arasinda.create(['Ali', 'Can'], [], {}, seeded(3));
  assert.equal(g.pot, 40, 'herkes 20 koydu');
  g.phase = 'bet';
  g.turn = 0;
  assert.ok(!arasinda.act(g, 'Ali', { type: 'bet', amount: 50 }), 'pottan fazla yatırılamaz');
});

test('pişti: tek karta aynı sayı 10, valeyle valeye 20; kart puanları', () => {
  const g = pisti.create(['Ali', 'Can'], [], {}, seeded(5));
  g.turn = 0;
  g.pile = C('7S');
  g.hands.Ali = C('7H 2C 3D 4S');
  assert.ok(pisti.act(g, 'Ali', { type: 'play', i: 0 }));
  assert.equal(g.pistis.Ali, 1);
  assert.equal(g.flash.type, 'pisti');
  g.pile = C('JS');
  g.turn = 1;
  g.hands.Can = C('JH 2S 3S 4C');
  pisti.act(g, 'Can', { type: 'play', i: 0 });
  assert.equal(g.pistis.Can, 2);
  assert.equal(pisti.cardPoints(C('2C')[0]), 2);
  assert.equal(pisti.cardPoints(C('TD')[0]), 3);
  assert.equal(pisti.cardPoints(C('AS')[0]), 1);
  // Vale çok kartlı yığını alır ama pişti sayılmaz
  g.pile = C('3S 8D');
  g.turn = 0;
  g.hands.Ali = C('JC 5S');
  pisti.act(g, 'Ali', { type: 'play', i: 0 });
  assert.equal(g.pistis.Ali, 1);
  assert.equal(g.pile.length, 0);
});

test('batak: rengi takip, geçmek zorunlu, renk yoksa koz; koz kırılmadan kozla açılmaz', () => {
  const g = batak.create(['A', 'B', 'C', 'D'], [], {}, seeded(7));
  g.phase = 'play';
  g.trump = 'S';
  g.turn = 1;
  g.trick = [{ by: 'A', card: C('9H')[0] }];
  g.hands.B = C('2H KH 5S 3D');
  assert.deepEqual(batak.playable(g, 'B').map((c) => c.r), [13], 'geçebiliyorsa geçer');
  g.hands.B = C('2H 5S 3D');
  assert.deepEqual(batak.playable(g, 'B').map((c) => c.r), [2], 'geçemezse renkten');
  g.hands.B = C('5S 3D');
  assert.deepEqual(batak.playable(g, 'B').map((c) => c.s), ['S'], 'renk yoksa koz');
  g.trick = [];
  g.broken = false;
  g.hands.B = C('5S AS 3D');
  assert.deepEqual(batak.playable(g, 'B').map((c) => c.s), ['D'], 'koz kırılmadan kozla açılmaz');
  assert.equal(batak.trickWinner([{ by: 'A', card: C('AH')[0] }, { by: 'B', card: C('2S')[0] }], 'S').by, 'B');
});

test('batak: herkes pas derse dağıtan 5 ile alır', () => {
  const g = batak.create(['A', 'B', 'C', 'D'], [], {}, seeded(9));
  for (let k = 0; k < 4; k++) batak.act(g, g.players[g.turn], { type: 'pass' });
  assert.equal(g.phase, 'trump');
  assert.equal(g.bidder, g.players[g.dealer]);
  assert.equal(g.high, 5);
});

test('kemal: ortakta dörtlü varken Kemal puan getirir, yokken rakibe yazar; Kes rakibi yakalar', () => {
  const mk = () => {
    const g = kemal.create(['A', 'B', 'C', 'D'], [], {}, seeded(11), () => 1e6);
    g.hands.C = C('7S 7H 7D 7C');
    g.hands.A = C('2S 3H 4D 5C');
    g.hands.B = C('2H 3S 4C 5D');
    g.hands.D = C('2D 3C 4S 5H');
    return g;
  };
  let g = mk();
  kemal.act(g, 'A', { type: 'kemal' });
  assert.deepEqual(g.teams, [1, 0], 'A ile C ortak');
  g = mk();
  kemal.act(g, 'C', { type: 'kemal' });
  assert.deepEqual(g.teams, [0, 1], 'C\'nin ortağı A\'da dörtlü yok');
  g = mk();
  kemal.act(g, 'B', { type: 'kes' });
  assert.deepEqual(g.teams, [0, 1], 'B, C\'yi yakaladı');
  g = mk();
  assert.ok(!kemal.act(g, 'A', { type: 'signal', e: 'X' }), 'listede olmayan işaret');
  const v = kemal.view(g, 'A');
  assert.equal(v.mateSecret, g.secret.C);
  assert.equal(v.hands.B[0], null, 'rakip kartı kapalı');
});

// Yalnız bilgisayarlarla oyunu sonuna kadar oynat: her hamle geçerli, oyun biter, çip yoktan var olmaz.
for (const key of Object.keys(ENGINES)) {
  test(`${key}: bilgisayarlar baştan sona oynar, oyun biter`, () => {
    for (let seed = 1; seed <= 3; seed++) {
      const engine = ENGINES[key];
      let clock = 0;
      const n = Math.max(engine.meta.fill, key === 'poker' ? 4 : 3);
      const players = seatPlayers([], engine.meta.max, Math.min(n, engine.meta.max));
      const g = engine.create(players, players.slice(), { ...engine.meta.opts, ...(key === 'kemal' ? { target: 3 } : {}) }, seeded(seed * 97), () => clock);
      const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
      const total = () => sum(g.chips) + (g.pot || 0) + sum(g.contrib);
      const start = total();
      let steps = 0;
      while (!g.done && steps++ < 60000) {
        clock += 900;
        let moved = false;
        for (const p of players) {
          const a = engine.bot(g, p);
          if (!a) continue;
          assert.ok(engine.act(g, p, a), `${key} geçersiz bilgisayar hamlesi ${JSON.stringify(a)} (${g.phase})`);
          moved = true;
          break;
        }
        if (!moved) {
          assert.ok(engine.delay(g) != null, `${key} takıldı: ${g.phase}`);
          engine.step(g);
        }
        if (key === 'poker' && g.phase === 'play') assert.equal(total(), start, 'poker çipleri korunur');
        if (key === 'arasinda') assert.equal(total(), start, 'arasında çipleri korunur');
        for (const p of players) engine.view(g, p);
      }
      assert.ok(g.done, `${key} bitmedi (${g.phase})`);
    }
  });
}

// ---------- Sunucu ----------
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
  return s;
}
const until = (s, event, ok, ms = 6000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { s.off(event, on); reject(new Error(`${event} gelmedi`)); }, ms);
  function on(data) {
    if (!ok(data)) return;
    clearTimeout(timer);
    s.off(event, on);
    resolve(data);
  }
  s.on(event, on);
});

test('sunucu: poker lobiden başlar, kendi kartını görür, başkasınınkini görmez; bilgisayarlar oynar', async () => {
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: `Kart ${++seq}` } });
  const id = r.json.room.id;
  const a = await joined(id, 'Ayse');
  const b = await joined(id, 'Bora');
  const opened = until(a, 'lobbies', (l) => l.poker);
  a.emit('lobby:open', { game: 'poker' });
  await opened;
  const inLobby = until(a, 'lobbies', (l) => l.poker?.players.length === 2);
  b.emit('lobby:join', { game: 'poker' });
  await inLobby;
  const startA = until(a, 'kart', (m) => m.key === 'poker' && m.game);
  const startB = until(b, 'kart', (m) => m.key === 'poker' && m.game);
  a.emit('lobby:start', { game: 'poker' });
  const [ga, gb] = [(await startA).game, (await startB).game];
  assert.equal(ga.players.length, 4, 'iki kişi + iki bilgisayar');
  assert.ok(ga.hole.Ayse.every(Boolean), 'kendi kartı açık');
  assert.ok(ga.hole.Bora.every((c) => c === null), 'başkasının kartı kapalı');
  assert.ok(gb.hole.Bora.every(Boolean));
  // Sırası gelmeyen oynayamaz; sırası gelen çekilince el ilerler
  const turnSock = { Ayse: a, Bora: b };
  // Sıra başta bir insandaysa başlangıç mesajı yeter; değilse bilgisayarlar oynayınca gelir
  assert.ok(ga.hold > ga.now, 'oyun dağıtım beklemesiyle başlar');
  // Dağıtım bitince ve sıra bir insana gelince
  const g = await until(a, 'kart', (m) => m.key === 'poker' && !m.game?.hold && ['Ayse', 'Bora'].includes(m.game?.turn), 25000).then((m) => m.game);
  const mover = g.turn;
  const moved = until(a, 'kart', (m) => m.key === 'poker' && m.game.last[mover] === 'Çekildi');
  turnSock[mover].emit('kart:act', { key: 'poker', id: g.id, a: { type: 'fold' } });
  await moved;
  // Oyunu bitir: sıralama gelir
  const ended = until(b, 'kart', (m) => m.key === 'poker' && m.game?.done);
  a.emit('kart:end', { key: 'poker' });
  const done = (await ended).game;
  assert.ok(done.standings.length === 4);
});

test('sunucu: blackjack tek başına başlar, listede olmayan ayar alınmaz, bahis çipten düşer', async () => {
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: `Kart ${++seq}` } });
  const id = r.json.room.id;
  const a = await joined(id, 'Cem');
  const b = await joined(id, 'Deniz');
  const opened = until(a, 'lobbies', (l) => l.blackjack);
  a.emit('lobby:open', { game: 'blackjack' });
  await opened;
  a.emit('lobby:opts', { game: 'blackjack', rounds: 999 });
  a.emit('lobby:opts', { game: 'blackjack', rounds: 5 });
  await until(a, 'lobbies', (l) => l.blackjack?.opts.rounds === 5);
  const started = until(b, 'kart', (m) => m.key === 'blackjack' && m.game);
  a.emit('lobby:start', { game: 'blackjack' });
  const g = (await started).game;
  assert.deepEqual(g.players, ['Cem']);
  assert.equal(g.rounds, 5);
  assert.equal(g.turn, 'Cem');
  // Dağıtım sürerken hamle yok sayılır; bitince bahis geçer
  a.emit('kart:act', { key: 'blackjack', id: g.id, a: { type: 'bet', amount: 10 } });
  await until(a, 'kart', (m) => m.key === 'blackjack' && !m.game.hold, 8000);
  const bet = until(a, 'kart', (m) => m.key === 'blackjack' && m.game.phase !== 'bet');
  a.emit('kart:act', { key: 'blackjack', id: g.id, a: { type: 'bet', amount: 50 } });
  const after = (await bet).game;
  assert.equal(after.chips.Cem, 950, 'dağıtım sırasındaki 10 bahsi alınmadı');
});
