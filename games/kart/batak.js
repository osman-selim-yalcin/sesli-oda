// ---------- İhaleli Batak ----------
// 4 kişi, herkes kendi için; herkese 13 kart. İhale: sırayla en az 5, öncekinden fazla el sözü verilir ya da pas denir;
// herkes pas derse dağıtan 5'e mecbur kalır. İhaleyi alan kozu seçer ve ilk eli açar. Elde önce atılan rengi takip etmek
// zorunlu; takip ederken yerdekini geçebiliyorsan geçmek zorunlu; rengin yoksa koz atmak, kozla yerdeki kozu geçebiliyorsan
// geçmek zorunlu. Koz kırılmadan (biri koz atmadan) kozla el açılmaz, elinde koz dışında kart yoksa açılır.
// Puan: ihaleyi alan sözünü tutarsa aldığı el kadar artı, tutamazsa sözü kadar eksi; diğerleri aldıkları el kadar artı.
// Lobide seçilen el sayısı bitince en çok puanlı kazanır. Eksik koltuklara bilgisayar oturur.
const { deck, shuffle } = require('./cards');

const ROUNDS = [3, 5, 8];
const MIN_BID = 5;
const meta = { key: 'batak', title: 'Batak', min: 1, max: 4, fill: 4, opts: { rounds: 3 }, optsSpec: { rounds: ROUNDS } };

function log(g, text) {
  g.log.push(text);
  if (g.log.length > 8) g.log.shift();
}

function create(players, bots, opts, rnd = Math.random) {
  const g = {
    key: 'batak', players, bots, rnd, rounds: ROUNDS.includes(opts.rounds) ? opts.rounds : meta.opts.rounds,
    scores: Object.fromEntries(players.map((p) => [p, 0])), dealer: Math.floor(rnd() * players.length), handNo: 0, log: [], done: false,
  };
  newHand(g);
  return g;
}

const sortHand = (cards) => cards.sort((a, b) => 'SHCD'.indexOf(a.s) - 'SHCD'.indexOf(b.s) || b.r - a.r);

function newHand(g) {
  g.handNo++;
  g.dealer = (g.dealer + 1) % 4;
  const d = shuffle(deck(), g.rnd);
  g.hands = {};
  g.players.forEach((p, i) => (g.hands[p] = sortHand(d.slice(i * 13, i * 13 + 13))));
  g.bids = {};
  g.high = 0;
  g.bidder = null;
  g.trump = null;
  g.trick = [];
  g.lastTrick = null;
  g.tricks = Object.fromEntries(g.players.map((p) => [p, 0]));
  g.broken = false;
  g.handScores = null;
  g.phase = 'bid';
  g.turn = (g.dealer + 1) % 4;
}

const waiting = (g) => (g.done || !['bid', 'trump', 'play'].includes(g.phase) ? [] : [g.players[g.turn]]);

// Yerdeki elin şu an kazananı
function trickWinner(trick, trump) {
  let best = trick[0];
  for (const t of trick.slice(1)) {
    const b = best.card;
    const c = t.card;
    if (c.s === b.s ? c.r > b.r : c.s === trump) best = t;
  }
  return best;
}

function playable(g, name) {
  const hand = g.hands[name];
  if (!g.trick.length) {
    const nonTrump = hand.filter((c) => c.s !== g.trump);
    return g.broken || !nonTrump.length ? hand : nonTrump;
  }
  const led = g.trick[0].card.s;
  const win = trickWinner(g.trick, g.trump).card;
  const follow = hand.filter((c) => c.s === led);
  if (follow.length) {
    // Yer kozla kesilmişse rengi takip etmek yeter; değilse geçebiliyorsan geçmek zorunlu
    if (win.s !== led) return follow;
    const over = follow.filter((c) => c.r > win.r);
    return over.length ? over : follow;
  }
  const trumps = hand.filter((c) => c.s === g.trump);
  if (trumps.length) {
    const over = win.s === g.trump ? trumps.filter((c) => c.r > win.r) : trumps;
    return over.length ? over : trumps;
  }
  return hand;
}

function legal(g, name) {
  if (!waiting(g).includes(name)) return [];
  if (g.phase === 'bid') {
    const out = [{ type: 'pass' }];
    for (let n = Math.max(MIN_BID, g.high + 1); n <= 13; n++) out.push({ type: 'bid', n });
    return out;
  }
  if (g.phase === 'trump') return ['S', 'H', 'D', 'C'].map((s) => ({ type: 'trump', s }));
  const ok = playable(g, name);
  return g.hands[name].map((c, i) => ({ type: 'play', i, c })).filter((m) => ok.includes(m.c)).map(({ type, i }) => ({ type, i }));
}

function nextBidder(g) {
  const open = g.players.filter((p) => g.bids[p] !== 'pass');
  if (open.length === 1 && g.high) return endBidding(g, open[0]);
  if (!open.length) {
    g.high = MIN_BID;
    log(g, `Herkes pas dedi: ${g.players[g.dealer]} ${MIN_BID}'e mecbur.`);
    return endBidding(g, g.players[g.dealer]);
  }
  for (let k = 1; k <= 4; k++) {
    const j = (g.turn + k) % 4;
    if (g.bids[g.players[j]] !== 'pass') return (g.turn = j);
  }
}
function endBidding(g, who) {
  g.bidder = who;
  g.phase = 'trump';
  g.turn = g.players.indexOf(who);
  log(g, `İhale ${who}: ${g.high}.`);
}

function act(g, name, a = {}) {
  const moves = legal(g, name);
  if (!moves.length) return false;
  if (g.phase === 'bid') {
    if (a.type === 'pass') g.bids[name] = 'pass';
    else if (a.type === 'bid' && moves.some((m) => m.n === a.n)) {
      g.bids[name] = a.n;
      g.high = a.n;
    } else return false;
    nextBidder(g);
    return true;
  }
  if (g.phase === 'trump') {
    if (a.type !== 'trump' || !'SHDC'.includes(a.s) || a.s.length !== 1) return false;
    g.trump = a.s;
    g.phase = 'play';
    return true;
  }
  if (a.type !== 'play' || !moves.some((m) => m.i === a.i)) return false;
  const card = g.hands[name].splice(a.i, 1)[0];
  if (card.s === g.trump) g.broken = true;
  g.trick.push({ by: name, card });
  if (g.trick.length === 4) g.phase = 'trickEnd';
  else g.turn = (g.turn + 1) % 4;
  return true;
}

const delay = (g) => (g.done ? null : g.phase === 'trickEnd' ? 2000 : g.phase === 'tally' ? 9000 : null);

function step(g) {
  if (g.phase === 'trickEnd') {
    const w = trickWinner(g.trick, g.trump).by;
    g.tricks[w]++;
    g.lastTrick = { cards: g.trick, winner: w };
    g.trick = [];
    g.turn = g.players.indexOf(w);
    if (!g.hands[w].length) return tally(g);
    g.phase = 'play';
    return;
  }
  if (g.phase === 'tally') {
    if (g.handNo >= g.rounds) {
      g.done = true;
      g.phase = 'done';
      g.standings = g.players.map((p) => ({ name: p, score: g.scores[p] })).sort((a, b) => b.score - a.score);
      return;
    }
    newHand(g);
  }
}

function tally(g) {
  g.handScores = {};
  for (const p of g.players) {
    let s = g.tricks[p];
    if (p === g.bidder && g.tricks[p] < g.high) s = -g.high;
    g.handScores[p] = s;
    g.scores[p] += s;
  }
  g.phase = 'tally';
  const made = g.tricks[g.bidder] >= g.high;
  log(g, `${g.bidder} ${g.high} dedi, ${g.tricks[g.bidder]} aldı: ${made ? 'tuttu' : 'battı'}.`);
}

// ---------- Bilgisayar ----------
function estimate(hand) {
  const bySuit = { S: [], H: [], D: [], C: [] };
  for (const c of hand) bySuit[c.s].push(c.r);
  let best = null;
  let est = 0;
  for (const [s, rs] of Object.entries(bySuit)) {
    if (!best || rs.length > bySuit[best].length || (rs.length === bySuit[best].length && Math.max(...rs, 0) > Math.max(...bySuit[best], 0))) best = s;
  }
  for (const [s, rs] of Object.entries(bySuit)) {
    for (const r of rs) {
      if (r === 14) est += 1;
      else if (r === 13 && rs.length >= 2) est += 0.7;
      else if (r === 12 && rs.length >= 3) est += 0.35;
    }
    if (s === best) est += Math.max(0, rs.length - 3) * 0.9;
  }
  return { est, trump: best };
}

function bot(g, name) {
  const moves = legal(g, name);
  if (!moves.length) return null;
  const hand = g.hands[name];
  if (g.phase === 'bid') {
    const { est } = estimate(hand);
    const want = Math.max(MIN_BID, g.high + 1);
    return est + g.rnd() * 0.6 >= want && want <= 13 ? { type: 'bid', n: want } : { type: 'pass' };
  }
  if (g.phase === 'trump') return { type: 'trump', s: estimate(hand).trump };
  const cards = moves.map((m) => ({ i: m.i, c: hand[m.i] }));
  const power = (c) => (c.s === g.trump ? 100 : 0) + c.r;
  if (!g.trick.length) {
    const aces = cards.filter(({ c }) => c.r === 14 && c.s !== g.trump);
    if (aces.length) return { type: 'play', i: aces[0].i };
    if (name === g.bidder) {
      const tr = cards.filter(({ c }) => c.s === g.trump).sort((a, b) => b.c.r - a.c.r);
      if (tr.length && tr[0].c.r >= 13) return { type: 'play', i: tr[0].i };
    }
    return { type: 'play', i: cards.sort((a, b) => power(a.c) - power(b.c))[0].i };
  }
  const cur = trickWinner(g.trick, g.trump).card;
  const beats = (c) => (c.s === cur.s ? c.r > cur.r : c.s === g.trump);
  const winners = cards.filter(({ c }) => beats(c)).sort((a, b) => power(a.c) - power(b.c));
  if (winners.length) return { type: 'play', i: winners[0].i };
  return { type: 'play', i: cards.sort((a, b) => power(a.c) - power(b.c))[0].i };
}
const timeout = (g, name) => bot(g, name);

function view(g, name) {
  const hands = {};
  for (const p of g.players) hands[p] = p === name ? g.hands[p] : g.hands[p].map(() => null);
  const mine = g.players.includes(name) ? legal(g, name).filter((m) => m.type === 'play').map((m) => m.i) : [];
  return {
    key: g.key, players: g.players, bots: g.bots, rounds: g.rounds, handNo: g.handNo, scores: g.scores, phase: g.phase,
    dealer: g.players[g.dealer], turn: waiting(g)[0] || null, hands, bids: g.bids, high: g.high, bidder: g.bidder, trump: g.trump,
    trick: g.trick, lastTrick: g.lastTrick, tricks: g.tricks, broken: g.broken, playable: mine, handScores: g.handScores,
    log: g.log, done: g.done, standings: g.standings || null,
  };
}

module.exports = { meta, create, view, legal, act, bot, timeout, waiting, delay, step, playable, trickWinner };
