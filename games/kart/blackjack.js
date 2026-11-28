// ---------- Blackjack ----------
// Herkes kurpiyere karşı oynar. Başta herkese 1000 çip. Her elde önce sırayla bahis (10-250), sonra iki kart; kurpiyerin
// bir kartı kapalı. Sırası gelen kart çeker, durur, ikiye katlar (ilk iki kartta, bahsi kadar daha koyup tek kart alır)
// ya da aynı değerdeki iki kartı böler (bir kez). 21'i geçen yanar. Sonra kurpiyer 17'ye kadar çeker (17'de durur).
// Kazanan bahsinin 2 katını, blackjack (ilk iki kartta 21) 2,5 katını alır, berabere bahsi geri döner.
// Masa: 1-7 kişi; boş koltuklar doldurulmaz (kurpiyer zaten bilgisayar). Lobiden seçilen el sayısı bitince ya da
// herkesin çipi bitince oyun biter; en çok çipi olan kazanır.
const { deck, shuffle } = require('./cards');

const START = 1000;
const BETS = [10, 25, 50, 100, 250];
const ROUNDS = [5, 10, 20];
const DECKS = 6;

const meta = { key: 'blackjack', title: 'Blackjack', min: 1, max: 7, fill: 1, opts: { rounds: 10 }, optsSpec: { rounds: ROUNDS } };

const value = (cards) => {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.r === 14) { aces++; total += 11; } else total += Math.min(c.r, 10);
  }
  while (total > 21 && aces) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
};
const isBJ = (cards) => cards.length === 2 && value(cards).total === 21;
const cardVal = (c) => (c.r === 14 ? 11 : Math.min(c.r, 10));

function log(g, text) {
  g.log.push(text);
  if (g.log.length > 8) g.log.shift();
}

function draw(g) {
  if (g.shoe.length < 15) {
    g.shoe = shuffle(deck(DECKS), g.rnd);
    log(g, 'Deste karıştırıldı.');
  }
  return g.shoe.pop();
}

function create(players, bots, opts, rnd = Math.random) {
  const g = {
    key: 'blackjack', players, bots, rnd, chips: Object.fromEntries(players.map((p) => [p, START])),
    rounds: ROUNDS.includes(opts.rounds) ? opts.rounds : meta.opts.rounds, round: 0,
    shoe: shuffle(deck(DECKS), rnd), dealer: [], hands: {}, phase: 'bet', turn: 0, hand: 0, log: [], done: false, results: null,
  };
  newRound(g);
  return g;
}

function newRound(g) {
  g.round++;
  g.dealer = [];
  g.hands = {};
  g.results = null;
  g.phase = 'bet';
  g.turn = g.players.findIndex((p) => g.chips[p] >= BETS[0]);
  if (g.turn < 0) return finish(g);
}

function nextBettor(g) {
  for (let i = g.turn + 1; i < g.players.length; i++) if (g.chips[g.players[i]] >= BETS[0]) return (g.turn = i);
  deal(g);
}

function deal(g) {
  const seated = g.players.filter((p) => g.hands[p]);
  for (let k = 0; k < 2; k++) {
    for (const p of seated) g.hands[p][0].cards.push(draw(g));
    g.dealer.push(draw(g));
  }
  for (const p of seated) if (isBJ(g.hands[p][0].cards)) g.hands[p][0].done = true;
  g.phase = 'play';
  if (isBJ(g.dealer)) {
    log(g, 'Kurpiyerde blackjack!');
    return (g.phase = 'dealer');
  }
  g.turn = -1;
  g.hand = 0;
  nextHand(g);
}

// Sıradaki bitmemiş el; kalmadıysa kurpiyere geçer.
function nextHand(g) {
  for (let i = Math.max(g.turn, 0); i < g.players.length; i++) {
    const hands = g.hands[g.players[i]];
    if (!hands) continue;
    const start = i === g.turn ? g.hand : 0;
    for (let h = start; h < hands.length; h++) {
      if (!hands[h].done) {
        g.turn = i;
        g.hand = h;
        return;
      }
    }
  }
  g.phase = 'dealer';
}

function waiting(g) {
  if (g.done) return [];
  if (g.phase === 'bet' || g.phase === 'play') return [g.players[g.turn]];
  return [];
}

function legal(g, name) {
  if (!waiting(g).includes(name)) return [];
  if (g.phase === 'bet') return BETS.filter((b) => b <= g.chips[name]).map((amount) => ({ type: 'bet', amount }));
  const hand = g.hands[name][g.hand];
  const out = [{ type: 'hit' }, { type: 'stand' }];
  const fresh = hand.cards.length === 2;
  if (fresh && g.chips[name] >= hand.bet) out.push({ type: 'double' });
  if (fresh && g.hands[name].length === 1 && cardVal(hand.cards[0]) === cardVal(hand.cards[1]) && g.chips[name] >= hand.bet) out.push({ type: 'split' });
  return out;
}

function act(g, name, a = {}) {
  if (!legal(g, name).some((l) => l.type === a.type && (l.amount == null || l.amount === a.amount))) return false;
  if (a.type === 'bet') {
    g.chips[name] -= a.amount;
    g.hands[name] = [{ cards: [], bet: a.amount, done: false }];
    nextBettor(g);
    return true;
  }
  const hands = g.hands[name];
  const hand = hands[g.hand];
  if (a.type === 'hit') {
    hand.cards.push(draw(g));
    const v = value(hand.cards).total;
    if (v > 21) { hand.done = true; log(g, `${name} yandı (${v}).`); } else if (v === 21) hand.done = true;
  } else if (a.type === 'stand') hand.done = true;
  else if (a.type === 'double') {
    g.chips[name] -= hand.bet;
    hand.bet *= 2;
    hand.doubled = true;
    hand.cards.push(draw(g));
    hand.done = true;
    log(g, `${name} ikiye katladı.`);
  } else if (a.type === 'split') {
    g.chips[name] -= hand.bet;
    const second = { cards: [hand.cards.pop()], bet: hand.bet, done: false };
    hands.push(second);
    hand.cards.push(draw(g));
    second.cards.push(draw(g));
    // Bölünen aslar tek kart alır
    if (hand.cards[0].r === 14) hand.done = second.done = true;
    log(g, `${name} böldü.`);
  }
  if (hand.done) nextHand(g);
  return true;
}

// Otomatik adımlar: kurpiyer kart açar/çeker, sonra hesaplanır, sonra yeni el.
function delay(g) {
  if (g.done) return null;
  if (g.phase === 'dealer') return 1000;
  if (g.phase === 'settle') return 6500; // sonuçlar görülsün, sonra yeni el
  return null;
}

function step(g) {
  if (g.phase === 'dealer') {
    if (!g.dealerOpen) {
      g.dealerOpen = true;
      return;
    }
    const anyLive = Object.values(g.hands).flat().some((h) => value(h.cards).total <= 21);
    if (anyLive && !isBJ(g.dealer) && value(g.dealer).total < 17) {
      g.dealer.push(draw(g));
      return;
    }
    return settle(g);
  }
  if (g.phase === 'settle') {
    g.dealerOpen = false;
    if (g.round >= g.rounds) return finish(g);
    newRound(g);
  }
}

function settle(g) {
  const d = value(g.dealer).total;
  const dbj = isBJ(g.dealer);
  g.results = {};
  for (const [p, hands] of Object.entries(g.hands)) {
    let net = 0;
    for (const h of hands) {
      const v = value(h.cards).total;
      const bj = isBJ(h.cards) && hands.length === 1;
      let back = 0;
      if (v > 21) h.result = 'bust';
      else if (bj && !dbj) { h.result = 'bj'; back = h.bet * 2.5; }
      else if (dbj && !bj) h.result = 'lose';
      else if (d > 21 || v > d) { h.result = 'win'; back = h.bet * 2; }
      else if (v === d) { h.result = 'push'; back = h.bet; }
      else h.result = 'lose';
      back = Math.floor(back);
      g.chips[p] += back;
      net += back - h.bet;
    }
    g.results[p] = net;
  }
  g.phase = 'settle';
  const best = Object.entries(g.results).sort((a, b) => b[1] - a[1])[0];
  log(g, `Kurpiyer ${d > 21 ? 'yandı' : d}.${best && best[1] > 0 ? ` En çok ${best[0]} kazandı (+${best[1]}).` : ''}`);
}

function finish(g) {
  g.done = true;
  g.phase = 'done';
  g.standings = g.players.map((p) => ({ name: p, score: g.chips[p] })).sort((a, b) => b.score - a.score);
}

// Bilgisayar: basit temel strateji.
function bot(g, name) {
  const moves = legal(g, name);
  if (!moves.length) return null;
  if (g.phase === 'bet') {
    const want = g.chips[name] > 1500 ? 100 : g.chips[name] > 600 ? 50 : 25;
    return moves.filter((m) => m.amount <= want).pop() || moves[0];
  }
  const can = (t) => moves.some((m) => m.type === t);
  const hand = g.hands[name][g.hand];
  const { total, soft } = value(hand.cards);
  const up = cardVal(g.dealer[0]);
  if (can('split')) {
    const r = cardVal(hand.cards[0]);
    if (r === 11 || r === 8 || (r === 9 && ![7, 10, 11].includes(up)) || ([2, 3, 6, 7].includes(r) && up <= 7)) return { type: 'split' };
  }
  if (can('double') && !soft && (total === 11 || (total === 10 && up <= 9) || (total === 9 && up >= 3 && up <= 6))) return { type: 'double' };
  if (soft) return { type: total >= 19 || (total === 18 && up <= 8) ? 'stand' : 'hit' };
  if (total >= 17) return { type: 'stand' };
  if (total >= 13 && up <= 6) return { type: 'stand' };
  if (total === 12 && up >= 4 && up <= 6) return { type: 'stand' };
  return { type: 'hit' };
}

// Süresi dolan insan oyuncu: en küçük bahis ya da dur.
const timeout = (g, name) => (g.phase === 'bet' ? legal(g, name)[0] : { type: 'stand' });

function view(g) {
  const hidden = g.phase === 'play' || (g.phase === 'dealer' && !g.dealerOpen);
  return {
    key: g.key, players: g.players, bots: g.bots, chips: g.chips, round: g.round, rounds: g.rounds, phase: g.phase,
    turn: g.phase === 'bet' || g.phase === 'play' ? g.players[g.turn] ?? null : null, hand: g.hand, hands: g.hands, results: g.results, log: g.log, done: g.done,
    standings: g.standings || null,
    dealer: g.dealer.map((c, i) => (hidden && i === 1 ? null : c)),
    dealerTotal: hidden ? (g.dealer[0] ? value([g.dealer[0]]).total : null) : g.dealer.length ? value(g.dealer).total : null,
    totals: Object.fromEntries(Object.entries(g.hands).map(([p, hs]) => [p, hs.map((h) => value(h.cards).total)])),
  };
}

// Dağıtım anı (sunucu bu değişince oyunculara kartlar dağıtılırken bekleme verir)
const dealKey = (g) => `${g.round}:${g.phase === 'bet' ? 'bet' : 'dealt'}`;
const dealCount = (g) => (g.phase === 'bet' ? 0 : Object.values(g.hands).flat().reduce((n, h) => n + h.cards.length, 0) + g.dealer.length);

module.exports = { meta, dealKey, dealCount, create, view, legal, act, bot, timeout, waiting, delay, step, value, BETS };
