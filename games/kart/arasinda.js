// ---------- Arasında ----------
// Başta herkese 1000 çip; pot boşken herkes ortaya 20 koyar. Sırası gelene iki kart (direkler) açılır; oyuncu üçüncü kartın
// ikisinin arasına düşeceğine pot kadar bahis yapar ya da pas der. Arasına düşerse bahsi kadar pottan alır, dışına
// düşerse bahsini pota koyar, direklerden birine eşit çıkarsa ("direğe çarptı") bahsin iki katını koyar.
// Direkler aynı ya da ardışıksa arası yoktur, sıra geçer. As en büyük kart. Lobide seçilen tur sayısı (her tur herkes
// bir kez oynar) bitince ya da tek kişide çip kalınca oyun biter; en çok çipi olan kazanır. Tek başına başlatılırsa
// iki bilgisayar oturur.
const { deck, shuffle } = require('./cards');

const START = 1000;
const ANTE = 20;
const MIN_BET = 10;
const ROUNDS = [3, 5, 10];

const meta = { key: 'arasinda', title: 'Arasında', min: 1, max: 8, fill: 3, opts: { rounds: 5 }, optsSpec: { rounds: ROUNDS } };

function log(g, text) {
  g.log.push(text);
  if (g.log.length > 8) g.log.shift();
}
function draw(g) {
  if (!g.deck.length) g.deck = shuffle(deck(), g.rnd);
  return g.deck.pop();
}
const alive = (g) => g.players.filter((p) => g.chips[p] > 0);

function create(players, bots, opts, rnd = Math.random) {
  const g = {
    key: 'arasinda', players, bots, rnd, chips: Object.fromEntries(players.map((p) => [p, START])), pot: 0,
    rounds: ROUNDS.includes(opts.rounds) ? opts.rounds : meta.opts.rounds, cycle: 1,
    deck: shuffle(deck(), rnd), turn: -1, posts: [], third: null, bet: 0, outcome: null, phase: 'bet', log: [], done: false,
  };
  next(g);
  return g;
}

function next(g) {
  if (alive(g).length < 2 && g.players.length > 1) return finish(g);
  let i = g.turn;
  for (let k = 0; k < g.players.length; k++) {
    i++;
    if (i >= g.players.length) {
      i = 0;
      if (g.turn >= 0) g.cycle++;
    }
    if (g.chips[g.players[i]] > 0) break;
  }
  if (g.cycle > g.rounds) return finish(g);
  g.turn = i;
  if (g.pot <= 0) {
    let n = 0;
    for (const p of alive(g)) {
      const put = Math.min(ANTE, g.chips[p]);
      g.chips[p] -= put;
      g.pot += put;
      n++;
    }
    log(g, `Pot boşaldı: ${n} kişi ortaya ${ANTE} koydu.`);
  }
  if (g.deck.length < 3) g.deck = shuffle(deck(), g.rnd);
  g.posts = [draw(g), draw(g)].sort((a, b) => a.r - b.r);
  g.third = null;
  g.bet = 0;
  g.outcome = null;
  if (g.posts[1].r - g.posts[0].r <= 1) {
    g.phase = 'reveal';
    g.outcome = 'nospace';
    log(g, `${g.players[g.turn]}: arası yok, sıra geçti.`);
  } else g.phase = 'bet';
}

const maxBet = (g, name) => Math.min(g.pot, g.chips[name]);
const minBet = (g, name) => Math.min(MIN_BET, maxBet(g, name));
const waiting = (g) => (g.done || g.phase !== 'bet' ? [] : [g.players[g.turn]]);

function legal(g, name) {
  if (!waiting(g).includes(name)) return [];
  return [{ type: 'pass' }, { type: 'bet', min: minBet(g, name), max: maxBet(g, name) }];
}

function act(g, name, a = {}) {
  if (!waiting(g).includes(name)) return false;
  if (a.type === 'pass') {
    g.phase = 'reveal';
    g.outcome = 'pass';
    g.third = draw(g);
    log(g, `${name} pas dedi.`);
    return true;
  }
  if (a.type !== 'bet' || !Number.isInteger(a.amount) || a.amount < minBet(g, name) || a.amount > maxBet(g, name)) return false;
  g.bet = a.amount;
  g.third = draw(g);
  const [lo, hi] = g.posts;
  const r = g.third.r;
  if (r > lo.r && r < hi.r) {
    g.outcome = 'win';
    g.chips[name] += a.amount;
    g.pot -= a.amount;
    log(g, `${name} ${a.amount} yatırdı, arasına düştü: +${a.amount}.`);
  } else if (r === lo.r || r === hi.r) {
    const pay = Math.min(a.amount * 2, g.chips[name]);
    g.outcome = 'post';
    g.chips[name] -= pay;
    g.pot += pay;
    log(g, `${name} direğe çarptı: −${pay}.`);
  } else {
    g.outcome = 'lose';
    g.chips[name] -= a.amount;
    g.pot += a.amount;
    log(g, `${name} ${a.amount} yatırdı, dışarı düştü: −${a.amount}.`);
  }
  g.phase = 'reveal';
  return true;
}

const delay = (g) => (g.done ? null : g.phase === 'reveal' ? (g.outcome === 'nospace' ? 2200 : 2800) : null);
function step(g) {
  if (g.phase === 'reveal') next(g);
}

function finish(g) {
  g.done = true;
  g.phase = 'done';
  g.standings = g.players.map((p) => ({ name: p, score: g.chips[p] })).sort((a, b) => b.score - a.score);
}

// Bilgisayar: aradaki rank sayısına göre kazanma olasılığını kabaca hesaplar; iyi açıklıkta potun bir kısmını yatırır.
function bot(g, name) {
  if (!waiting(g).includes(name)) return null;
  const gap = g.posts[1].r - g.posts[0].r - 1;
  const p = (gap * 4) / 50;
  const post = 6 / 50;
  const ev = p - (1 - p - post) - 2 * post;
  const max = maxBet(g, name);
  if (ev <= 0.05 || max < 1) return { type: 'pass' };
  const share = ev > 0.5 ? 1 : ev > 0.3 ? 0.5 : 0.25;
  const amount = Math.max(minBet(g, name), Math.min(max, Math.round((g.pot * share) / 10) * 10, Math.floor(g.chips[name] / 2)));
  return { type: 'bet', amount: Math.min(amount, max) };
}
const timeout = () => ({ type: 'pass' });

function view(g) {
  return {
    key: g.key, players: g.players, bots: g.bots, chips: g.chips, pot: g.pot, rounds: g.rounds, cycle: Math.min(g.cycle, g.rounds),
    turn: g.players[g.turn] ?? null, posts: g.posts, third: g.third, bet: g.bet, outcome: g.outcome, phase: g.phase,
    min: g.phase === 'bet' ? minBet(g, g.players[g.turn]) : 0, max: g.phase === 'bet' ? maxBet(g, g.players[g.turn]) : 0,
    log: g.log, done: g.done, standings: g.standings || null,
  };
}

module.exports = { meta, create, view, legal, act, bot, timeout, waiting, delay, step };
