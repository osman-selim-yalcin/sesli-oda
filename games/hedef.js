// ---------- Hedef sayı ----------
// Herkese aynı 6 sayı (4 küçük 1-10, 2 büyük 25/50/75/100) ve 101-999 arası bir hedef verilir. Dört işlemle hedefe
// ulaşılmaya çalışılır: her sayı en çok bir kez, ara sonuçlar pozitif tam sayı. Hedef her zaman tam ulaşılabilir
// seçilir (aşağıdaki çözücüyle). Tarayıcı adımları gönderir, sunucu yeniden oynatıp doğrular; tur içinde daha iyisi
// tekrar gönderilebilir, sunucu en iyisini ve ilk ulaşıldığı anı tutar. Başkalarının adımları tur bitene kadar gizli.
// Puan: tam hedef 100 + kalan saniye, değilse max(0, 60 − 6 × fark). Toplamda en yüksek puan kazanır.
// Tur bitince ara ekranı kendiliğinden geçmez: herkes "Sonraki tur"a basınca (bot hep hazır) yeni tur başlar.

const ROUNDS = [3, 5, 7];
const ROUND_MS = Number(process.env.HEDEF_ROUND_MS) || 90000;
const SMALL = [1, 10];
const LARGE = [25, 50, 75, 100];
const TARGET = [101, 999];
const MAX_STEPS = 5; // 6 sayı en çok 5 işlemle birleşir
const OPS = { '+': '+', '-': '−', '*': '×', '/': '÷' };

let io;
let rooms;
let postSystem;
let rand;
let pick;
let BOT;
const timers = new Map(); // oda kodu -> { round, bot }

function init(deps) {
  ({ io, rooms, postSystem, rand, pick, BOT } = deps);
}

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// ---------- Çözücü ----------
// Alt küme tablosu: by[mask] = bu sayıların hepsi kullanılarak ulaşılabilen değerler -> nasıl (null = tek sayı,
// [maskA, a, op, maskB, b] = a op b). Her ayrım bir kez denenir; ×1 ve ÷1 yeni değer getirmediği için atlanır.
// Tüm alt kümelerin birleşimi ulaşılabilen her değerdir (tüm sayıları kullanmak zorunlu değil).
function solve(nums) {
  const n = nums.length;
  const full = (1 << n) - 1;
  const by = new Array(full + 1);
  const masks = [];
  for (let m = 1; m <= full; m++) masks.push(m);
  const bits = (m) => { let c = 0; for (; m; m &= m - 1) c++; return c; };
  masks.sort((a, b) => bits(a) - bits(b) || a - b);
  const reach = new Map(); // değer -> en az sayıyla ulaşılan mask
  for (const mask of masks) {
    const map = new Map();
    if (bits(mask) === 1) {
      map.set(nums[31 - Math.clz32(mask)], null);
    } else {
      for (let a = (mask - 1) & mask; a > 0; a = (a - 1) & mask) {
        const b = mask ^ a;
        if (a < b) continue;
        const add = (v, how) => { if (!map.has(v)) map.set(v, how); };
        for (const x of by[a].keys()) {
          for (const y of by[b].keys()) {
            add(x + y, [a, x, '+', b, y]);
            if (x !== 1 && y !== 1) add(x * y, [a, x, '*', b, y]);
            if (x > y) add(x - y, [a, x, '-', b, y]);
            else if (y > x) add(y - x, [b, y, '-', a, x]);
            if (y !== 1 && x % y === 0) add(x / y, [a, x, '/', b, y]);
            if (x !== 1 && y % x === 0) add(y / x, [b, y, '/', a, x]);
          }
        }
      }
    }
    by[mask] = map;
    for (const v of map.keys()) if (!reach.has(v)) reach.set(v, mask);
  }
  // Bir değere giden adımlar: [[i, op, j], ...]; i, j kutu numarası (0-5 başlangıç sayıları, sonra her adımın sonucu).
  const steps = (value) => {
    const mask = reach.get(value);
    if (mask == null) return null;
    const out = [];
    const emit = (m, v) => {
      const how = by[m].get(v);
      if (!how) return 31 - Math.clz32(m);
      const i = emit(how[0], how[1]);
      const j = emit(how[3], how[4]);
      out.push([i, how[2], j]);
      return n + out.length - 1;
    };
    emit(mask, value);
    return out;
  };
  return { reach, steps };
}

// Adımları yeniden oynatır; geçersizse null. Cevap: elde kalan kutulardan hedefe en yakını (eşitse önce gelen).
function replay(nums, steps, target) {
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) return null;
  const vals = [...nums];
  const used = vals.map(() => false);
  for (const s of steps) {
    if (!Array.isArray(s) || s.length !== 3) return null;
    const [i, op, j] = s;
    if (!Number.isInteger(i) || !Number.isInteger(j) || i === j || i < 0 || j < 0 || i >= vals.length || j >= vals.length) return null;
    if (used[i] || used[j] || !OPS[op]) return null;
    const a = vals[i];
    const b = vals[j];
    let r;
    if (op === '+') r = a + b;
    if (op === '*') r = a * b;
    if (op === '-') r = a - b;
    if (op === '/') r = b && a % b === 0 ? a / b : 0;
    if (!(r > 0) || !Number.isSafeInteger(r)) return null;
    used[i] = used[j] = true;
    vals.push(r);
    used.push(false);
  }
  let answer = -1;
  for (let k = 0; k < vals.length; k++) {
    if (!used[k] && (answer < 0 || Math.abs(vals[k] - target) < Math.abs(vals[answer] - target))) answer = k;
  }
  // Ekranda sadece cevaba giden adımlar yazılır.
  const need = new Set();
  const mark = (k) => {
    if (k < nums.length || need.has(k)) return;
    need.add(k);
    const [i, , j] = steps[k - nums.length];
    mark(i);
    mark(j);
  };
  mark(answer);
  const text = steps.flatMap(([i, op, j], k) => (need.has(nums.length + k) ? [`${vals[i]} ${OPS[op]} ${vals[j]} = ${vals[nums.length + k]}`] : []));
  return { value: vals[answer], diff: Math.abs(vals[answer] - target), text };
}

// 6 sayı ve tam ulaşılabilir bir hedef; çözümü (en az sayıyla) ve botun planı da hazırlanır.
function makeRound() {
  for (;;) {
    const nums = [...Array.from({ length: 4 }, () => randInt(...SMALL)), ...[...LARGE].sort(() => Math.random() - 0.5).slice(0, 2)];
    nums.sort(() => Math.random() - 0.5);
    const { reach, steps } = solve(nums);
    let target = null;
    for (let tries = 0; tries < 20 && target == null; tries++) {
      const t = randInt(...TARGET);
      if (reach.has(t)) target = t;
    }
    if (target == null) continue;
    // Bot: %50 tam çözüm, değilse hedefe 1-15 farkla ulaşılabilen bir değer
    const near = [...reach.keys()].filter((v) => v !== target && Math.abs(v - target) <= 15);
    const botValue = Math.random() < 0.5 || !near.length ? target : pick(near);
    return { nums, target, solution: steps(target), bot: steps(botValue) };
  }
}

// ---------- Oyun ----------

const points = (diff, msLeft) => (diff === 0 ? 100 + Math.max(0, Math.floor(msLeft / 1000)) : Math.max(0, 60 - 6 * diff));
const active = (game) => game.players.filter((p) => !game.left.includes(p));
const humans = (game) => active(game).filter((p) => p !== BOT);

function clearTimers(code) {
  const t = timers.get(code);
  if (t) {
    clearTimeout(t.round);
    clearTimeout(t.bot);
  }
  timers.delete(code);
}

function setTimer(room, kind, ms, fn) {
  const t = timers.get(room.code) || {};
  clearTimeout(t[kind]);
  const game = room.hedef;
  t[kind] = setTimeout(() => {
    t[kind] = null;
    if (room.hedef !== game || game.done || rooms.get(room.code) !== room) return;
    fn(game);
  }, ms);
  timers.set(room.code, t);
}

// Herkese aynı oyun gider; tur sürerken başkalarının sadece durumu (ulaştı mı, kaç fark), kendininki tam.
function view(game, name) {
  if (!game) return null;
  const play = game.phase === 'play';
  const status = {};
  for (const [p, b] of Object.entries(game.best)) status[p] = play ? { diff: b.diff } : b;
  return {
    id: game.id, by: game.by, players: game.players, left: game.left, rounds: game.rounds, round: game.round,
    phase: game.phase, nums: game.nums, target: game.target, roundStart: game.roundStart, roundEnd: game.roundEnd,
    ready: game.ready, totals: game.totals, status, mine: game.best[name] || null, last: game.last,
    done: game.done, winners: game.winners, reason: game.reason, now: Date.now(),
  };
}

function send(room) {
  for (const [id, user] of room.users) io.to(id).emit('hedef', view(room.hedef, user.name));
}

function start(room, by, players, { rounds }) {
  clearTimers(room.code);
  rounds = ROUNDS.includes(rounds) ? rounds : 5;
  room.hedef = {
    id: Date.now(), by, players, left: [], rounds, round: -1, phase: 'play', nums: [], target: 0,
    roundStart: 0, roundEnd: 0, ready: [], totals: Object.fromEntries(players.map((p) => [p, 0])),
    best: {}, last: null, done: false, winners: [], reason: null,
  };
  postSystem(room, players.length > 1
    ? `${by} Hedef sayı başlattı (${rounds} tur): ${players.join(', ')}`
    : `${by} tek başına Hedef sayı oynuyor (${rounds} tur)`);
  startRound(room);
}

function startRound(room) {
  const game = room.hedef;
  const made = makeRound();
  game.cur = made; // çözüm ve botun planı: istemciye gitmez (view sadece seçili alanları gönderir)
  Object.assign(game, {
    round: game.round + 1, phase: 'play', nums: made.nums, target: made.target, best: {},
    roundStart: Date.now(), roundEnd: Date.now() + ROUND_MS, ready: [],
  });
  setTimer(room, 'round', ROUND_MS, () => endRound(room));
  if (active(game).includes(BOT)) setTimer(room, 'bot', rand(ROUND_MS * 20 / 90, ROUND_MS * 70 / 90), () => botSubmit(room));
  send(room);
}

function botSubmit(room) {
  const game = room.hedef;
  if (!game || game.phase !== 'play' || game.best[BOT] || !active(game).includes(BOT)) return;
  submit(room, BOT, { id: game.id, round: game.round, steps: game.cur.bot });
}

// Tur, süre dolunca ya da herkes tam bulunca biter (bot bir kez gönderir; insanlar bitirince o da hemen gönderir).
function submit(room, name, data) {
  const game = room.hedef;
  if (!game || game.done || game.phase !== 'play' || !active(game).includes(name)) return { error: 'Tur sürmüyor.' };
  if (!data || data.id !== game.id || data.round !== game.round) return { error: 'Bu tur bitti.' };
  const res = replay(game.nums, data.steps, game.target);
  if (!res) return { error: 'Geçersiz işlem.' };
  const at = Date.now();
  const old = game.best[name];
  if (old && old.diff <= res.diff) return { ok: true, improved: false, ...old };
  game.best[name] = { value: res.value, diff: res.diff, steps: res.text, at: at - game.roundStart, points: points(res.diff, game.roundEnd - at) };
  if (humans(game).every((p) => game.best[p]?.diff === 0) && active(game).includes(BOT) && !game.best[BOT]) {
    clearTimeout(timers.get(room.code)?.bot);
    botSubmit(room);
    if (room.hedef !== game || game.phase !== 'play') return { ok: true, improved: true, ...game.best[name] };
  }
  if (settled(game)) endRound(room);
  else send(room);
  return { ok: true, improved: true, ...game.best[name] };
}

const settled = (game) => active(game).every((p) => (p === BOT ? game.best[p] : game.best[p]?.diff === 0));

// Turun puanları toplama eklenir, sonuç (herkesin adımları ve bir tam çözüm) ara ekranında gösterilir.
function scoreRound(game) {
  const results = {};
  for (const p of game.players) {
    const b = game.best[p];
    results[p] = b ? { value: b.value, diff: b.diff, points: b.points, steps: b.steps } : null;
    game.totals[p] += b?.points || 0;
  }
  const solution = replay(game.nums, game.cur.solution, game.target).text;
  game.last = { round: game.round, nums: game.nums, target: game.target, results, solution };
}

function roundLine(game) {
  const { results } = game.last;
  return active(game).map((p) => {
    const r = results[p];
    if (!r) return `${p} göndermedi`;
    return `${p} ${r.value}${r.diff ? ` (${r.diff} fark)` : ' ✓'} +${r.points}`;
  }).join(' · ');
}

function endRound(room) {
  const game = room.hedef;
  if (!game || game.done || game.phase !== 'play') return;
  clearTimers(room.code);
  scoreRound(game);
  if (game.round + 1 >= game.rounds) return finish(room, null, true);
  postSystem(room, `Hedef sayı ${game.round + 1}. tur (hedef ${game.target}): ${roundLine(game)}`);
  game.phase = 'break';
  game.ready = [];
  send(room);
}

// Arada oyuncu "Sonraki tur"a basar; oyunda kalan herkes basınca yeni tur başlar.
function ready(room, name) {
  const game = room.hedef;
  if (!game || game.done || game.phase !== 'break' || !humans(game).includes(name) || game.ready.includes(name)) return;
  game.ready.push(name);
  if (allReady(game)) startRound(room);
  else send(room);
}

const allReady = (game) => humans(game).every((p) => game.ready.includes(p));

function finish(room, reason, scored) {
  const game = room.hedef;
  if (!game || game.done) return;
  clearTimers(room.code);
  if (game.phase === 'play' && !scored) scoreRound(game);
  const roundText = game.phase === 'play' ? `Son tur (hedef ${game.target}): ${roundLine(game)}. ` : '';
  const ranked = active(game).sort((a, b) => game.totals[b] - game.totals[a]);
  const top = ranked.length ? game.totals[ranked[0]] : 0;
  Object.assign(game, { done: true, phase: 'done', ready: [], reason: reason || null, winners: top > 0 ? ranked.filter((p) => game.totals[p] === top) : [] });
  send(room);
  const prefix = reason ? `${reason} ` : '';
  if (game.players.length === 1) return postSystem(room, `${prefix}${roundText}Hedef sayı bitti: ${game.players[0]} ${game.totals[game.players[0]]} puan.`);
  const all = [...ranked, ...game.left.filter((p) => game.players.includes(p))];
  const table = all.map((p, i) => `${i + 1}. ${p} ${game.totals[p]}${game.left.includes(p) ? ' (ayrıldı)' : ''}`).join(' · ');
  const head = game.winners.length > 1 ? `berabere (${game.winners.join(', ')})!` : game.winners.length ? `🏆 ${game.winners[0]} kazandı.` : 'kimse puan alamadı.';
  postSystem(room, `${prefix}${roundText}Hedef sayı bitti, ${head} ${table}`);
}

// Ayrılan oyuncu sonraki turlara katılmaz; oyunda insan kalmazsa oyun biter.
function left(room, name) {
  const game = room.hedef;
  if (!game || game.done || !game.players.includes(name) || game.left.includes(name)) return;
  game.left.push(name);
  if (!humans(game).length) return finish(room, `${name} ayrıldı.`);
  if (name === BOT) clearTimeout(timers.get(room.code)?.bot);
  if (game.phase === 'play' && settled(game)) return endRound(room);
  if (game.phase === 'break' && allReady(game)) return startRound(room);
  send(room);
}

const running = (room) => Boolean(room.hedef && !room.hedef.done);

// Soket olayları; ctx() o anki { room, name } ya da null döner.
function attach(socket, ctx) {
  socket.on('hedef:submit', (data, ack) => {
    const c = ctx();
    if (!c) return;
    const res = submit(c.room, c.name, data);
    if (typeof ack === 'function') ack(res);
  });
  socket.on('hedef:next', () => {
    const c = ctx();
    if (c) ready(c.room, c.name);
  });
  socket.on('hedef:end', () => {
    const c = ctx();
    const game = c?.room.hedef;
    if (!game || game.done || !active(game).includes(c.name)) return;
    finish(c.room, `${c.name} oyunu bitirdi.`);
  });
  socket.on('hedef:close', () => {
    const c = ctx();
    if (!c?.room.hedef?.done) return;
    c.room.hedef = null;
    send(c.room);
  });
}

module.exports = { init, ROUNDS, solve, replay, makeRound, points, view, start, left, running, attach, clearTimers };
