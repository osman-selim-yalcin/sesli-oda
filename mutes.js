// Moderatör susturması: saf durum ve yetki kuralı (soket bilmez; server.js bağlar). Model:
// - Köken: kişinin girdiği kapının odası (birleşik odada da; ayrılınca o odada kalır). Hiçbir şey kökeni değiştirmez.
// - Kayıt: oda id + hesap anahtarı -> { by: 'owner' | 'admin', name }. Etkin susturma = kişinin kökeninin kaydı, başka bir şey değil.
// - Taşıma: birleşik odaya join ile başarıyla girerken çiftin öteki odasındaki kayıt kapının odasına bir kez kopyalanır
//   (kapıda kayıt yoksa; ya da kapıdaki sahip kaydını öteki odanın yönetici kaydı geçer). Birleşme, kapı ve hesap
//   başına bir kez: kaldırılan susturma yenilemede geri gelmez. Birleşme anındaki taşınmada kopyalama yok.
// - Kim: yönetici herkesi susturur ve kaldırır; oda sahibi kökeni kendi odası olanı (yönetici hariç) susturur ve
//   sahip kaydını kaldırır, yönetici kaydına dokunamaz; kimse kendini (kendi sessizi mikrofon düğmesi).
// - Silinme: oda kapanınca; odanın canlı durumu silinince, birleşme bitince ya da gerçek çıkışta o kökenden odada
//   ya da yenileme payında kimse kalmadıysa. Öteki odadaki asıl kayıt kendi kurallarıyla durur. Yalnız hafızadadır.
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

// Bu birleşmede kapının odasına taşınmış kayıtlar: "oda id\nhesap" (birleşme bitince ya da kayıt silinince unutulur).
const imports = new Set();
const ik = (room, key) => `${room}\n${key}`;
const imported = (room, key) => imports.has(ik(room, key));
const markImported = (room, key) => imports.add(ik(room, key));
function forgetImports(...rooms) {
  for (const x of [...imports]) if (rooms.includes(x.slice(0, x.indexOf('\n')))) imports.delete(x);
}

function clear(room) {
  state.delete(room);
  forgetImports(room);
}
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

module.exports = { get, set, remove, clear, size, check, imported, markImported, forgetImports };
