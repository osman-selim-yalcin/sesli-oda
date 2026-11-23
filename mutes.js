// Moderatör susturması: saf durum ve yetki kuralı (soket bilmez; server.js bağlar). Model:
// - Köken: kişinin girdiği kapının odası (birleşik odada da). Odalar arasında kayıt kopyalanmaz.
// - Sahip susturması odaya bağlı: (oda, hesap) kaydı; yalnız kökeni o oda olan kişiye uygulanır. Birleşik odada
//   kapı değiştiren kişiye eski odanın sahip susturması uygulanmaz; girdiği kapının sahibi ya da yönetici susturur.
// - Yönetici susturması hesaba bağlı, site geneli: her odada, her kapıdan, birleşmede ve sonrasında geçerli;
//   yalnız yönetici kaldırır (ya da sunucu yeniden başlar: hafızada). Yalnız yönetici eklediği için sınırlıdır.
// - Etkin susturma: hesabın yönetici kaydı, yoksa kökenin sahip kaydı, yoksa yok.
// - Yönetici herkesi susturur ve kaldırır (kaldırma hesabın her odadaki sahip kaydını da siler). Sahip kökeni kendi odası olanı
//   (yönetici ve yöneticinin susturduğu hariç) susturur ve sahip kaydını kaldırır. Kimse kendini susturamaz.
// - Sahip kayıtları oda kapanınca ya da o kökenden canlı odalarda ve yenileme payında kimse kalmayınca silinir.
const owners = new Map(); // oda id -> Map<hesap anahtarı, { by: 'owner', name }>
const admins = new Map(); // hesap anahtarı -> { by: 'admin', name }

const getOwner = (room, key) => owners.get(room)?.get(key) || null;
const getAdmin = (key) => admins.get(key) || null;
// Kişinin etkin susturması: yönetici kaydı, yoksa kökeninin sahip kaydı.
const effective = (room, key) => getAdmin(key) || getOwner(room, key);

function setOwner(room, key, name) {
  if (!owners.has(room)) owners.set(room, new Map());
  owners.get(room).set(key, { by: 'owner', name });
}
function removeOwner(room, key) {
  const m = owners.get(room);
  if (!m) return;
  m.delete(key);
  if (!m.size) owners.delete(room);
}
function removeOwnerEverywhere(key) {
  for (const room of [...owners.keys()]) removeOwner(room, key);
}
const clearRoom = (room) => owners.delete(room); // yalnız sahip kayıtları; yönetici kayıtları odaya bağlı değil

const setAdmin = (key, name) => admins.set(key, { by: 'admin', name });
const removeAdmin = (key) => admins.delete(key);

// Kim kimi susturabilir ya da kaldırabilir. Hata metni ya da null döner.
// actor: { key, admin, ownsOrigin } (ownsOrigin: hedefin köken odasının sahibi mi); target: { key, admin };
// existing: hedefin etkin susturması (yoksa null).
function check({ actor, target, existing }) {
  if (actor.key === target.key) return 'Kendini buradan susturamazsın; mikrofon düğmesini kullan.';
  if (actor.admin) return null; // site yöneticisi herkesi, her odada
  if (!actor.ownsOrigin) return 'Bu kişiyi yalnız kendi odasının sahibi ya da yönetici susturabilir.';
  if (target.admin) return 'Yöneticiyi susturamazsın.';
  if (existing?.by === 'admin') return 'Bu kişiyi yönetici susturdu; yalnız yönetici kaldırabilir.';
  return null;
}

module.exports = { getOwner, getAdmin, effective, setOwner, removeOwner, removeOwnerEverywhere, clearRoom, setAdmin, removeAdmin, check };
