#!/usr/bin/env node
// Arayüz ikon setini üretir: public/icons/ui/lucide.svg ve index.html'deki gömülü kopya (<svg id="ui-icons">).
// Kaynak: Lucide 1.77.0 sürüm paketi (github.com/lucide-icons/lucide/releases, lucide-icons-1.77.0.zip),
// açılmış "icons" klasörü. Yalnız aşağıdaki tablodaki ikonlar alınır; çizgi rengi/kalınlığı CSS'ten (.ic) gelir.
//
// Kullanım:
//   node test/tools/icons.js <lucide-icons-klasörü>
//
// Gömülü kopya ilk boyamada ikon olsun diye vardır (dosya gelene kadar boş kare görünmez);
// test/icons.test.js iki kopyanın aynı olduğunu ve kullanılan her #i-… adının sette bulunduğunu denetler.
// Bu dosya bir test değildir; `npm test` yalnız *.test.js dosyalarını çalıştırır.
const fs = require('fs');
const path = require('path');

// Bizim ad → Lucide ikonu. Başka bir set (ör. piksel tema) aynı adları kendi çizimiyle verir.
const MAP = {
  play: 'play', pause: 'pause', skip: 'skip-forward', prev: 'skip-back',
  back5: 'rotate-ccw', fwd5: 'rotate-cw',
  volume: 'volume-2', 'volume-x': 'volume-x', party: 'party-popper', settings: 'settings-2',
  mic: 'mic', 'mic-off': 'mic-off', gate: 'audio-lines', screen: 'screen-share',
  rec: 'circle-dot', stop: 'square', clip: 'paperclip',
  smile: 'face-slightly-smiling', 'smile-plus': 'face-slightly-smiling-plus',
  x: 'x', plus: 'plus', check: 'check', like: 'thumbs-up', dislike: 'thumbs-down',
  send: 'send', link: 'link', logout: 'log-out', expand: 'maximize', heart: 'heart',
  search: 'search', globe: 'globe', locate: 'navigation', minus: 'minus', shuffle: 'shuffle',
  radio: 'radio', music: 'eighth-notes', playlist: 'list-music', upload: 'upload',
  activity: 'activity', chevron: 'chevron-down', users: 'users', trophy: 'trophy',
  image: 'image', up: 'chevron-up', back: 'chevron-left', loader: 'loader-circle',
  // Aşama 2'de eklenenler
  lock: 'lock', unlock: 'lock-open', door: 'door-open', crown: 'crown', merge: 'merge',
  split: 'split', palette: 'palette', key: 'key-round', bell: 'bell', user: 'user',
  shield: 'shield', home: 'house', gamepad: 'gamepad-2', message: 'message-circle',
  list: 'list', history: 'rotate-ccw-clock', trash: 'trash', edit: 'pencil', copy: 'copy',
  info: 'info', alert: 'triangle-exclamation-point', bot: 'bot', timer: 'timer',
  undo: 'undo-2', sparkles: 'sparkles',
};

// 5 sn geri/ileri: ok çizgisinin ortasına "5" (yazı tipi düğmeden miras kalır).
const EXTRA = {
  back5: '<text x="12" y="15.5" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor" stroke="none">5</text>',
  fwd5: '<text x="12" y="15.5" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor" stroke="none">5</text>',
};

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'public', 'icons', 'ui', 'lucide.svg');
const HTML = path.join(ROOT, 'public', 'index.html');
const START = '<svg id="ui-icons"';
const END = '</svg><!-- /ui-icons -->';

function inner(file) {
  const src = fs.readFileSync(file, 'utf8');
  const body = src.slice(src.indexOf('>', src.indexOf('<svg')) + 1, src.lastIndexOf('</svg>'));
  return body.split('\n').map((l) => l.trim()).filter(Boolean).join('').replace(/\s*\/>/g, '/>');
}

function symbols(dir) {
  return Object.entries(MAP).map(([name, lucide]) =>
    `<symbol id="i-${name}" viewBox="0 0 24 24">${inner(path.join(dir, `${lucide}.svg`))}${EXTRA[name] || ''}</symbol>`);
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Kullanım: node test/tools/icons.js <lucide-icons-klasörü>');
    process.exit(1);
  }
  const syms = symbols(dir);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `<svg xmlns="http://www.w3.org/2000/svg">\n<!-- Lucide 1.77.0 (lucide.dev, ISC lisansı: LICENSE). Üretim: test/tools/icons.js -->\n${syms.join('\n')}\n</svg>\n`);

  const html = fs.readFileSync(HTML, 'utf8');
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error('index.html içinde <svg id="ui-icons"> … </svg><!-- /ui-icons --> bulunamadı');
  const block = `${START} xmlns="http://www.w3.org/2000/svg" data-set="lucide" hidden>\n${syms.map((s) => `    ${s}`).join('\n')}\n  ${END}`;
  fs.writeFileSync(HTML, html.slice(0, a) + block + html.slice(b + END.length));
  console.log(`${syms.length} ikon yazıldı: ${path.relative(ROOT, OUT)} ve public/index.html`);
}

if (require.main === module) main();
module.exports = { MAP };
