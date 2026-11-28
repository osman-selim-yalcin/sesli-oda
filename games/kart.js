// ---------- Kağıt oyunları: sunucu ----------
// Blackjack, Arasında, Texas Hold'em, Pişti, Batak, Kemal. Kurallar games/kart/<oyun>.js motorlarında; burası odaya
// bağlar: lobiden başlatma, herkese kendi görünümünü (kendi kartları açık, başkalarınınki kapalı) gönderme, bilgisayar
// hamleleri, otomatik adımlar (kurpiyer, el sonu), süre dolunca oyuncunun yerine hamle, ayrılanın yerine bilgisayar.
// Durum room.kart[oyun] altında tutulur.
const { seatPlayers, BOT_PREFIX } = require('./kart/cards');

const ENGINES = {
  blackjack: require('./kart/blackjack'),
  arasinda: require('./kart/arasinda'),
  poker: require('./kart/poker'),
  pisti: require('./kart/pisti'),
  batak: require('./kart/batak'),
  kemal: require('./kart/kemal'),
};
const KEYS = Object.keys(ENGINES);
const TURN_MS = { blackjack: 30000, arasinda: 30000, poker: 45000, pisti: 30000, batak: 45000, kemal: 40000 };
const BOT_DELAY = [900, 1700]; // kart animasyonları bitsin, bilgisayar düşünüyormuş gibi dursun

function create({ io, rooms, getRoom, postSystem, rand, BOT }) {
  const timers = new Map(); // `${oda}|${oyun}` -> { auto, bot, turn }
  const tkey = (room, key) => `${room.code}|${key}`;
  const isBotSeat = (g, name) => g.bots.includes(name);

  function clearTimers(room, key) {
    const t = timers.get(tkey(room, key));
    if (!t) return;
    clearTimeout(t.auto);
    clearTimeout(t.bot);
    clearTimeout(t.turn);
    timers.delete(tkey(room, key));
  }

  function viewFor(g, name) {
    if (!g) return null;
    return { ...ENGINES[g.key].view(g, name), id: g.id, by: g.by, me: name, deadlines: g.deadlines || {}, pause: g.done ? null : g.pause || null, now: Date.now(), humans: g.humans, reason: g.reason || null };
  }

  function send(room, key) {
    const g = room.kart?.[key] || null;
    for (const [id, user] of room.users) io.to(id).emit('kart', { key, game: viewFor(g, user.name) });
  }

  function standingsOf(g) {
    if (g.standings) return g.standings;
    if (g.teams) {
      const names = (t) => g.players.filter((_, i) => i % 2 === t).join(' & ');
      return [0, 1].map((t) => ({ name: names(t), score: g.teams[t] })).sort((a, b) => b.score - a.score);
    }
    const src = g.chips || g.scores || {};
    return g.players.map((p) => ({ name: p, score: src[p] ?? 0 })).sort((a, b) => b.score - a.score);
  }

  function announce(room, g) {
    const title = ENGINES[g.key].meta.title;
    const [first, second] = g.standings;
    if (first && second && first.score === second.score) return postSystem(room, `${title} bitti: berabere (${first.score}).`);
    postSystem(room, `${title} bitti: 🏆 ${first.name} (${first.score}).`);
  }

  // Durum değişti: herkese gönder, sonraki otomatik adımı, bilgisayar hamlesini ve süre sayacını kur.
  function changed(room, key) {
    const g = room.kart[key];
    clearTimers(room, key);
    if (!g) return send(room, key);
    const engine = ENGINES[key];
    if (g.done) {
      g.deadlines = {};
      if (!g.announced) {
        g.announced = true;
        g.standings = standingsOf(g);
        g.endedAt = Date.now();
        announce(room, g);
      }
      return send(room, key);
    }
    // Süre: bekleyen her insan oyuncunun bekleme başlangıcı
    const now = Date.now();
    const waitingHumans = engine.waiting(g).filter((p) => !isBotSeat(g, p));
    g.waitSince ||= {};
    for (const p of Object.keys(g.waitSince)) if (!waitingHumans.includes(p)) delete g.waitSince[p];
    for (const p of waitingHumans) g.waitSince[p] ||= now;
    g.deadlines = Object.fromEntries(Object.entries(g.waitSince).map(([p, t]) => [p, t + TURN_MS[key]]));
    const d = engine.delay(g);
    // Ara (el sonu, sonuç): kimse oynayamazken bir sonraki adıma kalan süre; istemci geri sayım çubuğu çizer
    g.pause = d != null && d >= 2500 && !engine.waiting(g).length ? { until: now + d, ms: d } : null;
    send(room, key);

    const t = {};
    const alive = () => rooms.get(room.code) === room && room.kart[key] === g && !g.done;
    if (d != null) t.auto = setTimeout(() => {
      if (!alive()) return;
      engine.step(g);
      changed(room, key);
    }, d);
    if (g.bots.length) t.bot = setTimeout(() => {
      if (!alive()) return;
      for (const name of [...g.bots].sort(() => Math.random() - 0.5)) {
        const a = engine.bot(g, name);
        if (a && engine.act(g, name, a)) return changed(room, key);
      }
    }, rand(...BOT_DELAY));
    const soonest = Math.min(...Object.values(g.deadlines));
    if (Number.isFinite(soonest)) t.turn = setTimeout(() => {
      if (!alive()) return;
      let moved = false;
      for (const [p, until] of Object.entries(g.deadlines)) {
        if (until > Date.now() + 50 || !engine.waiting(g).includes(p)) continue;
        delete g.waitSince[p];
        const a = engine.timeout(g, p);
        if (a && engine.act(g, p, a)) moved = true;
      }
      changed(room, key);
      if (moved) return;
    }, Math.max(0, soonest - now));
    timers.set(tkey(room, key), t);
  }

  function start(room, key, by, players, opts = {}) {
    const engine = ENGINES[key];
    const seats = seatPlayers(players, engine.meta.max, engine.meta.fill);
    const bots = seats.filter((p) => p === BOT || p.startsWith(BOT_PREFIX));
    room.kart ||= {};
    clearTimers(room, key);
    const g = engine.create(seats, bots, { ...engine.meta.opts, ...opts });
    Object.assign(g, { id: Date.now(), by, humans: seats.filter((p) => !bots.includes(p)), startedAt: Date.now() });
    room.kart[key] = g;
    postSystem(room, `${by} ${engine.meta.title} başlattı: ${seats.join(', ')}.`);
    changed(room, key);
  }

  function act(room, name, { key, id, a } = {}) {
    const g = room.kart?.[key];
    if (!g || g.done || g.id !== id || !g.players.includes(name)) return;
    // Ayrılıp geri gelen kendi koltuğunu bilgisayardan geri alır
    if (g.humans.includes(name) && g.bots.includes(name)) g.bots = g.bots.filter((p) => p !== name);
    if (isBotSeat(g, name) || !a || typeof a !== 'object') return;
    if (!ENGINES[key].act(g, name, a)) return;
    if (g.waitSince) delete g.waitSince[name];
    changed(room, key);
  }

  function endGame(room, key, reason) {
    const g = room.kart?.[key];
    if (!g || g.done) return;
    g.done = true;
    g.phase = 'done';
    g.reason = reason;
    changed(room, key);
  }

  // Oyunu bitir: masadaki bir insan oyuncu herkes için bitirir; o ana kadarki çip/puana göre sıralanır.
  function end(room, name, { key } = {}) {
    const g = room.kart?.[key];
    if (!g || g.done || !g.humans.includes(name)) return;
    endGame(room, key, `${name} oyunu bitirdi.`);
  }

  // Ayrılan oyuncunun yerine bilgisayar oynar; masada insan kalmazsa oyun biter.
  function left(room, name) {
    for (const key of KEYS) {
      const g = room.kart?.[key];
      if (!g || g.done || !g.humans.includes(name) || g.bots.includes(name)) continue;
      g.bots.push(name);
      const here = new Set([...room.users.values()].map((u) => u.name));
      if (!g.humans.some((p) => here.has(p) && !g.bots.includes(p))) {
        endGame(room, key, 'Masada oyuncu kalmadı.');
        continue;
      }
      postSystem(room, `${name} ayrıldı; ${ENGINES[key].meta.title} masasında yerine bilgisayar oynuyor.`);
      changed(room, key);
    }
  }

  function close(room, name, { key } = {}) {
    if (!room.kart?.[key]?.done) return;
    room.kart[key] = null;
    clearTimers(room, key);
    send(room, key);
  }

  // Aynı masayla yeniden: biten oyunun odada olan insan oyuncularıyla, aynı ayarlarla.
  function again(room, name, { key } = {}) {
    const g = room.kart?.[key];
    if (!g?.done || !g.humans.includes(name)) return;
    const here = new Set([...room.users.values()].map((u) => u.name));
    const players = g.players.filter((p) => (g.humans.includes(p) && here.has(p)) || p === BOT);
    start(room, key, name, players, room.lobbyOpts?.[key] || {});
  }

  function clear(code) {
    for (const key of KEYS) {
      const t = timers.get(`${code}|${key}`);
      if (!t) continue;
      clearTimeout(t.auto);
      clearTimeout(t.bot);
      clearTimeout(t.turn);
      timers.delete(`${code}|${key}`);
    }
  }

  function bind(socket, code) {
    const on = (event, fn) => socket.on(event, (arg) => {
      const c = code();
      if (!c || !arg || typeof arg !== 'object' || !KEYS.includes(arg.key)) return;
      const room = getRoom(c);
      const user = room.users.get(socket.id);
      if (user) fn(room, user.name, arg);
    });
    on('kart:act', act);
    on('kart:end', end);
    on('kart:close', close);
    on('kart:again', again);
  }

  const running = (room, key) => Boolean(room.kart?.[key] && !room.kart[key].done);
  const players = (room, key) => room.kart?.[key]?.humans || null;
  const views = (room, name) => Object.fromEntries(KEYS.map((k) => [k, viewFor(room.kart?.[k], name)]));
  // Lobi tanımları (server.js LOBBY_GAMES'e eklenir)
  const lobbyGames = (MAX) => Object.fromEntries(KEYS.map((k) => {
    const m = ENGINES[k].meta;
    return [k, { label: m.title, min: 1, max: Math.min(m.max, MAX), opts: { ...m.opts }, start: (room, by, ps, opts) => start(room, k, by, ps, opts) }];
  }));
  // Lobi ayarı: yalnız motorun izin verdiği değerler
  function lobbyOpts(lobby, game, value) {
    const spec = ENGINES[game]?.meta.optsSpec || {};
    for (const [k, allowed] of Object.entries(spec)) if (allowed.includes(value?.[k])) lobby.opts[k] = value[k];
  }

  return { KEYS, start, act, left, clear, bind, running, players, views, lobbyGames, lobbyOpts, send };
}

module.exports = { create, ENGINES, KEYS };
