// ---------- Pişti ----------
// 2-4 kişi, herkes kendi için. Ortaya 4 kart (üstteki açık), herkese 4 kart. Sırayla bir kart atılır: ortadaki en üst
// kartla aynı sayıdaysa ya da atılan Vale (J) ise yığın alınır. Ortada tek kart varken aynı sayıyla almak pişti
// (10 puan), Vale ile tek Valeyi almak 20 puan. Eller bitince yeniden 4'er kart dağıtılır; deste bitince ortada kalanı
// son alan alır. Puan: her pişti, her As ve Vale 1, sinek 2'si 2, karo 10'u 3, en çok kartı alan 3 puan.
// Lobide seçilen hedef puana ilk ulaşan kazanır. Tek başına başlatılırsa bir bilgisayar oturur.
const { deck, shuffle } = require('./cards');

const TARGETS = [51, 101, 151];
const meta = { key: 'pisti', title: 'Pişti', min: 1, max: 4, fill: 2, opts: { target: 51 }, optsSpec: { target: TARGETS } };

function log(g, text) {
  g.log.push(text);
  if (g.log.length > 8) g.log.shift();
}

function create(players, bots, opts, rnd = Math.random) {
  const g = {
    key: 'pisti', players, bots, rnd, target: TARGETS.includes(opts.target) ? opts.target : meta.opts.target,
    scores: Object.fromEntries(players.map((p) => [p, 0])), dealer: Math.floor(rnd() * players.length), deal: 0,
    log: [], done: false,
  };
  newDeal(g);
  return g;
}

function newDeal(g) {
  g.deal++;
  g.dealer = (g.dealer + 1) % g.players.length;
  g.deck = shuffle(deck(), g.rnd);
  g.pile = g.deck.splice(-4);
  // Açık kart Vale çıkarsa altına konur
  while (g.pile[3].r === 11) {
    g.deck.unshift(g.pile.pop());
    g.pile.push(g.deck.pop());
  }
  g.taken = Object.fromEntries(g.players.map((p) => [p, []]));
  g.pistis = Object.fromEntries(g.players.map((p) => [p, 0]));
  g.lastTaker = null;
  g.hands = {};
  g.turn = (g.dealer + 1) % g.players.length;
  g.phase = 'play';
  g.flash = null;
  g.dealScores = null;
  dealHands(g);
}

function dealHands(g) {
  for (const p of g.players) g.hands[p] = g.deck.splice(-4);
}

const waiting = (g) => (g.done || g.phase !== 'play' ? [] : [g.players[g.turn]]);
const legal = (g, name) => (waiting(g).includes(name) ? g.hands[name].map((c, i) => ({ type: 'play', i })) : []);

const cardPoints = (c) => (c.r === 14 || c.r === 11 ? 1 : 0) + (c.r === 2 && c.s === 'C' ? 2 : 0) + (c.r === 10 && c.s === 'D' ? 3 : 0);

function act(g, name, a = {}) {
  if (!waiting(g).includes(name) || a.type !== 'play' || !Number.isInteger(a.i) || !g.hands[name][a.i]) return false;
  const c = g.hands[name].splice(a.i, 1)[0];
  const top = g.pile[g.pile.length - 1];
  g.flash = null;
  if (top && (c.r === top.r || c.r === 11)) {
    const pisti = g.pile.length === 1 && c.r === top.r;
    g.pile.push(c);
    g.taken[name].push(...g.pile);
    if (pisti) {
      g.pistis[name] += c.r === 11 ? 2 : 1;
      g.flash = { type: c.r === 11 ? 'jpisti' : 'pisti', by: name };
      log(g, `${name}: ${c.r === 11 ? 'Valeyle pişti! +20' : 'Pişti! +10'}`);
    } else g.flash = { type: 'take', by: name, n: g.pile.length };
    g.pile = [];
    g.lastTaker = name;
  } else g.pile.push(c);
  g.lastPlay = { by: name, card: c };
  g.turn = (g.turn + 1) % g.players.length;
  if (g.players.every((p) => !g.hands[p].length)) {
    if (g.deck.length >= g.players.length * 4) dealHands(g);
    else endDeal(g);
  }
  return true;
}

function endDeal(g) {
  if (g.pile.length && g.lastTaker) g.taken[g.lastTaker].push(...g.pile);
  g.pile = [];
  const most = Math.max(...g.players.map((p) => g.taken[p].length));
  const leaders = g.players.filter((p) => g.taken[p].length === most);
  g.dealScores = {};
  for (const p of g.players) {
    const s = g.taken[p].reduce((sum, c) => sum + cardPoints(c), 0) + g.pistis[p] * 10 + (leaders.length === 1 && leaders[0] === p ? 3 : 0);
    g.dealScores[p] = { points: s, cards: g.taken[p].length, pistis: g.pistis[p] };
    g.scores[p] += s;
  }
  g.phase = 'tally';
  log(g, `El bitti: ${g.players.map((p) => `${p} +${g.dealScores[p].points}`).join(', ')}.`);
}

const delay = (g) => (g.done ? null : g.phase === 'tally' ? 8000 : null);
function step(g) {
  if (g.phase !== 'tally') return;
  const best = Math.max(...Object.values(g.scores));
  if (best >= g.target) {
    g.done = true;
    g.phase = 'done';
    g.standings = g.players.map((p) => ({ name: p, score: g.scores[p] })).sort((a, b) => b.score - a.score);
    return;
  }
  newDeal(g);
}

// Bilgisayar: alabiliyorsa alır (pişti ve değerli kartlar önce); alamıyorsa Valeyi saklar, rakibe pişti verme riski az
// olan (daha önce çok görülmüş) kartı atar.
function bot(g, name) {
  if (!waiting(g).includes(name)) return null;
  const hand = g.hands[name];
  const top = g.pile[g.pile.length - 1];
  const value = (cards) => cards.reduce((s, c) => s + cardPoints(c), 0) + cards.length * 0.2;
  let best = null;
  let bestScore = -Infinity;
  const seen = {};
  for (const p of g.players) for (const c of g.taken[p]) seen[c.r] = (seen[c.r] || 0) + 1;
  for (const c of g.pile) seen[c.r] = (seen[c.r] || 0) + 1;
  hand.forEach((c, i) => {
    let s;
    if (top && c.r === top.r) s = 10 + value(g.pile) + (g.pile.length === 1 ? 20 : 0);
    else if (top && c.r === 11) s = g.pile.length >= 3 || value(g.pile) >= 2 ? 6 + value(g.pile) : -6;
    else if (c.r === 11) s = -8;
    else s = (seen[c.r] || 0) - cardPoints(c) * 2 - (g.pile.length === 0 ? 2 : 0) + g.rnd() * 0.5;
    if (s > bestScore) [best, bestScore] = [i, s];
  });
  return { type: 'play', i: best };
}
const timeout = (g, name) => bot(g, name);

function view(g, name) {
  const hands = {};
  for (const p of g.players) hands[p] = p === name ? g.hands[p] : g.hands[p].map(() => null);
  return {
    key: g.key, players: g.players, bots: g.bots, target: g.target, scores: g.scores, deal: g.deal, phase: g.phase,
    turn: g.phase === 'play' ? g.players[g.turn] : null, hands, pile: g.pile.slice(-1), pileCount: g.pile.length,
    pileUnder: g.pile.length > 1, deckCount: g.deck.length, taken: Object.fromEntries(g.players.map((p) => [p, g.taken[p].length])),
    pistis: g.pistis, flash: g.flash, lastPlay: g.lastPlay || null, dealScores: g.dealScores, log: g.log, done: g.done, standings: g.standings || null,
  };
}

module.exports = { meta, create, view, legal, act, bot, timeout, waiting, delay, step, cardPoints };
