// ---------- Kemal ----------
// 4 kişi, karşılıklı oturanlar ortak (1. ile 3., 2. ile 4.). Herkese 4 kart, ortaya 4 açık kart. Sıra yok: herkes
// istediği an elindeki bir kartı ortadaki biriyle değiştirir. Herkes "Hazırım" deyince ortadakiler kalkar, yeni 4 kart
// açılır. Amaç elinde aynı sayıdan dört kart toplamak ve bunu ortağına gizli işaretle bildirmek.
// Herkesin oyun başında gizli bir işareti vardır (ifade listesinden); bunu yalnız ortağı görür. İşaretler masadaki
// herkese görünür, ama hangisinin gerçek olduğunu yalnız ortak bilir; yanıltmak için başka işaretler de verilebilir.
// "Kemal!": ortağının elinde dörtlü varsa takımın 1 puan alır, yoksa rakip takım alır.
// "Kes!": rakiplerden birinde dörtlü varsa takımın 1 puan alır, yoksa rakip takım alır.
// Lobide seçilen puana ilk ulaşan takım kazanır. Eksik koltuklara bilgisayar oturur; bilgisayar ortağın işaretini
// görünce Kemal der, dörtlüsü olunca kendi işaretini verir.
const { deck, shuffle } = require('./cards');

const TARGETS = [3, 5, 7];
const SIGNALS = ['😉', '🤔', '😮', '🙄', '😏', '🤨', '😬', '🥱'];
const SIGNAL_GAP = 1200; // aynı kişinin iki işareti arasında en az bu kadar
const meta = { key: 'kemal', title: 'Kemal', min: 1, max: 4, fill: 4, opts: { target: 5 }, optsSpec: { target: TARGETS } };

const team = (g, name) => g.players.indexOf(name) % 2;
const partner = (g, name) => g.players[(g.players.indexOf(name) + 2) % 4];
const quad = (hand) => hand.length === 4 && hand.every((c) => c.r === hand[0].r);

function log(g, text) {
  g.log.push(text);
  if (g.log.length > 8) g.log.shift();
}

function create(players, bots, opts, rnd = Math.random, now = Date.now) {
  const pool = shuffle(SIGNALS.slice(), rnd);
  const g = {
    key: 'kemal', players, bots, rnd, now, target: TARGETS.includes(opts.target) ? opts.target : meta.opts.target,
    teams: [0, 0], secret: Object.fromEntries(players.map((p, i) => [p, pool[i]])), dealNo: 0, log: [], done: false,
  };
  newDeal(g);
  return g;
}

function newDeal(g) {
  g.dealNo++;
  g.deck = shuffle(deck(), g.rnd);
  g.discard = [];
  g.hands = Object.fromEntries(g.players.map((p) => [p, g.deck.splice(-4)]));
  g.table = g.deck.splice(-4);
  g.ready = [];
  g.signals = [];
  g.lastSignal = {};
  g.result = null;
  g.phase = 'swap';
  g.botMemory = {};
}

const waiting = (g) => (g.done || g.phase !== 'swap' ? [] : g.players.filter((p) => !g.ready.includes(p)));

function legal(g, name) {
  if (g.done || g.phase !== 'swap' || !g.players.includes(name)) return [];
  return [{ type: 'swap' }, { type: 'ready' }, { type: 'signal' }, { type: 'kemal' }, { type: 'kes' }];
}

function refill(g) {
  g.discard.push(...g.table);
  if (g.deck.length < 4) {
    g.deck = shuffle([...g.deck, ...g.discard], g.rnd);
    g.discard = [];
  }
  g.table = g.deck.splice(-4);
  g.ready = [];
}

function call(g, name, kind) {
  const mine = team(g, name);
  let ok;
  let holder = null;
  if (kind === 'kemal') {
    ok = quad(g.hands[partner(g, name)]);
    holder = ok ? partner(g, name) : null;
  } else {
    holder = g.players.find((p) => team(g, p) !== mine && quad(g.hands[p])) || null;
    ok = Boolean(holder);
  }
  const winTeam = ok ? mine : 1 - mine;
  g.teams[winTeam]++;
  g.result = { kind, by: name, ok, holder, team: winTeam };
  g.phase = 'reveal';
  const teamName = (t) => g.players.filter((_, i) => i % 2 === t).join(' & ');
  log(g, kind === 'kemal'
    ? (ok ? `${name}: Kemal! ${holder} dörtlüyü topladı. +1 ${teamName(winTeam)}` : `${name} Kemal dedi ama ortağında dörtlü yok. +1 ${teamName(winTeam)}`)
    : (ok ? `${name}: Kes! ${holder} yakalandı. +1 ${teamName(winTeam)}` : `${name} Kes dedi ama rakipte dörtlü yok. +1 ${teamName(winTeam)}`));
}

function act(g, name, a = {}) {
  if (!legal(g, name).length) return false;
  if (a.type === 'swap') {
    const { h, t } = a;
    if (!Number.isInteger(h) || !Number.isInteger(t) || !g.hands[name][h] || !g.table[t]) return false;
    [g.hands[name][h], g.table[t]] = [g.table[t], g.hands[name][h]];
    // Değiştiren hazır sayılmaz (yeniden "Hazırım" demeli)
    g.ready = g.ready.filter((p) => p !== name);
    return true;
  }
  if (a.type === 'ready') {
    if (!g.ready.includes(name)) g.ready.push(name);
    if (g.ready.length === 4) refill(g);
    return true;
  }
  if (a.type === 'signal') {
    if (!SIGNALS.includes(a.e)) return false;
    const t = g.now();
    if (t - (g.lastSignal[name] || 0) < SIGNAL_GAP) return false;
    g.lastSignal[name] = t;
    g.signals.push({ by: name, e: a.e, at: t });
    if (g.signals.length > 12) g.signals.shift();
    return true;
  }
  if (a.type === 'kemal' || a.type === 'kes') {
    call(g, name, a.type);
    return true;
  }
  return false;
}

const delay = (g) => (g.done ? null : g.phase === 'reveal' ? 5000 : g.phase === 'swap' ? 2600 : null);
function step(g) {
  if (g.phase === 'reveal') {
    if (Math.max(...g.teams) >= g.target) {
      g.done = true;
      g.phase = 'done';
      const names = (t) => g.players.filter((_, i) => i % 2 === t).join(' & ');
      g.standings = [0, 1].map((t) => ({ name: names(t), score: g.teams[t] })).sort((a, b) => b.score - a.score);
      return;
    }
    newDeal(g);
  }
  // swap: yalnız bilgisayarların düşünmesi için zaman geçer
}

// ---------- Bilgisayar ----------
function bot(g, name) {
  if (g.phase !== 'swap') return null;
  const t = g.now();
  const mem = (g.botMemory[name] ||= { seen: 0, signalled: 0 });
  // Ortağın gizli işaretini gördüyse Kemal der (biraz bekleyip)
  const mate = partner(g, name);
  const fresh = g.signals.filter((s) => s.at > mem.seen);
  const mateSig = fresh.find((s) => s.by === mate && s.e === g.secret[mate]);
  if (mateSig && t - mateSig.at > 700) return { type: 'kemal' };
  // Rakip arka arkaya aynı işareti verirse arada keser
  const opp = fresh.filter((s) => team(g, s.by) !== team(g, name));
  if (opp.length && t - opp[opp.length - 1].at > 900) {
    mem.seen = opp[opp.length - 1].at;
    const same = g.signals.filter((s) => s.by === opp[opp.length - 1].by && s.e === opp[opp.length - 1].e).length;
    if (g.rnd() < (same >= 2 ? 0.35 : 0.08)) return { type: 'kes' };
  }
  const hand = g.hands[name];
  if (quad(hand)) {
    if (t - mem.signalled > 3500) {
      mem.signalled = t;
      return { type: 'signal', e: g.rnd() < 0.8 ? g.secret[name] : SIGNALS[Math.floor(g.rnd() * SIGNALS.length)] };
    }
    return g.ready.includes(name) ? null : { type: 'ready' };
  }
  // Hedef: elde en çok olan sayı (eşitse ortada çok olan)
  const count = {};
  for (const c of hand) count[c.r] = (count[c.r] || 0) + 1;
  for (const c of g.table) count[c.r] = (count[c.r] || 0) + 0.1;
  const goal = Number(Object.entries(count).sort((a, b) => b[1] - a[1])[0][0]);
  const ti = g.table.findIndex((c) => c.r === goal);
  const hi = hand.findIndex((c) => c.r !== goal);
  if (ti >= 0 && hi >= 0) return { type: 'swap', h: hi, t: ti };
  if (!g.ready.includes(name)) return { type: 'ready' };
  // Arada şaşırtmaca işareti
  if (g.rnd() < 0.04 && t - (g.lastSignal[name] || 0) > 8000) return { type: 'signal', e: SIGNALS[Math.floor(g.rnd() * SIGNALS.length)] };
  return null;
}
const timeout = () => ({ type: 'ready' });

function view(g, name) {
  const open = g.phase === 'reveal' || g.done;
  const hands = {};
  for (const p of g.players) hands[p] = p === name || open ? g.hands[p] : g.hands[p].map(() => null);
  const seat = g.players.includes(name);
  return {
    key: g.key, players: g.players, bots: g.bots, target: g.target, teams: g.teams, dealNo: g.dealNo, phase: g.phase, hands,
    table: g.table, ready: g.ready, signals: g.signals, deckCount: g.deck.length, result: g.result, signalList: SIGNALS,
    mySecret: seat ? g.secret[name] : null, mateSecret: seat ? g.secret[partner(g, name)] : null, partner: seat ? partner(g, name) : null,
    log: g.log, done: g.done, standings: g.standings || null, teamOf: Object.fromEntries(g.players.map((p) => [p, team(g, p)])),
  };
}

module.exports = { meta, create, view, legal, act, bot, timeout, waiting, delay, step, quad, SIGNALS };
