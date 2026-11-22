// Oda birleştirme: saf durum makinesi (soket, zamanlayıcı bilmez; sunucu bağlar).
// İsteği gönderen oda ev sahibi (host), kabul eden oda misafir (guest) olur. Birleşme yalnız hafızadadır.
const REQUEST_TTL = 60 * 1000; // ms; cevaplanmayan istek bu kadar sonra düşer

const requests = new Map(); // istek id -> { id, from, to, by, at }
const pairs = new Map();    // oda id -> { host, guest } (iki oda da aynı nesneyi gösterir)
let nextId = 1;

// Oda misafirse ev sahibinin id'si, değilse kendisi.
const hostOf = (roomId) => pairs.get(roomId)?.host || roomId;

function partnerOf(roomId) {
  const pair = pairs.get(roomId);
  if (!pair) return null;
  return pair.host === roomId ? pair.guest : pair.host;
}

const samePair = (q, a, b) => (q.from === a && q.to === b) || (q.from === b && q.to === a);
const live = (q, now) => now - q.at < REQUEST_TTL;

// Bekleyen (süresi dolmamış) istek ya da undefined.
function pending(id, now = Date.now()) {
  const q = requests.get(id);
  return q && live(q, now) ? q : undefined;
}

function propose(fromId, toId, by, now = Date.now()) {
  if (fromId === toId) return { error: 'Oda kendisiyle birleşemez.' };
  if (pairs.has(fromId) || pairs.has(toId)) return { error: 'Birleşik bir oda başka bir odayla birleşemez.' };
  for (const q of requests.values()) {
    if (live(q, now) && samePair(q, fromId, toId)) return { error: 'Bu iki oda arasında bekleyen bir istek var.' };
  }
  const id = String(nextId++);
  requests.set(id, { id, from: fromId, to: toId, by, at: now });
  return { id };
}

// Kabulde { host, guest }, retde null; istek yoksa, süresi dolduysa ya da taraflardan biri bu arada
// başka odayla birleştiyse { error }. Cevaplanan istek silinir (ikinci cevap hata alır).
function answer(id, accept, now = Date.now()) {
  const q = pending(id, now);
  if (!q) return { error: 'Birleşme isteği bulunamadı ya da süresi doldu.' };
  requests.delete(id);
  if (!accept) return null;
  if (pairs.has(q.from) || pairs.has(q.to)) return { error: 'Birleşik bir oda başka bir odayla birleşemez.' };
  const pair = { host: q.from, guest: q.to };
  pairs.set(pair.host, pair);
  pairs.set(pair.guest, pair);
  // İki odadan birini içeren öteki istekler artık geçersiz.
  for (const [rid, other] of requests) {
    if ([other.from, other.to].some((r) => r === pair.host || r === pair.guest)) requests.delete(rid);
  }
  return { ...pair };
}

// Birleşmeyi bitirir; birleşik değilse null.
function split(roomId) {
  const pair = pairs.get(roomId);
  if (!pair) return null;
  pairs.delete(pair.host);
  pairs.delete(pair.guest);
  return { ...pair };
}

// Odayı içeren bekleyen istekleri siler (oda kapandı).
function forget(roomId) {
  for (const [id, q] of requests) if (q.from === roomId || q.to === roomId) requests.delete(id);
}

// Süresi dolan istekleri düşürür; düşenleri döner.
function expire(now = Date.now()) {
  const dropped = [];
  for (const [id, q] of requests) {
    if (live(q, now)) continue;
    requests.delete(id);
    dropped.push(q);
  }
  return dropped;
}

module.exports = { REQUEST_TTL, hostOf, partnerOf, pending, propose, answer, split, forget, expire };
