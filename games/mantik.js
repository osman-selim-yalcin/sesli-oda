// ---------- Mantık tablosu ----------
// Dört kişi yan yana dört evde oturur; her kişinin her kategoride (renk, hayvan, içecek...) bir değeri var.
// Bilgisayar rastgele bir çözüm seçer, bu çözüme uyan ipuçlarını tek çözüm kalana kadar ekler, sonra gereksiz
// ipuçlarını atar. Herkes aynı bulmacayı aynı anda çözer; çözüm sadece oyun bitince gönderilir.
// Kolay: isim + 2 özellik. Zor: isim + konum (1-4. ev) + 2 özellik ve "solunda / yanında" gibi konum ipuçları.

const LEVELS = {
  kolay: { base: 1000, attrs: 2, konum: false, clues: [6, 8], bot: [120000, 240000] },
  zor: { base: 2000, attrs: 2, konum: true, clues: [8, 12], bot: [240000, 480000] },
};
const SIZE = 4;
const WRONG_COST = 150;
const SEC_COST = 2;
const CHECK_COOLDOWN = 1500; // ms; art arda kontrol denemesini yavaşlatır

// İsimlerin "-in" hâli (konum ipuçlarında "Zeynep'in hemen solunda").
const NAMES = {
  Ayşe: "Ayşe'nin", Mehmet: "Mehmet'in", Zeynep: "Zeynep'in", Can: "Can'ın", Elif: "Elif'in", Ali: "Ali'nin",
  Deniz: "Deniz'in", Emre: "Emre'nin", Selin: "Selin'in", Murat: "Murat'ın", Ece: "Ece'nin", Burak: "Burak'ın",
  Fatma: "Fatma'nın", Kerem: "Kerem'in", Leyla: "Leyla'nın", Ozan: "Ozan'ın",
};

// Her değerin cümlede kullanılan biçimleri:
// pred: "... çay içiyor", neg: "... çay içmiyor", subj: "çay içen kişi", gen: "çay içen kişinin".
// either(b, c): "ya çay ya da kahve içiyor". Hepsi küçük harfle; cümle başı sonra büyütülür.
const verb = (word, yes, no, rel) => ({ label: word, pred: `${word} ${yes}`, neg: `${word} ${no}`, subj: `${word} ${rel} kişi`, gen: `${word} ${rel} kişinin` });
const ATTRS = {
  renk: {
    title: 'Ev rengi', head: 'Ev',
    values: ['kırmızı', 'mavi', 'yeşil', 'sarı', 'beyaz', 'mor', 'turuncu', 'pembe'].map((w) => ({
      label: w, pred: `${w} evde oturuyor`, neg: `${w} evde oturmuyor`, subj: `${w} evdeki kişi`, gen: `${w} evin`, house: `${w} ev`,
    })),
    either: (b, c) => `ya ${b.label} ya da ${c.label} evde oturuyor`,
  },
  hayvan: {
    title: 'Hayvan', head: 'Hayvan',
    values: ['kedi', 'köpek', 'kuş', 'balık', 'tavşan', 'kaplumbağa', 'hamster', 'papağan'].map((w) => verb(w, 'besliyor', 'beslemiyor', 'besleyen')),
    either: (b, c) => `ya ${b.label} ya da ${c.label} besliyor`,
  },
  icecek: {
    title: 'İçecek', head: 'İçecek',
    values: ['çay', 'kahve', 'ayran', 'limonata', 'süt', 'şalgam', 'meyve suyu', 'soda'].map((w) => verb(w, 'içiyor', 'içmiyor', 'içen')),
    either: (b, c) => `ya ${b.label} ya da ${c.label} içiyor`,
  },
  meslek: {
    title: 'Meslek', head: 'Meslek',
    values: [['doktor', 'doktorun'], ['öğretmen', 'öğretmenin'], ['aşçı', 'aşçının'], ['mühendis', 'mühendisin'], ['avukat', 'avukatın'],
      ['pilot', 'pilotun'], ['hemşire', 'hemşirenin'], ['mimar', 'mimarın']].map(([w, gen]) => ({ label: w, pred: w, neg: `${w} değil`, subj: w, gen })),
    either: (b, c) => `ya ${b.label} ya da ${c.label}`,
  },
  hobi: {
    title: 'Hobi', head: 'Hobi',
    values: [
      ['satranç', 'satranç oynuyor', 'satranç oynamıyor', 'satranç oynayan'], ['resim', 'resim yapıyor', 'resim yapmıyor', 'resim yapan'],
      ['gitar', 'gitar çalıyor', 'gitar çalmıyor', 'gitar çalan'], ['kitap', 'kitap okuyor', 'kitap okumuyor', 'kitap okuyan'],
      ['yüzme', 'yüzmeye gidiyor', 'yüzmeye gitmiyor', 'yüzmeye giden'], ['bahçe', 'bahçeyle uğraşıyor', 'bahçeyle uğraşmıyor', 'bahçeyle uğraşan'],
      ['dans', 'dans ediyor', 'dans etmiyor', 'dans eden'], ['fotoğraf', 'fotoğraf çekiyor', 'fotoğraf çekmiyor', 'fotoğraf çeken'],
    ].map(([label, pred, neg, rel]) => ({ label, pred, neg, subj: `${rel} kişi`, gen: `${rel} kişinin` })),
    either: (b, c) => `ya ${b.pred} ya da ${c.pred}`,
  },
};
const KONUM = {
  key: 'konum', title: 'Konum', head: 'Ev no',
  values: [1, 2, 3, 4].map((n) => ({ n, label: `${n}. ev`, pred: `${n}. evde oturuyor`, neg: `${n}. evde oturmuyor`, subj: `${n}. evdeki kişi`, gen: `${n}. evdeki kişinin` })),
  either: (b, c) => `ya ${b.n}. ya da ${c.n}. evde oturuyor`,
};

const rnd = (n) => Math.floor(Math.random() * n);
const pickOne = (list) => list[rnd(list.length)];
function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const cap = (s) => s.charAt(0).toLocaleUpperCase('tr') + s.slice(1);

// 4 elemanın 24 sıralaması
const PERMS = (() => {
  const out = [];
  const walk = (prefix) => {
    if (prefix.length === SIZE) return out.push(prefix);
    for (let i = 0; i < SIZE; i++) if (!prefix.includes(i)) walk([...prefix, i]);
  };
  walk([]);
  return out;
})();

// Bir aday çözüm: who[c][v] = c kategorisinde v değeri olan kişi; val[c][p] = p kişisinin c kategorisindeki değeri.
// 0. kategori isimdir ve kişi numarasıyla aynıdır (who[0][v] = v).
function allCandidates(k) {
  const out = [];
  const identity = [0, 1, 2, 3];
  const walk = (val) => {
    if (val.length === k) {
      const who = val.map((perm) => { const w = []; perm.forEach((v, p) => { w[v] = p; }); return w; });
      return out.push({ val, who });
    }
    for (const perm of PERMS) walk([...val, perm]);
  };
  walk([identity]);
  return out;
}
const CANDIDATES = { 3: null, 4: null };
const candidatesFor = (k) => (CANDIDATES[k] ||= allCandidates(k));

// İpucu türleri. a, b, c: [kategori, değer]. kc: konum kategorisinin numarası (yoksa -1).
function holds(clue, s, kc) {
  const P = ([c, v]) => s.who[c][v];
  const pos = (item) => s.val[kc][P(item)];
  switch (clue.t) {
    case 'same': return P(clue.a) === P(clue.b);
    case 'diff': return P(clue.a) !== P(clue.b);
    case 'either': return P(clue.a) === P(clue.b) || P(clue.a) === P(clue.c);
    case 'left': return pos(clue.a) === pos(clue.b) - 1;
    case 'next': return Math.abs(pos(clue.a) - pos(clue.b)) === 1;
    case 'apart': return Math.abs(pos(clue.a) - pos(clue.b)) >= 2;
    case 'gap': return Math.abs(pos(clue.a) - pos(clue.b)) === 2;
    case 'edge': return pos(clue.a) === 0 || pos(clue.a) === SIZE - 1;
    case 'middle': return pos(clue.a) === 1 || pos(clue.a) === 2;
    default: return false;
  }
}

const CLUE_WEIGHTS = {
  kolay: { same: 2, diff: 4, either: 4 },
  zor: { same: 1, diff: 3, either: 3, left: 2, next: 2, apart: 1, gap: 1, edge: 1, middle: 1 },
};

// Çözüme uyan rastgele bir ipucu
function randomClue(level, sol, cats, kc) {
  const weights = CLUE_WEIGHTS[level];
  const types = Object.keys(weights);
  let r = Math.random() * types.reduce((s, t) => s + weights[t], 0);
  const t = types.find((x) => (r -= weights[x]) < 0) || types[0];
  const k = cats.length;
  const nonKonum = [...Array(k).keys()].filter((c) => c !== kc);
  const item = (c, p) => [c, sol.val[c][p]];
  const twoCats = (list) => { const [x, y] = shuffled(list); return [x, y]; };
  // Renk ile konum aynı ipucunda sadece "2. ev kırmızı" biçiminde (same/diff) geçer.
  const okPair = (x, y) => !(cats[x].key === 'renk' && y === kc) && !(cats[y].key === 'renk' && x === kc);
  if (t === 'same' || t === 'diff') {
    const [c1, c2] = twoCats([...Array(k).keys()]);
    const p = rnd(SIZE);
    const q = t === 'same' ? p : pickOne([0, 1, 2, 3].filter((x) => x !== p));
    return { t, a: item(c1, p), b: item(c2, q) };
  }
  if (t === 'either') {
    let c1; let c2;
    do [c1, c2] = twoCats([...Array(k).keys()]); while (!okPair(c1, c2));
    const p = rnd(SIZE);
    const other = pickOne([0, 1, 2, 3].filter((x) => x !== p));
    // Konum seçenekleri küçükten büyüğe yazılır ("ya 2. ya da 4. evde").
    const [b, c] = c2 === kc ? [item(c2, p), item(c2, other)].sort((x, y) => x[1] - y[1]) : shuffled([item(c2, p), item(c2, other)]);
    return { t, a: item(c1, p), b, c };
  }
  // Konum ipuçları: iki farklı kişi (konum kategorisi dışından birer özellik)
  const p = rnd(SIZE);
  const posOf = (x) => sol.val[kc][x];
  if (t === 'edge' || t === 'middle') {
    const people = [0, 1, 2, 3].filter((x) => (t === 'edge') === (posOf(x) === 0 || posOf(x) === SIZE - 1));
    return { t, a: item(pickOne(nonKonum), pickOne(people)) };
  }
  let q;
  if (t === 'left') q = [0, 1, 2, 3].find((x) => posOf(x) === posOf(p) + 1);
  else if (t === 'next') q = pickOne([0, 1, 2, 3].filter((x) => Math.abs(posOf(x) - posOf(p)) === 1));
  else if (t === 'gap') q = [0, 1, 2, 3].find((x) => Math.abs(posOf(x) - posOf(p)) === 2);
  else q = pickOne([0, 1, 2, 3].filter((x) => Math.abs(posOf(x) - posOf(p)) >= 2));
  if (q === undefined) return null;
  return { t, a: item(pickOne(nonKonum), p), b: item(pickOne(nonKonum), q) };
}

const clueKey = (c) => {
  const parts = [c.a, c.b, c.c].filter(Boolean).map((x) => x.join(':'));
  if (c.t === 'same' || c.t === 'diff' || c.t === 'next' || c.t === 'apart' || c.t === 'gap') parts.sort();
  if (c.t === 'either') parts.splice(1, 2, ...parts.slice(1).sort());
  return `${c.t}|${parts.join('|')}`;
};

// Aday çözümleri ipuçlarına göre süzer; erken durmak için en fazla `limit` tane sayar.
function countMatching(cands, clues, kc, limit = Infinity) {
  let n = 0;
  for (const s of cands) {
    if (clues.every((c) => holds(c, s, kc)) && ++n >= limit) break;
  }
  return n;
}

// Bir bulmaca üretir: { level, cats, solution, clues }
function generate(level = 'kolay') {
  const cfg = LEVELS[level];
  const [min, max] = cfg.clues;
  let best = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const names = shuffled(Object.keys(NAMES)).slice(0, SIZE);
    const attrs = shuffled(Object.keys(ATTRS)).slice(0, cfg.attrs);
    const cats = [
      { key: 'isim', title: 'İsim', head: 'İsim', values: names.map((n) => ({ label: n, pred: n, neg: `${n} değil`, subj: n, gen: NAMES[n] })), either: (b, c) => `ya ${b.label} ya da ${c.label}` },
      ...(cfg.konum ? [KONUM] : []),
      ...attrs.map((key) => { const a = ATTRS[key]; return { key, title: a.title, head: a.head, values: shuffled(a.values).slice(0, SIZE), either: a.either }; }),
    ];
    // Değerleri alfabetik sırala (tablo düzgün dursun); konum zaten 1-4.
    for (const c of cats) if (c.key !== 'konum') c.values = [...c.values].sort((x, y) => x.label.localeCompare(y.label, 'tr'));
    const kc = cats.findIndex((c) => c.key === 'konum');
    const k = cats.length;
    const sol = { val: [[0, 1, 2, 3], ...Array.from({ length: k - 1 }, () => pickOne(PERMS))] };
    sol.who = sol.val.map((perm) => { const w = []; perm.forEach((v, p) => { w[v] = p; }); return w; });

    // Tek çözüm kalana kadar adayları eleyen ipuçları ekle.
    let cands = candidatesFor(k);
    const clues = [];
    const seen = new Set();
    for (let tries = 0; cands.length > 1 && tries < 2000; tries++) {
      const clue = randomClue(level, sol, cats, kc);
      if (!clue) continue;
      const key = clueKey(clue);
      if (seen.has(key)) continue;
      seen.add(key);
      const next = cands.filter((s) => holds(clue, s, kc));
      if (next.length === cands.length) continue;
      cands = next;
      clues.push(clue);
    }
    if (cands.length !== 1) continue;
    // Gereksiz ipuçlarını at: çıkarınca hâlâ tek çözüm kalıyorsa gerek yok.
    const all = candidatesFor(k);
    for (const clue of shuffled(clues)) {
      const rest = clues.filter((c) => c !== clue);
      if (countMatching(all, rest, kc, 2) === 1) clues.splice(clues.indexOf(clue), 1);
    }
    const puzzle = { level, cats, sol, clues: shuffled(clues), kc };
    if (clues.length >= min && clues.length <= max) return finalize(puzzle);
    const miss = clues.length < min ? min - clues.length : clues.length - max;
    if (!best || miss < best.miss) best = { puzzle, miss };
  }
  return finalize(best.puzzle);
}

// İpucunu Türkçe cümleye çevirir.
function clueText(clue, cats) {
  const V = ([c, v]) => cats[c].values[v];
  const C = ([c]) => cats[c];
  const sentence = (s) => `${cap(s)}.`;
  const { t, a, b, c } = clue;
  const isRenk = (x) => C(x).key === 'renk';
  const isKonum = (x) => C(x).key === 'konum';
  if (t === 'same' || t === 'diff') {
    // Renk-konum: "2. ev kırmızı." / "2. ev kırmızı değil."
    if ((isRenk(a) && isKonum(b)) || (isKonum(a) && isRenk(b))) {
      const [k, r] = isKonum(a) ? [a, b] : [b, a];
      return sentence(`${V(k).label} ${V(r).label}${t === 'diff' ? ' değil' : ''}`);
    }
    // Özne önceliği: isim > meslek > diğerleri > renk > konum
    const rank = (x) => ({ isim: 0, meslek: 1, renk: 3, konum: 4 }[C(x).key] ?? 2);
    const [s, p] = rank(a) <= rank(b) ? [a, b] : [b, a];
    return sentence(`${V(s).subj} ${t === 'same' ? V(p).pred : V(p).neg}`);
  }
  if (t === 'either') return sentence(`${V(a).subj} ${C(b).either(V(b), V(c))}`);
  // Konum cümleleri: renk öznesi ev olarak geçer ("Kırmızı ev ...").
  const who = (x) => (isRenk(x) ? V(x).house : V(x).subj);
  const sits = (x) => (isRenk(x) ? '' : ' oturuyor');
  if (t === 'left') return sentence(`${who(a)}, ${V(b).gen} hemen solunda${sits(a)}`);
  // İki taraf da renkse evlerden, değilse kişilerden söz edilir ("kırmızı evdeki kişi ile Can").
  const houses = b && isRenk(a) && isRenk(b);
  const pair = !b ? '' : houses ? `${who(a)} ile ${who(b)}` : `${V(a).subj} ile ${V(b).subj}`;
  if (t === 'next') return sentence(houses ? `${pair} yan yana` : `${pair} yan yana oturuyor`);
  if (t === 'apart') return sentence(houses ? `${pair} yan yana değil` : `${pair} yan yana oturmuyor`);
  if (t === 'gap') return sentence(`${pair} arasında tam bir ev var`);
  if (t === 'edge') return sentence(isRenk(a) ? `${who(a)} en uçtaki iki evden biri` : `${who(a)} en uçtaki iki evden birinde oturuyor`);
  if (t === 'middle') return sentence(isRenk(a) ? `${who(a)} ortadaki iki evden biri` : `${who(a)} ortadaki iki evden birinde oturuyor`);
  return '';
}

// "solunda" ipuçlarının yarısı "sağında" olarak yazılır (aynı anlam, ters çevrilmiş).
function finalize({ level, cats, sol, clues, kc }) {
  const texts = clues.map((clue) => {
    if (clue.t === 'left' && Math.random() < 0.5) {
      const V = ([c, v]) => cats[c].values[v];
      const isRenk = ([c]) => cats[c].key === 'renk';
      const who = (x) => (isRenk(x) ? V(x).house : V(x).subj);
      return `${cap(who(clue.b))}, ${V(clue.a).gen} hemen sağında${isRenk(clue.b) ? '' : ' oturuyor'}.`;
    }
    return clueText(clue, cats);
  });
  return {
    level,
    cats: cats.map((c) => ({ key: c.key, title: c.title, head: c.head, values: c.values.map((v) => v.label) })),
    // answer[c - 1][kişi] = değer (isim kategorisi kişinin kendisi, onu saymayız)
    answer: sol.val.slice(1).map((perm) => [...perm]),
    clues: texts,
    raw: clues,
    kc,
  };
}

// Çözümün tek olduğunu baştan kontrol eder (test için).
function solutionCount(puzzle) {
  return countMatching(candidatesFor(puzzle.cats.length), puzzle.raw, puzzle.kc, 3);
}

const sameAnswer = (a, b) => Array.isArray(a) && a.length === b.length
  && a.every((row, i) => Array.isArray(row) && row.length === SIZE && row.every((v, p) => v === b[i][p]));

// ---------- Oda içindeki oyun ----------

function create({ io, postSystem, getRoom, rooms, BOT }) {
  const timers = new Map(); // oda kodu -> bot zamanlayıcısı
  const botMs = () => Number(process.env.MANTIK_BOT_MS) || 0;

  const points = (game, ms, wrong) => Math.max(0, Math.round(LEVELS[game.level].base - SEC_COST * (ms / 1000) - WRONG_COST * wrong));
  const fmt = (ms) => { const t = Math.round(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const levelName = (level) => (level === 'zor' ? 'zor' : 'kolay');

  // Çözüm ve başkalarının yanlış sayısı oyun bitene kadar gönderilmez.
  function view(game, name) {
    if (!game) return null;
    const { puzzle, wrong, lastCheck, ...rest } = game;
    return {
      ...rest,
      cats: puzzle.cats,
      clues: puzzle.clues,
      myWrong: wrong[name] || 0,
      now: Date.now(),
      answer: game.done ? puzzle.answer : null,
    };
  }

  function send(room) {
    for (const [id, user] of room.users) io.to(id).emit('mantik', view(room.mantik, user.name));
  }

  function start(room, by, players, { level }) {
    clearTimeout(timers.get(room.code));
    level = LEVELS[level] ? level : 'kolay';
    const puzzle = generate(level);
    room.mantik = {
      id: Date.now(), level, players: [...players], gone: [], puzzle, finished: {}, wrong: {}, lastCheck: {},
      winners: [], startedAt: Date.now(), endedAt: null, done: false, reason: null,
    };
    postSystem(room, players.length > 1
      ? `${by} Mantık tablosu başlattı (${levelName(level)}, ${puzzle.clues.length} ipucu): ${players.join(' – ')}`
      : `${by} tek başına Mantık tablosu çözüyor (${levelName(level)}, ${puzzle.clues.length} ipucu)`);
    send(room);
    botLater(room);
  }

  const settled = (game) => game.players.every((p) => game.finished[p]);

  function solved(room, name, wrong) {
    const game = room.mantik;
    const ms = Date.now() - game.startedAt;
    game.finished[name] = { ms, wrong, points: points(game, ms, wrong) };
    if (settled(game)) return finishByPoints(room);
    if (game.players.length > 1) postSystem(room, `${name} tabloyu ${fmt(ms)} sürede çözdü: ${game.finished[name].points} puan.`);
    send(room);
  }

  // Oyuncunun cevabı: answer[c - 1][kişi] = değer. Döner: { ok } ya da { error }.
  function check(room, name, answer) {
    const game = room.mantik;
    if (!game || game.done || !game.players.includes(name) || game.finished[name]) return { error: 'Oyun yok.' };
    const now = Date.now();
    if (now - (game.lastCheck[name] || 0) < CHECK_COOLDOWN) return { error: 'Biraz bekle.' };
    const k = game.puzzle.cats.length;
    if (!Array.isArray(answer) || answer.length !== k - 1
      || !answer.every((row) => Array.isArray(row) && row.length === SIZE && row.every(Number.isInteger) && [...row].sort().join() === '0,1,2,3')) return { error: 'Tablo tamam değil.' };
    game.lastCheck[name] = now;
    if (!sameAnswer(answer, game.puzzle.answer)) {
      game.wrong[name] = (game.wrong[name] || 0) + 1;
      send(room);
      return { ok: false, wrong: game.wrong[name] };
    }
    solved(room, name, game.wrong[name] || 0);
    return { ok: true };
  }

  // Bot kolayda 2-4, zorda 4-8 dakikada bitirir; %20 ihtimalle bir yanlış kontrolü olur.
  function botLater(room) {
    const game = room.mantik;
    clearTimeout(timers.get(room.code));
    if (!game || game.done || !room.bot || !game.players.includes(BOT) || game.finished[BOT]) return;
    const [min, max] = LEVELS[game.level].bot;
    const wait = botMs() || min + Math.random() * (max - min);
    timers.set(room.code, setTimeout(() => {
      timers.delete(room.code);
      if (room.mantik !== game || game.done || rooms.get(room.code) !== room || !game.players.includes(BOT)) return;
      solved(room, BOT, Math.random() < 0.2 ? 1 : 0);
    }, wait));
  }

  // Kazanan en yüksek puanlı; bulamayan 0 sayılır, kimse bulmadıysa kazanan yok.
  function finishByPoints(room, reason) {
    const game = room.mantik;
    const pts = (p) => game.finished[p]?.points ?? -1;
    const best = Math.max(-1, ...game.players.map(pts));
    finish(room, best < 0 ? [] : game.players.filter((p) => pts(p) === best), reason);
  }

  function finish(room, winners, reason) {
    const game = room.mantik;
    if (!game || game.done) return;
    clearTimeout(timers.get(room.code));
    Object.assign(game, { done: true, winners, endedAt: Date.now(), reason: reason || null });
    send(room);
    const prefix = reason ? `${reason} ` : '';
    const line = (p) => (game.finished[p] ? `${p} ${fmt(game.finished[p].ms)} → ${game.finished[p].points} puan` : `${p} çözemedi`);
    const all = game.players;
    if (!all.length) return postSystem(room, `${prefix}Mantık tablosu bitti.`);
    if (all.length === 1) return postSystem(room, game.finished[all[0]] ? `${prefix}${line(all[0])} 🎉` : `${prefix}Mantık tablosu bitti; çözülemedi.`);
    const summary = all.map(line).join(' · ');
    if (winners.length > 1) return postSystem(room, `${prefix}Mantık tablosu berabere! ${summary}`);
    if (winners.length === 1) return postSystem(room, `${prefix}Mantık tablosu bitti: 🏆 ${winners[0]}. ${summary}`);
    postSystem(room, `${prefix}Mantık tablosu bitti. ${summary}`);
  }

  // Ayrılan oyundan düşer (çözdüyse puanı tabloda kalır). Oyunda insan kalmazsa ya da kalan herkes
  // çözmüşse oyun biter.
  function left(room, name) {
    const game = room.mantik;
    if (!game || game.done || !game.players.includes(name) || game.gone.includes(name)) return;
    if (game.finished[name]) game.gone.push(name);
    else game.players = game.players.filter((p) => p !== name);
    if (name === BOT) clearTimeout(timers.get(room.code));
    const humans = game.players.filter((p) => p !== BOT && !game.gone.includes(p));
    if (!humans.length || settled(game)) return finishByPoints(room, `${name} ayrıldı.`);
    send(room);
  }

  const running = (room) => Boolean(room.mantik && !room.mantik.done);
  const clear = (code) => clearTimeout(timers.get(code));

  // Socket olayları (server.js bağlantı işleyicisinden çağrılır).
  function bind(socket, getCode) {
    const ctx = () => {
      const code = getCode();
      if (!code) return null;
      const room = getRoom(code);
      const user = room.users.get(socket.id);
      return user ? { room, name: user.name } : null;
    };
    socket.on('mantik:check', (answer, ack) => {
      const c = ctx();
      if (!c || typeof ack !== 'function') return;
      ack(check(c.room, c.name, answer));
    });
    socket.on('mantik:end', () => {
      const c = ctx();
      const game = c?.room.mantik;
      if (!game || game.done || !game.players.includes(c.name)) return;
      finishByPoints(c.room, `${c.name} oyunu bitirdi.`);
    });
    socket.on('mantik:close', () => {
      const c = ctx();
      if (!c || !c.room.mantik?.done) return;
      c.room.mantik = null;
      send(c.room);
    });
  }

  // Lobi ayarı: zorluk (sadece kurucu)
  function lobbyOpts(lobby, name, { level }) {
    if (name === lobby.host && LEVELS[level]) lobby.opts.level = level;
  }

  return { view, send, start, check, left, running, clear, bind, lobbyOpts, finishByPoints };
}

module.exports = { create, generate, solutionCount, LEVELS };
