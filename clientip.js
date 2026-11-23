// Ziyaretçinin gerçek adresi (deneme sınırları ve günlük için).
// CLIENT_IP_HEADER ayarlıysa (ör. cf-connecting-ip: uygulamaya yalnız Cloudflare tünelinden ulaşılabiliyorsa)
// adres o başlıktan alınır; başlık yoksa ya da geçerli tek bir IPv4/IPv6 adresi değilse bağlantının kendi adresi
// kullanılır (X-Forwarded-For'a hiç bakılmaz: onu istemci kendisi yazabilir).
// Ayarlı değilse eski kural: Render'ın vekili adresi X-Forwarded-For'un sonuna ekler, son değer alınır
// (HTTP'de Express'in 'trust proxy' 1 ayarıyla req.ip, sokette aynı kural elle).
const net = require('net');

function makeClientIp(header) {
  const name = String(header || '').trim().toLowerCase();
  return function clientIp(x) {
    const socket = x.handshake; // socket.io soketi mi, Express isteği mi
    const headers = socket ? socket.headers : x.headers;
    if (name) {
      const v = headers?.[name];
      const ip = typeof v === 'string' ? v.trim() : '';
      if (net.isIP(ip)) return ip;
      return socket ? socket.address : x.socket?.remoteAddress;
    }
    if (!socket) return x.ip;
    const forwarded = headers?.['x-forwarded-for'];
    const last = typeof forwarded === 'string' ? forwarded.split(',').pop().trim() : '';
    return last || socket.address;
  };
}

// Ortam değişkeni açılışta bir kez okunur.
const HEADER = String(process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
const clientIp = makeClientIp(HEADER);

module.exports = { clientIp, makeClientIp, HEADER };
