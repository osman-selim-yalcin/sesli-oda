// ---------- Ortak skor tabloları: Mantık tablosu, Hızlı okuma, Dört Taş, Duvar ----------
// Her tablonun kaydı room_state'te SHARED satırındadır (bütün odalar aynı tabloyu görür). Bilgisayardaki sunucu da
// canlıyla aynı kaydı kullandığından eklemeden önce kayıttakiyle birleştirilir. Bot tablolara girmez.
// - mantikboard: çözülen her bulmaca { at, lv, name, points, ms, wrong }; zorluk başına en iyi 10 (aynı kişi birden
//   çok kez girebilir).
// - okumaboard: kişinin her alıştırmadaki en iyisi { at, d, size?, name, score | ms, n? } (takistoskopta score geçilen
//   seviye, n aynı anda gösterilen kelime); alıştırma (sayı tablosunda
//   ayrıca boyut) başına en iyi 10 kişi. Alıştırmalar tarayıcıda oynandığı için sonuç tarayıcıdan gelir; sunucu
//   sadece akla yatkın aralıkta olanları alır.
// - duelboard: biten her Dört Taş / Duvar oyunu { at, g, p: [insanlar], w: kazanan | 'bot' | null, lv?, m }; iki kişilik
//   oyunlarda galibiyet tablosu, bilgisayara karşı oyunlarda zorluk başına galibiyet tablosu.

const SHOW = 10;
const OKUMA_DRILLS = ['yatay', 'kademeli', 'dikey', 'takisto', 'tablo'];
const OKUMA_SIZES = [3, 4, 5, 6];
const DUEL_GAMES = ['dorttas', 'duvar'];
const DUEL_LEVELS = ['kolay', 'orta', 'zor'];
const DUEL_MIN_MOVES = 4; // bundan az hamleyle biten (hemen bırakılan) oyun tabloya girmez

function sharedLog({ store, SHARED, kind, cap, key }) {
  const log = [];
  function merge(from) {
    const seen = new Set();
    const all = [...log, ...(Array.isArray(from) ? from : [])].filter((r) => {
      if (!r || typeof r !== 'object' || !Number.isFinite(r.at)) return false;
      const k = key(r);
      return !seen.has(k) && seen.add(k);
    });
    all.sort((a, b) => a.at - b.at);
    log.splice(0, log.length, ...all.slice(-cap));
  }
  async function add(recs) {
    log.push(...recs);
    if (store?.enabled) {
      try {
        const [row] = await store.select('room_state', `room=eq.${SHARED}&kind=eq.${kind}&select=data`);
        merge(row?.data);
      } catch (err) {
        console.warn(`${kind} okuma`, err.message);
      }
    }
    merge();
    store?.save(SHARED, kind, () => log);
  }
  return { log, load: merge, add };
}

function create({ io, getRoom, BOT, store, SHARED, JOINED }) {
  const mantikLog = sharedLog({ store, SHARED, kind: 'mantikboard', cap: 3000, key: (r) => `${r.at}|${r.name}` });
  const okumaLog = sharedLog({ store, SHARED, kind: 'okumaboard', cap: 3000, key: (r) => `${r.at}|${r.name}|${r.d}|${r.size || ''}|${r.score ?? r.ms}` });
  const duelLog = sharedLog({ store, SHARED, kind: 'duelboard', cap: 5000, key: (r) => `${r.g}|${r.at}|${r.p.join(',')}` });

  // ----- Mantık tablosu -----
  function mantikBoard() {
    const out = { kolay: [], zor: [] };
    for (const r of mantikLog.log) if (out[r.lv]) out[r.lv].push(r);
    for (const lv of Object.keys(out)) {
      out[lv] = out[lv].sort((a, b) => b.points - a.points || a.ms - b.ms || a.at - b.at).slice(0, SHOW)
        .map(({ name, points, ms, wrong, at }) => ({ name, points, ms, wrong, at }));
    }
    return out;
  }
  async function mantikDone(game) {
    if (!game || !['kolay', 'zor'].includes(game.level)) return;
    const recs = Object.entries(game.finished || {})
      .filter(([name]) => name !== BOT)
      .map(([name, f], i) => ({ at: (game.endedAt || Date.now()) + i, lv: game.level, name, points: f.points, ms: f.ms, wrong: f.wrong }));
    if (!recs.length) return;
    await mantikLog.add(recs);
    io.to(JOINED).emit('mantik:board', mantikBoard());
  }

  // ----- Hızlı okuma -----
  const okumaKey = (r) => (r.d === 'tablo' ? `tablo-${r.size}` : r.d);
  const better = (a, b) => (a.d === 'tablo' ? a.ms < b.ms : a.score > b.score || (a.score === b.score && (a.n || 0) > (b.n || 0))); // a, b'den iyi mi
  function okumaBests() {
    const best = new Map(); // `${tablo}|${ad}` -> kayıt
    for (const r of okumaLog.log) {
      const k = `${okumaKey(r)}|${r.name}`;
      const old = best.get(k);
      if (!old || better(r, old)) best.set(k, r);
    }
    return best;
  }
  function okumaBoard() {
    const out = {};
    for (const d of OKUMA_DRILLS) if (d !== 'tablo') out[d] = [];
    for (const s of OKUMA_SIZES) out[`tablo-${s}`] = [];
    for (const r of okumaBests().values()) out[okumaKey(r)]?.push(r);
    for (const k of Object.keys(out)) {
      out[k] = out[k].sort((a, b) => (k.startsWith('tablo') ? a.ms - b.ms : b.score - a.score || (b.n || 0) - (a.n || 0)) || a.at - b.at).slice(0, SHOW)
        .map(({ name, score, ms, n, at }) => ({ name, score, ms, n, at }));
    }
    return out;
  }
  // Tarayıcıdan gelen sonuç: { d, score } ya da { d: 'tablo', size, ms }. Kişinin o tablodaki en iyisinden iyiyse kayda girer.
  function okumaResult(name, res = {}) {
    if (!name || name === BOT || !res || !OKUMA_DRILLS.includes(res.d)) return { error: 'Geçersiz sonuç.' };
    let rec;
    if (res.d === 'tablo') {
      const { size, ms } = res;
      if (!OKUMA_SIZES.includes(size) || !Number.isInteger(ms)) return { error: 'Geçersiz sonuç.' };
      if (ms < size * size * 120 || ms > 3600000) return { error: 'Geçersiz sonuç.' }; // sayı başına 0,12 sn'den hızlısı olmaz
      rec = { at: Date.now(), d: 'tablo', size, name, ms };
    } else {
      const { score } = res;
      const max = res.d === 'takisto' ? 10 : 100000; // takistoskopta puan geçilen seviye (1-10)
      if (!Number.isInteger(score) || score <= 0 || score > max) return { error: 'Geçersiz sonuç.' };
      rec = { at: Date.now(), d: res.d, name, score };
      if (res.d === 'takisto') rec.n = Number.isInteger(res.n) && res.n >= 1 && res.n <= 5 ? res.n : 1; // aynı anda gösterilen kelime
    }
    const old = okumaBests().get(`${okumaKey(rec)}|${name}`);
    if (old && !better(rec, old)) return { ok: true, improved: false };
    okumaLog.add([rec]).then(() => io.to(JOINED).emit('okuma:board', okumaBoard()));
    return { ok: true, improved: true };
  }

  // ----- Dört Taş ve Duvar -----
  function duelBoard(g) {
    const pvp = new Map();
    const bot = Object.fromEntries(DUEL_LEVELS.map((lv) => [lv, new Map()]));
    const row = (map, name) => map.get(name) || map.set(name, { name, wins: 0, losses: 0, draws: 0, games: 0 }).get(name);
    for (const r of duelLog.log) {
      if (r.g !== g) continue;
      const map = r.lv ? bot[r.lv] : pvp;
      if (!map) continue;
      for (const name of r.p) {
        const s = row(map, name);
        s.games++;
        if (r.w === name) s.wins++;
        else if (r.w == null) s.draws++;
        else s.losses++;
      }
    }
    // Çok kazanan önce; eşitse az oyunda kazanan (oranı yüksek), sonra az kaybeden
    const top = (map) => [...map.values()].sort((a, b) => b.wins - a.wins || a.games - b.games || a.losses - b.losses || a.name.localeCompare(b.name, 'tr')).slice(0, SHOW);
    return { pvp: top(pvp), bot: Object.fromEntries(DUEL_LEVELS.map((lv) => [lv, top(bot[lv])])) };
  }
  const duelBoards = () => Object.fromEntries(DUEL_GAMES.map((g) => [g, duelBoard(g)]));
  async function duelDone(g, game) {
    if (!DUEL_GAMES.includes(g) || !game || (game.moves || 0) < DUEL_MIN_MOVES) return;
    const humans = game.players.filter((p) => p !== BOT);
    if (!humans.length) return;
    const vsBot = humans.length < game.players.length;
    const rec = { at: game.endedAt || Date.now(), g, p: humans, w: game.winner === BOT ? 'bot' : game.winner ?? null, m: game.moves };
    if (vsBot) rec.lv = DUEL_LEVELS.includes(game.level) ? game.level : 'orta';
    await duelLog.add([rec]);
    io.to(JOINED).emit(`${g}:board`, duelBoard(g));
  }

  function load(kind, data) {
    if (kind === 'mantikboard') mantikLog.load(data);
    else if (kind === 'okumaboard') okumaLog.load(data);
    else if (kind === 'duelboard') duelLog.load(data);
  }

  function bind(socket, code) {
    socket.on('okuma:result', (res, ack) => {
      const c = code();
      const user = c && getRoom(c)?.users.get(socket.id);
      const out = user ? okumaResult(user.name, res) : { error: 'Odada değilsin.' };
      if (typeof ack === 'function') ack(out);
    });
  }

  return { mantikBoard, mantikDone, okumaBoard, okumaResult, duelBoard, duelBoards, duelDone, load, bind, KINDS: ['mantikboard', 'okumaboard', 'duelboard'] };
}

module.exports = { create, OKUMA_DRILLS, OKUMA_SIZES };
