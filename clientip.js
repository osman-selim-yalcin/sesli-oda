// Ziyaretçinin gerçek adresi (deneme sınırları ve günlük için).
// CLIENT_IP_HEADER ayarlıysa (ör. cf-connecting-ip: uygulamaya yalnız Cloudflare tünelinden ulaşılabiliyorsa)
// adres o başlıktan alınır; başlık yoksa ya da geçerli tek bir IPv4/IPv6 adresi değilse bağlantının kendi adresi
// kullanılır (X-Forwarded-For'a hiç bakılmaz: onu istemci kendisi yazabilir) ve yanlış ayar görülsün diye uyarı
// yazılır. Ayarlı değilse eski kural: Render'ın vekili adresi X-Forwarded-For'un sonuna ekler, son değer alınır
// (HTTP'de Express'in 'trust proxy' 1 ayarıyla req.ip, sokette aynı kural elle).
const net = require('net');

const WARN_EVERY = 10 * 60 * 1000; // başlık eksik uyarısı en fazla bu sıklıkta

function makeClientIp(header, { warn = console.warn, now = Date.now } = {}) {
  const name = String(header || '').trim().toLowerCase();
  let warnedAt = null;
  return function clientIp(x) {
    const socket = x.handshake; // socket.io soketi mi, Express isteği mi
    const headers = socket ? socket.headers : x.headers;
    if (name) {
      const v = headers?.[name];
      const ip = typeof v === 'string' ? v.trim() : '';
      if (net.isIP(ip) && !ip.includes('%')) return ip; // bölge kimlikli (fe80::1%eth0) adres kabul edilmez
      if (warnedAt === null || now() - warnedAt >= WARN_EVERY) {
        warnedAt = now();
        warn(`Uyarı: CLIENT_IP_HEADER (${name}) istekte yok ya da geçersiz; bağlantı adresi kullanılıyor. `
          + 'Uygulamaya vekil dışından ulaşılıyor olabilir.');
      }
      return socket ? socket.address : x.socket?.remoteAddress;
    }
    if (!socket) return x.ip;
    const forwarded = headers?.['x-forwarded-for'];
    const last = typeof forwarded === 'string' ? forwarded.split(',').pop().trim() : '';
    return last || socket.address;
  };
}

// IPv6 adresini 8 sayıya açar (gömülü IPv4 sonu dahil); geçersizse null.
function ipv6Groups(ip) {
  let s = ip;
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const b = tail[1].split('.').map(Number);
    s = s.slice(0, -tail[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const part = (p) => (p ? p.split(':') : []);
  const a = part(head);
  const b = rest === undefined ? [] : part(rest);
  const fill = rest === undefined ? 0 : 8 - a.length - b.length;
  const groups = [...a, ...Array(fill).fill('0'), ...b].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

// Deneme sınırlarının anahtarı: IPv4 olduğu gibi; IPv6'nın /64 öneki (bir ev ya da sunucu kendi /64'ü içinde
// adresini istediği gibi değiştirebilir); IPv4-mapped IPv6 (::ffff:a.b.c.d) IPv4'e çevrilir.
function limiterKey(ip) {
  if (typeof ip !== 'string' || !ip) return 'bilinmiyor';
  const addr = ip.split('%')[0]; // bağlantı adresindeki bölge kimliği (fe80::1%lo0)
  if (net.isIPv4(addr)) return addr;
  if (!net.isIPv6(addr)) return addr;
  const g = ipv6Groups(addr.toLowerCase());
  if (!g) return addr;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

// Ortam değişkeni açılışta bir kez okunur.
const HEADER = String(process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
const clientIp = makeClientIp(HEADER);
// Deneme sınırları bunu kullanır; clientIp tam adresi verir (başka kullanım için).
const clientKey = (x) => limiterKey(clientIp(x));

module.exports = { clientIp, clientKey, makeClientIp, limiterKey, HEADER };
