// ---------- Texas Hold'em (limitsiz) ----------
// Başta herkese 1000 çip. Küçük/büyük kör 10/20, her 10 elde ikiye katlanır. Herkese iki kapalı kart; ortaya sırayla
// 3 (flop), 1 (turn), 1 (river) açık kart. Her turda sırayla pas/çağır/yükselt/çekil. Elinde kalan en iyi 5'li eli olan
// potu alır; hepsini basan (all-in) yalnız koyabildiği kadarının yan potunu kazanabilir. Çipi biten masadan kalkar;
// tek kişi kalınca oyun biter. 2-8 kişi; az kişiyle başlatılırsa masa bilgisayarlarla 4 kişiye tamamlanır.
const { deck, shuffle, evaluate, compare, HAND_NAME } = require('./cards');

const START = 1000;
const BLIND = 10; // küçük kör; büyük kör iki katı
const BLIND_EVERY = 10;

const meta = { key: 'poker', title: "Texas Hold'em", min: 1, max: 8, fill: 4, opts: {}, optsSpec: {} };

function log(g, text) {
  g.log.push(text);
  if (g.log.length > 8) g.log.shift();
}

function create(players, bots, opts, rnd = Math.random) {
  const g = {
    key: 'poker', players, bots, rnd, chips: Object.fromEntries(players.map((p) => [p, START])),
    button: Math.floor(rnd() * players.length), handNo: 0, log: [], done: false, phase: 'play',
  };
  startHand(g);
  return g;
}

const seated = (g) => g.players.filter((p) => g.chips[p] > 0);
const nextSeat = (g, i, ok) => {
  for (let k = 1; k <= g.players.length; k++) {
    const j = (i + k) % g.players.length;
    if (ok(g.players[j])) return j;
  }
  return -1;
};

function startHand(g) {
  const live = seated(g);
  if (live.length < 2) return finish(g);
  g.handNo++;
  g.sb = BLIND * 2 ** Math.floor((g.handNo - 1) / BLIND_EVERY);
  g.deck = shuffle(deck(), g.rnd);
  g.board = [];
  g.hole = {};
  g.inHand = live.slice();
  g.bets = {};
  g.contrib = {};
  g.last = {};
  g.acted = [];
  g.winners = null;
  g.shown = false;
  g.street = 'preflop';
  g.phase = 'play';
  for (const p of live) {
    g.hole[p] = [g.deck.pop(), g.deck.pop()];
    g.bets[p] = 0;
    g.contrib[p] = 0;
  }
  g.button = nextSeat(g, g.button, (p) => g.chips[p] > 0);
  const heads = live.length === 2;
  const sbSeat = heads ? g.button : nextSeat(g, g.button, (p) => g.chips[p] > 0);
  const bbSeat = nextSeat(g, sbSeat, (p) => g.chips[p] > 0);
  put(g, g.players[sbSeat], g.sb);
  put(g, g.players[bbSeat], g.sb * 2);
  g.last[g.players[sbSeat]] = `Küçük kör ${g.bets[g.players[sbSeat]]}`;
  g.last[g.players[bbSeat]] = `Büyük kör ${g.bets[g.players[bbSeat]]}`;
  g.current = g.sb * 2;
  g.minRaise = g.sb * 2;
  g.turn = bbSeat;
  advance(g);
  if (g.handNo > 1 && (g.handNo - 1) % BLIND_EVERY === 0) log(g, `Körler yükseldi: ${g.sb}/${g.sb * 2}.`);
}

function put(g, p, amount) {
  const n = Math.min(amount, g.chips[p]);
  g.chips[p] -= n;
  g.bets[p] += n;
  g.contrib[p] += n;
  return n;
}

const allIn = (g, p) => g.chips[p] === 0;
const needs = (g, p) => g.inHand.includes(p) && !allIn(g, p) && (!g.acted.includes(p) || g.bets[p] < g.current);

// Sıradaki oyuncuya geçer; kimse kalmadıysa sokağı kapatır.
function advance(g) {
  if (g.inHand.length === 1) return winByFold(g);
  const j = nextSeat(g, g.turn, (p) => needs(g, p));
  if (j >= 0) {
    g.turn = j;
    return;
  }
  endStreet(g);
}

function endStreet(g) {
  for (const p of g.inHand) g.bets[p] = 0;
  g.current = 0;
  g.minRaise = g.sb * 2;
  g.acted = [];
  const canAct = g.inHand.filter((p) => !allIn(g, p));
  const order = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' };
  g.street = order[g.street];
  if (g.street === 'showdown') return showdown(g);
  g.board.push(...g.deck.splice(-(g.street === 'flop' ? 3 : 1)));
  for (const p of g.inHand) if (!allIn(g, p)) delete g.last[p];
  if (canAct.length < 2) {
    // Herkes all-in (ya da biri hariç): kartlar tek tek açılır
    g.phase = 'runout';
    return;
  }
  g.turn = g.button;
  advance(g);
}

function winByFold(g) {
  const w = g.inHand[0];
  const pot = Object.values(g.contrib).reduce((a, b) => a + b, 0);
  g.chips[w] += pot;
  g.winners = [{ name: w, amount: pot, hand: null }];
  g.phase = 'showdown';
  log(g, `${w} potu aldı (${pot}).`);
}

function showdown(g) {
  g.phase = 'showdown';
  g.shown = true;
  const score = Object.fromEntries(g.inHand.map((p) => [p, evaluate([...g.hole[p], ...g.board])]));
  const levels = [...new Set(Object.values(g.contrib).filter((v) => v > 0))].sort((a, b) => a - b);
  const won = {};
  let prev = 0;
  for (const level of levels) {
    let slice = 0;
    for (const v of Object.values(g.contrib)) slice += Math.max(0, Math.min(v, level) - prev);
    const eligible = g.inHand.filter((p) => g.contrib[p] >= level);
    prev = level;
    if (!eligible.length) {
      // Çekilenlerin fazlası: en son katkıyı yapan elde kalanlara gider (olmaz ama boşa gitmesin)
      const back = g.inHand[0];
      won[back] = (won[back] || 0) + slice;
      continue;
    }
    let best = [];
    for (const p of eligible) {
      if (!best.length || compare(score[p], score[best[0]]) > 0) best = [p];
      else if (compare(score[p], score[best[0]]) === 0) best.push(p);
    }
    const share = Math.floor(slice / best.length);
    best.forEach((p, k) => (won[p] = (won[p] || 0) + share + (k === 0 ? slice - share * best.length : 0)));
  }
  g.winners = Object.entries(won).map(([name, amount]) => ({ name, amount, hand: HAND_NAME[score[name][0]] }));
  for (const w of g.winners) g.chips[w.name] += w.amount;
  g.handNames = Object.fromEntries(g.inHand.map((p) => [p, HAND_NAME[score[p][0]]]));
  log(g, g.winners.map((w) => `${w.name} ${w.amount} kazandı (${w.hand})`).join(', ') + '.');
}

const waiting = (g) => (g.done || g.phase !== 'play' ? [] : [g.players[g.turn]]);

function legal(g, name) {
  if (!waiting(g).includes(name)) return [];
  const toCall = g.current - g.bets[name];
  const out = [{ type: 'fold' }];
  if (toCall <= 0) out.push({ type: 'check' });
  else out.push({ type: 'call', amount: Math.min(toCall, g.chips[name]) });
  const max = g.bets[name] + g.chips[name];
  if (max > g.current) {
    const min = Math.min(g.current + g.minRaise, max);
    out.push({ type: 'raise', min, max });
  }
  return out;
}

function act(g, name, a = {}) {
  const moves = legal(g, name);
  const m = moves.find((x) => x.type === a.type);
  if (!m) return false;
  if (m.type === 'fold') {
    g.inHand = g.inHand.filter((p) => p !== name);
    g.last[name] = 'Çekildi';
  } else if (m.type === 'check') g.last[name] = 'Pas';
  else if (m.type === 'call') {
    put(g, name, m.amount);
    g.last[name] = allIn(g, name) ? `All-in ${g.bets[name]}` : `Gördü ${m.amount}`;
  } else {
    const to = a.amount;
    if (!Number.isInteger(to) || to < m.min || to > m.max) return false;
    const raise = to - g.current;
    put(g, name, to - g.bets[name]);
    if (raise >= g.minRaise) {
      g.minRaise = raise;
      g.acted = [];
    }
    g.current = Math.max(g.current, g.bets[name]);
    g.last[name] = allIn(g, name) ? `All-in ${g.bets[name]}` : `Yükseltti ${g.bets[name]}`;
  }
  if (!g.acted.includes(name)) g.acted.push(name);
  advance(g);
  return true;
}

function delay(g) {
  if (g.done) return null;
  if (g.phase === 'runout') return 1100;
  if (g.phase === 'showdown') return g.shown ? 5000 : 2800;
  return null;
}
function step(g) {
  if (g.phase === 'runout') {
    if (g.board.length < 5) {
      g.board.push(g.deck.pop());
      return;
    }
    return showdown(g);
  }
  if (g.phase === 'showdown') startHand(g);
}

function finish(g) {
  g.done = true;
  g.phase = 'done';
  g.standings = g.players.map((p) => ({ name: p, score: g.chips[p] })).sort((a, b) => b.score - a.score);
}

// Bilgisayar: rastgele dağıtımlarla kazanma olasılığını tahmin eder, pot oranına göre oynar; arada blöf yapar.
function equity(g, name, sims = 160) {
  const known = [...g.hole[name], ...g.board];
  const key = (c) => c.r * 4 + 'SHDC'.indexOf(c.s);
  const used = new Set(known.map(key));
  const rest = deck().filter((c) => !used.has(key(c)));
  const opp = g.inHand.length - 1;
  let wins = 0;
  for (let s = 0; s < sims; s++) {
    shuffle(rest, g.rnd);
    let k = 0;
    const board = [...g.board, ...rest.slice(k, k + 5 - g.board.length)];
    k += 5 - g.board.length;
    const me = evaluate([...g.hole[name], ...board]);
    let result = 1;
    for (let o = 0; o < opp; o++) {
      const them = evaluate([rest[k++], rest[k++], ...board]);
      const c = compare(me, them);
      if (c < 0) { result = 0; break; }
      if (c === 0) result = Math.min(result, 0.5);
    }
    wins += result;
  }
  return wins / sims;
}

function bot(g, name) {
  const moves = legal(g, name);
  if (!moves.length) return null;
  const can = (t) => moves.find((m) => m.type === t);
  const eq = equity(g, name);
  const pot = Object.values(g.contrib).reduce((a, b) => a + b, 0);
  const call = can('call');
  const toCall = call ? call.amount : 0;
  const odds = toCall / (pot + toCall || 1);
  const raise = can('raise');
  const r = g.rnd();
  const sized = (frac) => raise && Math.max(raise.min, Math.min(raise.max, Math.round((g.current + pot * frac) / 10) * 10));
  if (raise && (eq > 0.72 || (eq > 0.55 && r < 0.35) || (!toCall && r < 0.08))) return { type: 'raise', amount: sized(eq > 0.85 ? 1 : 0.6) };
  if (!toCall) return { type: 'check' };
  if (eq > odds + 0.04 || (toCall <= g.sb * 2 && eq > 0.25)) return { type: 'call' };
  return { type: 'fold' };
}
const timeout = (g, name) => (legal(g, name).some((m) => m.type === 'check') ? { type: 'check' } : { type: 'fold' });

function view(g, name) {
  const open = g.phase === 'showdown' && g.shown;
  const hole = {};
  for (const [p, cards] of Object.entries(g.hole || {})) {
    hole[p] = p === name || (open && g.inHand.includes(p)) ? cards : cards.map(() => null);
  }
  const pot = Object.values(g.contrib || {}).reduce((a, b) => a + b, 0);
  return {
    key: g.key, players: g.players, bots: g.bots, chips: g.chips, handNo: g.handNo, sb: g.sb, button: g.players[g.button],
    board: g.board, hole, inHand: g.inHand, bets: g.bets, pot, current: g.current, street: g.street, phase: g.phase,
    turn: g.phase === 'play' ? g.players[g.turn] : null, last: g.last, winners: g.winners, handNames: open ? g.handNames : null,
    mine: g.hole?.[name] && g.board.length >= 3 ? HAND_NAME[evaluate([...g.hole[name], ...g.board])[0]] : null,
    legal: legal(g, name), log: g.log, done: g.done, standings: g.standings || null,
  };
}

module.exports = { meta, create, view, legal, act, bot, timeout, waiting, delay, step, equity };
