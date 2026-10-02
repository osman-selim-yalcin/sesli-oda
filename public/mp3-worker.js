// Kaydı canlı olarak MP3'e çevirir (lamejs, LGPL). Ayrı iş parçacığında çalışır,
// böylece uzun kayıtlarda sayfa takılmaz ve kayıt bitince dosya hemen hazır olur.

importScripts('vendor/lame.min.js');

let encoder = null;
let parts = [];

// lamejs 16 bit tamsayı örnek ister.
function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

onmessage = ({ data }) => {
  if (data.type === 'start') {
    encoder = new lamejs.Mp3Encoder(2, data.sampleRate, data.kbps);
    parts = [];
  } else if (data.type === 'pcm') {
    const buf = encoder.encodeBuffer(toInt16(data.left), toInt16(data.right));
    if (buf.length) parts.push(new Uint8Array(buf));
  } else if (data.type === 'end') {
    const buf = encoder.flush();
    if (buf.length) parts.push(new Uint8Array(buf));
    postMessage(new Blob(parts, { type: 'audio/mpeg' }));
    encoder = null;
    parts = [];
  }
};
