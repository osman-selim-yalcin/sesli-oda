// ---------- Gizli kural ----------
// Bilgisayar 3 sayılık diziler (1-20, tekrar serbest) için listeden gizli bir kural seçer. Herkes aynı anda,
// sıra beklemeden dizi dener; sunucu "uyuyor/uymuyor" der. Kuralı bildiğini düşünen listeden seçer: doğruysa
// bitirir, yanlışsa ceza alır ve devam eder. Kural ve başkalarının denemeleri oyun bitene kadar istemciye gitmez.

const MIN = 1;
const MAX = 20;
const START_POINTS = 1500;
const TRY_COST = 40;
const WRONG_COST = 150;
const SEC_COST = 2.5;
const BOT_DELAY = [5000, 11000];

const even = (n) => n % 2 === 0;
const odd = (n) => n % 2 === 1;

// Kural listesi: kolaydan zora karışık. id'ler sabit (istemcideki notlar bunlara göre tutulur).
const RULES = [
  { id: 'inc', text: 'Artan sırada (her sayı öncekinden büyük)', fn: (a, b, c) => a < b && b < c },
  { id: 'dec', text: 'Azalan sırada (her sayı öncekinden küçük)', fn: (a, b, c) => a > b && b > c },
  { id: 'nondec', text: 'Her sayı öncekinden büyük ya da ona eşit', fn: (a, b, c) => a <= b && b <= c },
  { id: 'alleven', text: 'Hepsi çift', fn: (a, b, c) => even(a) && even(b) && even(c) },
  { id: 'allodd', text: 'Hepsi tek', fn: (a, b, c) => odd(a) && odd(b) && odd(c) },
  { id: 'sumeven', text: 'Toplamı çift', fn: (a, b, c) => even(a + b + c) },
  { id: 'sumgt30', text: "Toplamı 30'dan büyük", fn: (a, b, c) => a + b + c > 30 },
  { id: 'sumlt20', text: "Toplamı 20'den küçük", fn: (a, b, c) => a + b + c < 20 },
  { id: 'sum3', text: "Toplamı 3'ün katı", fn: (a, b, c) => (a + b + c) % 3 === 0 },
  { id: 'midmax', text: 'Ortadaki en büyük', fn: (a, b, c) => b > a && b > c },
  { id: 'midmin', text: 'Ortadaki en küçük', fn: (a, b, c) => b < a && b < c },
  { id: 'firstmax', text: 'İlk sayı en büyük', fn: (a, b, c) => a > b && a > c },
  { id: 'lastmax', text: 'Son sayı en büyük', fn: (a, b, c) => c > a && c > b },
  { id: 'firstlast', text: 'İlk ve son sayı aynı', fn: (a, b, c) => a === c },
  { id: 'distinct', text: 'Üçü de farklı', fn: (a, b, c) => a !== b && b !== c && a !== c },
  { id: 'plus2', text: 'İkinci sayı = birinci + 2', fn: (a, b) => b === a + 2 },
  { id: 'arith', text: 'Aralar eşit (ikinci − birinci = üçüncü − ikinci)', fn: (a, b, c) => b - a === c - b },
  { id: 'sumlast', text: 'Üçüncü sayı = ilk ikisinin toplamı', fn: (a, b, c) => c === a + b },
  { id: 'anygt10', text: "En az biri 10'dan büyük", fn: (a, b, c) => a > 10 || b > 10 || c > 10 },
  { id: 'allgt5', text: "Hepsi 5'ten büyük", fn: (a, b, c) => a > 5 && b > 5 && c > 5 },
  { id: 'oneodd', text: 'Tam bir tanesi tek', fn: (a, b, c) => [a, b, c].filter(odd).length === 1 },
  { id: 'prodeven', text: 'Çarpımı çift', fn: (a, b, c) => even(a * b * c) },
  { id: 'firstlt3', text: 'Birinci sayı üçüncüden küçük', fn: (a, b, c) => a < c },
  { id: 'secgt1', text: 'İkinci sayı birinciden büyük', fn: (a, b) => b > a },
  { id: 'all3', text: "Hepsi 3'ün katı", fn: (a, b, c) => a % 3 === 0 && b % 3 === 0 && c % 3 === 0 },
  { id: 'any5', text: "En az biri 5'in katı", fn: (a, b, c) => a % 5 === 0 || b % 5 === 0 || c % 5 === 0 },
  { id: 'range5', text: "En büyük ile en küçüğün farkı 5'ten az", fn: (a, b, c) => Math.max(a, b, c) - Math.min(a, b, c) < 5 },
];
const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));
const RULE_LIST = RULES.map(({ id, text }) => ({ id, text })); // istemciye giden liste (fonksiyonsuz)

// 1-20 uzayındaki tüm diziler (8000); bot ve örnek dizi seçimi için
const ALL = [];
for (let a = MIN; a <= MAX; a++) for (let b = MIN; b <= MAX; b++) for (let c = MIN; c <= MAX; c++) ALL.push([a, b, c]);

const fits = (rule, seq) => Boolean(rule.fn(...seq));
const validSeq = (seq) => Array.isArray(seq) && seq.length === 3 && seq.every((n) => Number.isInteger(n) && n >= MIN && n <= MAX);
const sameSeq = (x, y) => x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
const points = (tries, wrong, ms) => Math.max(0, Math.round(START_POINTS - TRY_COST * tries - WRONG_COST * wrong - SEC_COST * (ms / 1000)));

// Bot: kendi denemeleriyle çelişmeyen kuralları sayar; en az 8 denemeden sonra tek aday kalınca (her tur %30,
// iki aday kalınca %15 ihtimalle) tahmin eder. İnsandan çok güçlü olmasın diye her turda eski denemelerinin bir
// kısmını unutur ve denemelerinin çoğu rastgeledir; kalanlar adayları ikiye bölmeye çalışır. 1-20 uzayında 2000
// oyunluk benzetimde ortalama 14 deneme, ~2 dk (tur başına ort. 8 sn), ~600 puan.
const BOT_FORGET = 0.4;
const BOT_RANDOM = 0.8;
const BOT_MIN_TRIES = 8;
const BOT_SURE = [0.3, 0.15]; // tek aday / iki aday kalınca o tur tahmin etme ihtimali
function botMove(tries, wrong, pick) {
  const memory = tries.filter(() => Math.random() > BOT_FORGET);
  const cands = RULES.filter((r) => !wrong.includes(r.id) && memory.every((t) => fits(r, t.seq) === t.ok));
  // Emin olsa da hemen söylemez (insan gibi bir iki deneme daha yapar)
  const sure = tries.length >= BOT_MIN_TRIES && (cands.length === 1 ? Math.random() < BOT_SURE[0] : cands.length === 2 && Math.random() < BOT_SURE[1]);
  if (sure) return { guess: pick(cands).id };
  const fresh = (s) => !tries.some((t) => sameSeq(t.seq, s));
  if (Math.random() < BOT_RANDOM || cands.length < 2) {
    for (let i = 0; i < 50; i++) {
      const s = pick(ALL);
      if (fresh(s)) return { seq: s };
    }
  }
  // Adayları en dengeli bölen diziyi rastgele bir örneklem içinden seç
  let best = null;
  let bestGap = Infinity;
  for (let i = 0; i < 300; i++) {
    const s = pick(ALL);
    if (!fresh(s)) continue;
    const gap = Math.abs(cands.filter((r) => fits(r, s)).length * 2 - cands.length);
    if (gap < bestGap) [best, bestGap] = [s, gap];
  }
  return { seq: best || pick(ALL) };
}

module.exports = function createKural({ io, rooms, getRoom, postSystem, rand, pick, BOT }) {
  const timers = new Map(); // oda kodu -> bot zamanlayıcısı

  // Kural oyun bitene kadar yok; başkalarının denemeleri yalnızca sayı olarak gider (bitince hepsi açılır).
  function view(game, name) {
    if (!game) return null;
    const { rule, tries, wrong, ...rest } = game;
    const open = game.done;
    return {
      ...rest,
      rules: RULE_LIST,
      now: Date.now(), // istemci sayaç için saat farkını buradan hesaplar
      rule: open ? RULE_BY_ID.get(rule).text : null,
      ruleId: open ? rule : null,
      counts: Object.fromEntries(game.players.map((p) => [p, { tries: tries[p].length, wrong: wrong[p].length }])),
      tries: open ? tries : (tries[name] ? { [name]: tries[name] } : {}),
      wrong: open ? wrong : (wrong[name] ? { [name]: wrong[name] } : {}),
    };
  }

  function send(room) {
    for (const [id, user] of room.users) io.to(id).emit('kural', view(room.kural, user.name));
  }

  function start(room, by, players) {
    clearTimeout(timers.get(room.code));
    const rule = pick(RULES);
    const example = pick(ALL.filter((s) => fits(rule, s)));
    room.kural = {
      id: Date.now(), players, example, finished: {}, gone: [],
      tries: Object.fromEntries(players.map((p) => [p, []])),
      wrong: Object.fromEntries(players.map((p) => [p, []])),
      rule: rule.id, startedAt: Date.now(), endedAt: null, done: false, winners: [], reason: null,
    };
    postSystem(room, players.length > 1 ? `${by} Gizli kural başlattı: ${players.join(' – ')}` : `${by} tek başına Gizli kural oynuyor`);
    send(room);
    botLater(room);
  }

  const active = (game, name) => game && !game.done && game.players.includes(name) && !game.finished[name] && !game.gone.includes(name);

  function trySeq(room, name, seq) {
    const game = room.kural;
    if (!active(game, name) || !validSeq(seq)) return;
    const mine = game.tries[name];
    if (mine.some((t) => sameSeq(t.seq, seq))) return;
    mine.push({ seq: [...seq], ok: fits(RULE_BY_ID.get(game.rule), seq), at: Date.now() });
    send(room);
    botLater(room);
  }

  function guess(room, name, ruleId) {
    const game = room.kural;
    if (!active(game, name) || !RULE_BY_ID.has(ruleId) || game.wrong[name].includes(ruleId)) return;
    if (ruleId !== game.rule) {
      game.wrong[name].push(ruleId);
      send(room);
      return botLater(room);
    }
    const ms = Date.now() - game.startedAt;
    const f = { tries: game.tries[name].length, wrong: game.wrong[name].length, ms };
    game.finished[name] = { ...f, points: points(f.tries, f.wrong, ms) };
    if (game.players.length > 1 && !settled(game)) postSystem(room, `${name} gizli kuralı ${f.tries} denemede buldu: ${game.finished[name].points} puan.`);
    if (settled(game)) return finishByPoints(room);
    send(room);
    botLater(room);
  }

  // Oyun herkes bulunca (ya da ayrılınca) biter; geride yalnız bot kaldıysa da biter.
  function settled(game) {
    const left = game.players.filter((p) => !game.finished[p] && !game.gone.includes(p));
    if (!left.length) return true;
    const humans = game.players.filter((p) => p !== BOT && !game.gone.includes(p));
    return left.every((p) => p === BOT) && !humans.length;
  }

  // Kazanan en yüksek puanlı; bulamayan 0 sayılır (kimse bulmadıysa kazanan yok).
  function finishByPoints(room, reason) {
    const game = room.kural;
    const pts = (p) => game.finished[p]?.points ?? -1;
    const best = Math.max(...game.players.map(pts));
    finish(room, best < 0 ? [] : game.players.filter((p) => pts(p) === best), reason);
  }

  function end(room, name) {
    const game = room.kural;
    if (!game || game.done || !game.players.includes(name) || game.gone.includes(name)) return;
    if (Object.keys(game.finished).length) return finishByPoints(room, `${name} oyunu bitirdi.`);
    finish(room, [], `${name} oyunu bitirdi.`);
  }

  function close(room) {
    if (!room.kural?.done) return;
    room.kural = null;
    send(room);
  }

  // Ayrılan oyundan düşer, kalanlar devam eder (bulduysa puanı kalır).
  function left(room, name) {
    const game = room.kural;
    if (!game || game.done || !game.players.includes(name) || game.finished[name] || game.gone.includes(name)) return;
    game.gone.push(name);
    if (settled(game)) {
      const reason = `${name} ayrıldı.`;
      return Object.keys(game.finished).length ? finishByPoints(room, reason) : finish(room, [], reason);
    }
    if (game.players.length > 1) postSystem(room, `${name} Gizli kuraldan ayrıldı; kalanlar devam ediyor.`);
    send(room);
    botLater(room);
  }

  function finish(room, winners, reason) {
    const game = room.kural;
    if (!game || game.done) return;
    clearTimeout(timers.get(room.code));
    Object.assign(game, { done: true, winners, endedAt: Date.now(), reason: reason || null });
    send(room);
    const prefix = reason ? `${reason} ` : '';
    const ruleText = RULE_BY_ID.get(game.rule).text;
    const fmt = (ms) => { const t = Math.round(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    const line = (p) => {
      const f = game.finished[p];
      if (!f) return `${p} ${game.gone.includes(p) ? 'ayrıldı' : 'bulamadı'}`;
      return `${p} ${f.tries} deneme${f.wrong ? `, ${f.wrong} yanlış` : ''}, ${fmt(f.ms)} → ${f.points} puan`;
    };
    if (game.players.length === 1) {
      const [name] = game.players;
      return postSystem(room, winners.length ? `${line(name)} 🎉 Kural: ${ruleText}` : `${prefix}Gizli kural bitti; kural "${ruleText}" idi.`);
    }
    const summary = `${game.players.map(line).join(' · ')}. Kural: ${ruleText}`;
    if (winners.length > 1) return postSystem(room, `${prefix}Gizli kural berabere (${winners.join(', ')})! ${summary}`);
    if (winners.length === 1) return postSystem(room, `${prefix}Gizli kural bitti: 🏆 ${winners[0]}. ${summary}`);
    postSystem(room, `${prefix}Gizli kural bitti. ${summary}`);
  }

  function botTurn(room) {
    const game = room.kural;
    const move = botMove(game.tries[BOT], game.wrong[BOT], pick);
    if (move.guess) return guess(room, BOT, move.guess);
    trySeq(room, BOT, move.seq);
  }

  function botLater(room) {
    const game = room.kural;
    clearTimeout(timers.get(room.code));
    if (!room.bot || !active(game, BOT)) return;
    timers.set(room.code, setTimeout(() => {
      timers.delete(room.code);
      if (room.kural !== game || game.done || rooms.get(room.code) !== room) return;
      botTurn(room);
    }, rand(...BOT_DELAY)));
  }

  function clear(code) {
    clearTimeout(timers.get(code));
    timers.delete(code);
  }

  // Socket olayları; code() bağlantının o anki oda kodunu verir.
  function bind(socket, code) {
    const act = (fn, ok) => (value) => {
      const c = code();
      if (!c || !ok(value)) return;
      const room = getRoom(c);
      const user = room.users.get(socket.id);
      if (user) fn(room, user.name, value);
    };
    socket.on('kural:try', act(trySeq, validSeq));
    socket.on('kural:guess', act(guess, (v) => typeof v === 'string'));
    socket.on('kural:end', act(end, () => true));
    socket.on('kural:close', act(close, () => true));
  }

  const running = (room) => Boolean(room.kural && !room.kural.done);

  return { start, view, send, left, clear, bind, running };
};

module.exports.RULES = RULES;
module.exports.ALL = ALL;
module.exports.fits = fits;
module.exports.points = points;
module.exports.botMove = botMove;
