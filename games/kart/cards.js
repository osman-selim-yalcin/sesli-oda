// ---------- Kağıt oyunları: ortak deste ve yardımcılar ----------
// Kart dizgesi: rank + suit. Rank 2..14 (11 J, 12 Q, 13 K, 14 A); suit S (maça), H (kupa), D (karo), C (sinek).
// Kartlar sunucudan istemciye { r, s } nesnesi olarak gider; gizli kart null'dır.

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const card = (r, s) => ({ r, s });
const deck = (n = 1) => {
  const out = [];
  for (let k = 0; k < n; k++) for (const s of SUITS) for (const r of RANKS) out.push(card(r, s));
  return out;
};
function shuffle(arr, rnd = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const same = (a, b) => a && b && a.r === b.r && a.s === b.s;
const RANK_NAME = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const label = (c) => `${RANK_NAME[c.r] || c.r}${SUIT_SYM[c.s]}`;

// Oturma sırası: lobideki oyuncular (odanın botu dahil) eksikse "Bilgisayar 1", "Bilgisayar 2"… ile tamamlanır.
const BOT_PREFIX = 'Bilgisayar ';
function seatPlayers(players, max, fill) {
  const seats = players.slice(0, max);
  for (let k = 1; seats.length < Math.min(fill, max); k++) if (!seats.includes(BOT_PREFIX + k)) seats.push(BOT_PREFIX + k);
  return seats;
}

// ---------- Poker el değeri ----------
// 5-7 karttan en iyi 5'li el: [kategori, ...eşitlik bozucular]. Kategori 8 floş düz, 7 kare, 6 ful, 5 floş, 4 düz,
// 3 üçlü, 2 iki çift, 1 çift, 0 yüksek kart. Diziler soldan sağa karşılaştırılır.
const HAND_NAME = ['Yüksek kart', 'Bir çift', 'İki çift', 'Üçlü', 'Kent', 'Floş', 'Ful', 'Kare', 'Floş kent'];

function straightHigh(ranks) {
  const set = new Set(ranks);
  if (set.has(14)) set.add(1);
  for (let hi = 14; hi >= 5; hi--) {
    let ok = true;
    for (let k = 0; k < 5; k++) if (!set.has(hi - k)) { ok = false; break; }
    if (ok) return hi;
  }
  return 0;
}

function evaluate(cards) {
  const bySuit = {};
  for (const c of cards) (bySuit[c.s] ||= []).push(c.r);
  for (const s of Object.keys(bySuit)) {
    if (bySuit[s].length >= 5) {
      const sf = straightHigh(bySuit[s]);
      if (sf) return [8, sf];
    }
  }
  const count = {};
  for (const c of cards) count[c.r] = (count[c.r] || 0) + 1;
  const groups = Object.entries(count).map(([r, n]) => [Number(r), n]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ranksDesc = [...new Set(cards.map((c) => c.r))].sort((a, b) => b - a);
  const kick = (excl, n) => ranksDesc.filter((r) => !excl.includes(r)).slice(0, n);
  if (groups[0][1] === 4) return [7, groups[0][0], ...kick([groups[0][0]], 1)];
  if (groups[0][1] === 3 && groups[1]?.[1] >= 2) return [6, groups[0][0], groups[1][0]];
  for (const s of Object.keys(bySuit)) if (bySuit[s].length >= 5) return [5, ...bySuit[s].sort((a, b) => b - a).slice(0, 5)];
  const st = straightHigh(ranksDesc);
  if (st) return [4, st];
  if (groups[0][1] === 3) return [3, groups[0][0], ...kick([groups[0][0]], 2)];
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) return [2, groups[0][0], groups[1][0], ...kick([groups[0][0], groups[1][0]], 1)];
  if (groups[0][1] === 2) return [1, groups[0][0], ...kick([groups[0][0]], 3)];
  return [0, ...ranksDesc.slice(0, 5)];
}
function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

module.exports = { SUITS, RANKS, card, deck, shuffle, same, label, SUIT_SYM, BOT_PREFIX, seatPlayers, evaluate, compare, HAND_NAME, straightHigh };
