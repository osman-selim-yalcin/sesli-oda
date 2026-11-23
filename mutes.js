// Moderatör susturması: saf durum ve yetki kuralı (soket bilmez; server.js bağlar).
// Susturma kişinin köken odasına (birleşik odada misafir odanın id'si) ve hesabına bağlıdır: odadan çıkıp
// dönen yine susturulmuştur, birleşme ve ayrılmada kişiyle birlikte gider. Odanın canlı durumu silinince
// (oda boşaldı ya da kapandı) server.js clear(oda) çağırır. Yalnız hafızadadır.
const state = new Map(); // köken oda id -> Map<hesap anahtarı, { by: 'owner' | 'admin', name }>

const get = (room, key) => state.get(room)?.get(key) || null;

function set(room, key, info) {
  if (!state.has(room)) state.set(room, new Map());
  state.get(room).set(key, { by: info.by, name: info.name });
}

function remove(room, key) {
  const m = state.get(room);
  if (!m) return;
  m.delete(key);
  if (!m.size) state.delete(room);
}

const clear = (room) => state.delete(room);
const size = () => state.size; // test için

// Kim kimi susturabilir (ya da susturmasını kaldırabilir). Hata metni ya da null döner.
// actor: { key, admin, ownsOrigin } (ownsOrigin: hedefin köken odasının sahibi mi)
// target: { key, admin }; existing: hedefin şu anki susturması (yoksa null); mute: true sustur, false kaldır.
function check({ actor, target, existing, mute }) {
  if (actor.key === target.key) return 'Kendini buradan susturamazsın; mikrofon düğmesini kullan.';
  if (actor.admin) return null; // site yöneticisi herkesi, her odada
  if (!actor.ownsOrigin) return 'Bu kişiyi yalnız kendi odasının sahibi ya da yönetici susturabilir.';
  if (target.admin) return 'Yöneticiyi susturamazsın.';
  // Yöneticinin susturmasını sahip kaldıramaz, üstüne kendi susturmasını da yazamaz (sonra kaldırabilirdi).
  if (existing?.by === 'admin') return 'Bu susturmayı yönetici koydu; yalnız yönetici kaldırabilir.';
  return null;
}

module.exports = { get, set, remove, clear, size, check };
