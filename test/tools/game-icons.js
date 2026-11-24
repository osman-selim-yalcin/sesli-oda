#!/usr/bin/env node
// Oyun simgeleri: public/icons/games.svg ve index.html'deki gömülü kopya (<svg id="game-icons">) buradan üretilir.
// Simgeler bu dosyada elle çizilmiştir (48×48 ızgara, dış boşluk ~6 birim); başka bir setten alınmadı.
//
// Boya: her simge en çok üç boya kullanır, hepsi CSS değişkeninden (css/games.css .gi verir):
//   mürekkep (--gi-ink: temanın yazı rengi), oyunun tonu (--gi-tint) ve tonun yumuşak dolgusu (--gi-soft).
// Kaynakta öğeye p="…" yazılır, üretici onu style'a çevirir:
//   (yok) mürekkep çizgi   if  mürekkep çizgi + yumuşak dolgu   I  mürekkep dolgu
//   t     ton çizgi        tf  ton çizgi + yumuşak dolgu        T  ton dolgu        F  yalnız yumuşak dolgu
// Çizgi kalınlığı (--gi-sw), uç ve köşe biçimi (--game-cap, --game-join) sembolün dış <g>'sinde değişkenden okunur;
// değişken yoksa (dosya tek başına açılınca) 3 birim, yuvarlak uç/köşe ve currentColor.
// Köşe yuvarlaklığı: dikdörtgenlerin rx'i --game-corner ile çarpılır (Piksel Oda'da 0: köşeli).
//
// Kullanım: node test/tools/game-icons.js   (dosyayı ve gömülü kopyayı yeniden yazar)
// test/icons.test.js iki kopyanın aynı olduğunu ve GAME_INFO anahtarlarıyla sembollerin birebir eşleştiğini denetler.
const fs = require('fs');
const path = require('path');

const ICONS = {
  // Sayı bulmaca: rakam taşı ve +/- ipuçları
  sayi: `
    <rect p="if" x="6" y="8" width="21" height="32" rx="6"/>
    <path d="M12 17h9.5l-6 14"/>
    <path p="t" d="M37 10.5v10M32 15.5h10M32 32.5h10"/>`,
  yorunge: `
    <path p="tf" d="m24 4 16 10v19L24 44 8 33V14Z"/>
    <ellipse cx="24" cy="24" rx="17" ry="6" transform="rotate(-30 24 24)"/>
    <circle p="T" cx="24" cy="24" r="5"/>`,
  // Gizli kural: büyüyen dizi ve sıradaki "?"
  kural: `
    <circle p="I" cx="8.5" cy="39" r="3.5"/>
    <circle p="I" cx="17.5" cy="32" r="4.5"/>
    <circle p="tf" cx="31" cy="17.5" r="12"/>
    <path p="t" d="M27.3 13.3A4 4 0 1 1 33.2 16.8C32 17.4 31.2 18.4 31.2 19.9V20.6"/>
    <path p="t" d="M31.2 25.4v.01"/>`,
  // Hedef sayı: hedef tahtası ve işlem rozeti
  hedef: `
    <circle p="if" cx="21" cy="21" r="14.5"/>
    <circle p="t" cx="21" cy="21" r="7"/>
    <circle p="T" cx="21" cy="21" r="2.5"/>
    <rect p="if" x="27.5" y="27.5" width="15" height="15" rx="4.5"/>
    <path d="M35 31v8M31 35h8"/>`,
  // Mantık tablosu: 3×3 ızgara, tik ve çarpılar
  mantik: `
    <rect p="F" x="6.5" y="6.5" width="10" height="10" rx="2.5"/>
    <rect p="F" x="19" y="6.5" width="10" height="10" rx="2.5"/>
    <rect p="F" x="31.5" y="6.5" width="10" height="10" rx="2.5"/>
    <rect p="F" x="6.5" y="19" width="10" height="10" rx="2.5"/>
    <rect p="F" x="19" y="19" width="10" height="10" rx="2.5"/>
    <rect p="F" x="31.5" y="19" width="10" height="10" rx="2.5"/>
    <rect p="F" x="6.5" y="31.5" width="10" height="10" rx="2.5"/>
    <rect p="F" x="19" y="31.5" width="10" height="10" rx="2.5"/>
    <rect p="F" x="31.5" y="31.5" width="10" height="10" rx="2.5"/>
    <path p="t" d="M8.8 11.8l2.2 2.2 3.4-4M33.8 24.3l2.2 2.2 3.4-4M21.3 36.8l2.2 2.2 3.4-4"/>
    <path d="M34.5 9.5l4 4m0-4l-4 4M9.5 22l4 4m0-4l-4 4M34.5 34.5l4 4m0-4l-4 4"/>`,
  // Kaydırmaca: büyük kare ve küçük bloklar
  klotski: `
    <rect p="tf" x="7" y="7" width="20" height="20" rx="5"/>
    <rect x="33" y="7" width="8" height="20" rx="3"/>
    <rect x="7" y="33" width="20" height="8" rx="3"/>
    <rect x="33" y="33" width="8" height="8" rx="3"/>`,
  // Eşini bul: biri kapalı, biri açık iki kart
  memory: `
    <rect p="if" x="6" y="11" width="16" height="24" rx="4" transform="rotate(-9 14 23)"/>
    <rect x="26" y="13" width="16" height="24" rx="4" transform="rotate(7 34 25)"/>
    <path p="T" d="M34 19.5l4.5 5.5-4.5 5.5-4.5-5.5z" transform="rotate(7 34 25)"/>`,
  // Süre tahmini: kronometre
  timing: `
    <circle p="if" cx="24" cy="27" r="14.5"/>
    <path d="M20 6h8M24 6v6.5M35.5 15.5l2.5-2.5"/>
    <path p="t" d="M24 27v-8.5"/>
    <circle p="T" cx="24" cy="27" r="2.75"/>`,
  // Daktilo: klavye
  daktilo: `
    <rect p="if" x="5" y="12" width="38" height="25" rx="5"/>
    <path d="M11.5 19h.01M18 19h.01M24 19h.01M30 19h.01M36.5 19h.01M14.5 25h.01M21 25h.01M27 25h.01M33.5 25h.01"/>
    <path p="t" d="M17 31h14"/>`,
  // Hızlı okuma: açık kitap, satırlar
  okuma: `
    <path p="if" d="M24 14.5c-5-3.5-11-4.5-18-4v25c7-.5 13 .5 18 4c5-3.5 11-4.5 18-4v-25c-7-.5-13 .5-18 4z"/>
    <path d="M24 14.5v25"/>
    <path p="t" d="M11 18.5h7.5M11 24.5h7.5M29.5 18.5h7.5M29.5 24.5h7.5M29.5 30.5h4.5"/>`,
  // Dinozor koşusu: uzun boyunlu dinozor ve yer çizgisi
  dino: `
    <path p="if" d="M37 6H40C42.2 6 44 7.8 44 10C44 12.2 42.2 14 40 14H37.5C36.5 17 36 20 36 24C36 27.5 34.8 30.5 32.5 32.5V39H27.5V34.5H19.5V39H14.5V32.5C10 30.5 6.5 27 4 22C8.5 24.5 12.5 24.5 16 22.5C20 20.3 24 19.5 27.5 20.5C29 15 30 10 31.5 8.5C32.5 7 34.5 6 37 6Z"/>
    <circle p="I" cx="39.5" cy="10" r="1.6"/>
    <path p="t" d="M5 43.5h6M16 43.5h27"/>`,
  // Tavus kuşu: yelpaze kuyruk
  peacock: `
    <path p="F" d="M24 37L8.4 28.4A18 18 0 0 1 39.6 28.4z"/>
    <path d="M24 37V21.5M24 37L15.2 22.8M24 37l8.8-14.2M24 37L10.6 29.3M24 37l13.4-7.7"/>
    <circle p="tf" cx="24" cy="17" r="4"/>
    <circle p="tf" cx="12.9" cy="20.1" r="4"/>
    <circle p="tf" cx="35.1" cy="20.1" r="4"/>
    <circle p="tf" cx="7.6" cy="29.4" r="3.5"/>
    <circle p="tf" cx="40.4" cy="29.4" r="3.5"/>
    <path p="I" d="M24 33.5c2.8 0 4.5 2.4 4.5 5.2c0 2.6-2 4.3-4.5 4.3s-4.5-1.7-4.5-4.3c0-2.8 1.7-5.2 4.5-5.2z"/>`,
  // Kelime: konuşma balonu ve harf taşları
  kelime: `
    <path p="if" d="M12 7h24a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H20l-8 7v-7.2A6 6 0 0 1 6 27V13a6 6 0 0 1 6-6z"/>
    <rect p="T" x="12" y="15.5" width="7" height="9" rx="2"/>
    <rect p="T" x="20.5" y="15.5" width="7" height="9" rx="2"/>
    <rect p="T" x="29" y="15.5" width="7" height="9" rx="2"/>`,
  // Tier list: etiketli üç sıra
  tier: `
    <rect p="F" x="6" y="6.5" width="36" height="10" rx="3"/>
    <rect p="F" x="6" y="19" width="36" height="10" rx="3"/>
    <rect p="F" x="6" y="31.5" width="36" height="10" rx="3"/>
    <rect p="T" x="6" y="6.5" width="10" height="10" rx="3"/>
    <rect p="T" x="6" y="19" width="10" height="10" rx="3"/>
    <rect p="T" x="6" y="31.5" width="10" height="10" rx="3"/>
    <path d="M21.5 11.5h.01M28 11.5h.01M34.5 11.5h.01M21.5 24h.01M28 24h.01M21.5 36.5h.01"/>`,
  // Oyun öner: ampul ve artı
  oner: `
    <path p="if" d="M18.5 34c0-3.2-1.4-4.8-3.4-6.8A12.5 12.5 0 1 1 32.9 27.2c-2 2-3.4 3.6-3.4 6.8z"/>
    <path d="M19 38.5h10M21 42.5h6"/>
    <path p="t" d="M24 13.5v10M19 18.5h10"/>`,
};

const PAINT = {
  '': '',
  if: 'fill:var(--gi-soft,none)',
  I: 'fill:var(--gi-ink,currentColor);stroke:none',
  t: 'stroke:var(--gi-tint,currentColor)',
  tf: 'stroke:var(--gi-tint,currentColor);fill:var(--gi-soft,none)',
  T: 'fill:var(--gi-tint,currentColor);stroke:none',
  F: 'fill:var(--gi-soft,none);stroke:none',
};
const G = '<g style="fill:none;stroke:var(--gi-ink,currentColor);stroke-width:var(--gi-sw,3);stroke-linecap:var(--game-cap,round);stroke-linejoin:var(--game-join,round);stroke-miterlimit:2">';

function element(src) {
  return src.replace(/<(\w+)((?:\s+[\w-]+="[^"]*")*)\s*\/>/g, (all, tag, attrs) => {
    let p = '';
    let rx = null;
    const rest = [];
    for (const [, k, v] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (k === 'p') p = v;
      else {
        if (k === 'rx' && tag === 'rect') rx = v;
        rest.push(`${k}="${v}"`);
      }
    }
    if (!(p in PAINT)) throw new Error(`bilinmeyen boya: ${p}`);
    const style = [PAINT[p], rx ? `rx:calc(${rx}px*var(--game-corner,1))` : ''].filter(Boolean).join(';');
    return `<${tag} ${rest.join(' ')}${style ? ` style="${style}"` : ''}/>`;
  });
}

function symbol(key) {
  const body = ICONS[key].trim().split('\n').map((l) => element(l.trim())).join('');
  return `<symbol id="g-${key}" viewBox="0 0 48 48">${G}${body}</g></symbol>`;
}

function sprite() {
  return Object.keys(ICONS).map(symbol);
}

const HEAD = '<!-- Oyun simgeleri: test/tools/game-icons.js üretir; elle çizildi, renk CSS değişkenlerinden (css/games.css .gi) -->';

if (require.main === module) {
  const ROOT = path.join(__dirname, '..', '..');
  const symbols = sprite();
  fs.writeFileSync(path.join(ROOT, 'public/icons/games.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg">\n${HEAD}\n${symbols.join('\n')}\n</svg>\n`);
  const file = path.join(ROOT, 'public/index.html');
  const html = fs.readFileSync(file, 'utf8');
  const block = `<svg id="game-icons" xmlns="http://www.w3.org/2000/svg" hidden>\n${symbols.map((s) => `    ${s}`).join('\n')}\n  </svg><!-- /game-icons -->`;
  const re = /<svg id="game-icons"[\s\S]*?<\/svg><!-- \/game-icons -->/;
  if (re.test(html)) fs.writeFileSync(file, html.replace(re, block));
  else console.warn('index.html içinde <svg id="game-icons"> yok; yalnız games.svg yazıldı');
  console.log(`${symbols.length} simge yazıldı`);
}

module.exports = { ICONS, sprite };
