#!/usr/bin/env node
// Kış Odası: boş oynatıcıdaki kartopu sahnesi. İki chibi çocuk sırayla birbirine kartopu atar (5 saniyelik döngü):
// sol eğilip atar, top yay çizerek uçar, sağdakinin yüzüne çarpar (geri savrulur, gözlerini kısar, yüzünde kar
// dağılır); sonra sıra sağdakindedir. Arada yavaş kar yağar. Çizimler bu dosyada elle yapılmıştır.
//
// Çıktı:
//   public/themes/kis/kartopu.svg         canlı sahne (CSS animasyonu SVG'nin içinde; zemin resmi olarak da oynar)
//   public/themes/kis/kartopu-durgun.svg  aynı sahne hareketsiz (hareketi azalt ayarı)
//   public/themes/kis/sarkit.svg          buz sarkıtları şeridi (yatayda kendini tekrarlar; üst çubuk ve sohbet sekmeleri)
// Zemin (karlı tepeler), boyalı kardan adam ve bulutlar kis.css'te ayrı katmandır; bu sahne şeffaf zeminlidir.
//
// Kullanım: node test/tools/kis-scene.js
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '../../public/themes/kis');
const W = 640;
const H = 360;
const GROUND = 318; // ayakların bastığı çizgi

// Çocuklar: dünya konumu, yön (sağdaki aynalanır), renkler
const KIDS = [
  { id: 'l', x: 150, flip: false, coat: '#5FA8B8', coatDark: '#447F8F', hat: '#C8404F', hatDark: '#9E2E3C', band: '#F1E3D3', scarf: '#E9B949', scarfDark: '#C4932B', hair: '#6B4430' },
  { id: 'r', x: 490, flip: true, coat: '#B79FD6', coatDark: '#8E77B0', hat: '#E6A93C', hatDark: '#B9802A', band: '#F7EEDF', scarf: '#D95B6C', scarfDark: '#AE4252', hair: '#3E2C24' },
];

const SHOULDER = [12, -40]; // atan kolun omzu (çocuğun kendi koordinatında, yüzü +x yönüne)
const ARM = 26;             // omuzdan eldivenin ortasına
const FACE = [12, -76];     // topun çarptığı yer

// Çocuğun kendi koordinatındaki bir noktayı dünyaya çevirir.
const world = (kid, [x, y]) => [kid.x + (kid.flip ? -x : x), GROUND + y];
// Atış anında kol açısı (derece; SVG'de artı açı eli geriye götürür)
const THROW_DEG = -120;
const hand = (kid) => {
  const a = (THROW_DEG * Math.PI) / 180;
  return world(kid, [SHOULDER[0] - Math.sin(a) * ARM, SHOULDER[1] + Math.cos(a) * ARM]);
};

function kid(k) {
  const tr = `translate(${k.x} ${GROUND})${k.flip ? ' scale(-1 1)' : ''}`;
  return `
  <g transform="${tr}">
    <ellipse cx="0" cy="2" rx="30" ry="5.5" fill="#040A12" opacity=".32"/>
    <g class="body-${k.id}">
      <g class="bob">
        <ellipse cx="-10" cy="-5" rx="10" ry="6.5" fill="#5A3E2E"/>
        <ellipse cx="11" cy="-5" rx="10" ry="6.5" fill="#6B4A37"/>
        <path d="M-12 -40 q-9 4 -10 18 q-1 5 4 6" stroke="${k.coatDark}" stroke-width="9" stroke-linecap="round" fill="none"/>
        <circle cx="-17" cy="-15" r="6.5" fill="${k.hatDark}"/>
        <path d="M-22 -8 Q-25 -44 0 -50 Q25 -44 22 -8 Q0 -1 -22 -8z" fill="${k.coat}"/>
        <path d="M-22 -8 Q-25 -44 -4 -49.5 Q-16 -36 -12 -4 Q-18 -5 -22 -8z" fill="${k.coatDark}" opacity=".55"/>
        <path d="M6 -46 V-6" stroke="${k.coatDark}" stroke-width="1.6" opacity=".7"/>
        <circle cx="10" cy="-34" r="2" fill="${k.coatDark}"/><circle cx="10" cy="-22" r="2" fill="${k.coatDark}"/>
        <path d="M-22 -10 Q0 -2 22 -10 L22 -6 Q0 3 -22 -6z" fill="#F4F8FC" opacity=".85"/>
        <g transform="translate(${SHOULDER[0]} ${SHOULDER[1]})">
          <g class="arm-${k.id}">
            <path d="M0 0 V${ARM - 6}" stroke="${k.coat}" stroke-width="10" stroke-linecap="round"/>
            <circle cx="0" cy="${ARM}" r="7" fill="${k.hat}"/>
            <circle class="held-${k.id}" cx="0" cy="${ARM + 7}" r="6.5" fill="#F4F8FC" stroke="#C9DAE8" stroke-width="1.2"/>
          </g>
        </g>
        <path d="M-17 -54 q-8 10 -12 24 l9 2 q3 -12 9 -20z" fill="${k.scarfDark}"/>
        <ellipse cx="0" cy="-50" rx="20" ry="7.5" fill="${k.scarf}"/>
        <path d="M-18 -51 q18 7 36 0" stroke="${k.scarfDark}" stroke-width="2" fill="none" opacity=".7"/>
        <circle cx="0" cy="-78" r="30" fill="#F6D9C6"/>
        <path d="M-30 -78 a30 30 0 0 0 52 20 a32 32 0 0 1 -50 -26z" fill="#E9C1AA" opacity=".6"/>
        <path d="M-27 -86 q4 14 -2 22 q-6 -12 2 -22z M24 -88 q4 10 6 14 q-8 -2 -6 -14z" fill="${k.hair}"/>
        <path d="M-31 -82 Q-31 -116 2 -116 Q32 -115 31 -82z" fill="${k.hat}"/>
        <path d="M-12 -114 Q-18 -98 -16 -86 M2 -116 V-86 M16 -114 Q21 -98 19 -86" stroke="${k.hatDark}" stroke-width="2.2" fill="none" opacity=".55"/>
        <rect x="-33" y="-89" width="66" height="11" rx="5.5" fill="${k.band}"/>
        <path d="M-30 -83 h60" stroke="${k.hatDark}" stroke-width="1.4" stroke-dasharray="2 3" opacity=".5"/>
        <circle cx="-12" cy="-117" r="9" fill="${k.band}"/>
        <circle cx="-14" cy="-119" r="4" fill="#FFFFFF" opacity=".7"/>
        <g class="eyes-${k.id}">
          <ellipse cx="5" cy="-72" rx="3.6" ry="4.8" fill="#2A1E1A"/><ellipse cx="22" cy="-72" rx="3.6" ry="4.8" fill="#2A1E1A"/>
          <circle cx="6.3" cy="-74" r="1.4" fill="#FFF"/><circle cx="23.3" cy="-74" r="1.4" fill="#FFF"/>
        </g>
        <g class="squint-${k.id}" opacity="0" stroke="#2A1E1A" stroke-width="2.2" stroke-linecap="round" fill="none">
          <path d="M2 -76 l6 4 l-6 4 M25 -76 l-6 4 l6 4"/>
        </g>
        <ellipse cx="-1" cy="-62" rx="5.5" ry="3.4" fill="#F29C9C" opacity=".55"/>
        <ellipse cx="27" cy="-62" rx="4.5" ry="3.2" fill="#F29C9C" opacity=".55"/>
        <path d="M11 -63 q3 3 6 0" stroke="#7A3B33" stroke-width="1.8" stroke-linecap="round" fill="none"/>
        <g class="splat-${k.id}" opacity="0">
          <circle cx="16" cy="-74" r="8" fill="#F4F8FC"/><circle cx="8" cy="-66" r="4.5" fill="#F4F8FC"/>
          <circle cx="24" cy="-82" r="4" fill="#F4F8FC"/><circle cx="25" cy="-66" r="3" fill="#DCE8F2"/>
          <circle cx="13" cy="-86" r="2.6" fill="#DCE8F2"/>
        </g>
      </g>
    </g>
  </g>`;
}

// Uçan top: dış grup x'i düz, iç grup y'yi önce yavaşlayarak yükselip sonra hızlanarak düşerek taşır (yay).
function ball(id, from, to, start, end) {
  const mid = (start + end) / 2;
  const peak = 140;
  const flight = `
  @keyframes fx-${id} { 0%, ${start}% { transform: translateX(${from[0]}px); } ${end}%, 100% { transform: translateX(${to[0].toFixed(1)}px); } }
  @keyframes fy-${id} {
    0%, ${start}% { transform: translateY(${from[1].toFixed(1)}px); animation-timing-function: cubic-bezier(.3, .6, .6, 1); }
    ${mid}% { transform: translateY(${peak}px); animation-timing-function: cubic-bezier(.4, 0, .7, .4); }
    ${end}%, 100% { transform: translateY(${to[1].toFixed(1)}px); }
  }
  @keyframes fo-${id} { 0%, ${start - 0.01}% { opacity: 0; } ${start}%, ${end - 0.01}% { opacity: 1; } ${end}%, 100% { opacity: 0; } }
  .fx-${id} { animation: fx-${id} var(--t) linear infinite; }
  .fy-${id} { animation: fy-${id} var(--t) infinite; }
  .fo-${id} { animation: fo-${id} var(--t) step-end infinite; }`;
  const el = `
  <g class="fx-${id}"><g class="fy-${id}"><g class="fo-${id}" opacity="0">
    <circle r="6.5" fill="#F4F8FC"/><path d="M-4 3 a6.5 6.5 0 0 0 9 -4" stroke="#C9DAE8" stroke-width="2" fill="none"/>
  </g></g></g>`;
  return { css: flight, el };
}

// Bir çocuğun zaman çizelgesi; o = atışın başladığı yüzde, hit = topun ona çarptığı yüzde, hold = elinde top görünen aralık
function kidCss(id, o, hit, holdFrom) {
  const p = (v) => +(((v % 100) + 100) % 100).toFixed(2);
  const arm = [[0, -15], [o, -15], [o + 8, 100], [o + 10, 100], [o + 12, -120], [o + 16, -60], [o + 24, -15]];
  const lean = [[0, 0], [o, 0], [o + 8, -4], [o + 10, -4], [o + 13, 7], [o + 20, 0], [hit, 0], [hit + 1.5, -11], [hit + 6, -6], [hit + 10, 0]];
  const sorted = (rows) => {
    const r = rows.map(([t, v]) => [p(t), v]).sort((a, b) => a[0] - b[0]);
    if (r[r.length - 1][0] !== 100) r.push([100, r[0][1]]);
    if (r[0][0] !== 0) r.unshift([0, r[r.length - 1][1]]);
    return r;
  };
  const kf = (name, rows, fn) => `@keyframes ${name} { ${sorted(rows).map(([t, v]) => `${t}% { ${fn(v)} }`).join(' ')} }`;
  const held = holdFrom < o + 12
    ? `@keyframes held-${id} { 0%, ${p(holdFrom) - 0.01}% { opacity: 0; } ${p(holdFrom)}%, ${p(o + 12) - 0.01}% { opacity: 1; } ${p(o + 12)}%, 100% { opacity: 0; } }`
    : `@keyframes held-${id} { 0%, ${p(o + 12) - 0.01}% { opacity: 1; } ${p(o + 12)}%, ${p(holdFrom) - 0.01}% { opacity: 0; } ${p(holdFrom)}%, 100% { opacity: 1; } }`;
  return `
  ${kf(`arm-${id}`, arm, (v) => `transform: rotate(${v}deg);`)}
  ${kf(`body-${id}`, lean, (v) => `transform: rotate(${v}deg);`)}
  @keyframes squint-${id} { 0%, ${hit - 0.01}% { opacity: 0; } ${hit}%, ${hit + 9}% { opacity: 1; } ${hit + 9.01}%, 100% { opacity: 0; } }
  @keyframes eyes-${id} { 0%, ${hit - 0.01}% { opacity: 1; } ${hit}%, ${hit + 9}% { opacity: 0; } ${hit + 9.01}%, 100% { opacity: 1; } }
  @keyframes splat-${id} { 0%, ${hit - 0.01}% { opacity: 0; transform: scale(.6); } ${hit}% { opacity: 1; transform: scale(1); } ${hit + 14}% { opacity: 0; transform: scale(1.15); } 100% { opacity: 0; } }
  ${held}
  .arm-${id} { animation: arm-${id} var(--t) ease-in-out infinite; }
  .body-${id} { animation: body-${id} var(--t) ease-in-out infinite; }
  .squint-${id} { animation: squint-${id} var(--t) step-end infinite; }
  .eyes-${id} { animation: eyes-${id} var(--t) step-end infinite; }
  .splat-${id} { animation: splat-${id} var(--t) ease-out infinite; transform-origin: 16px -74px; }
  .held-${id} { animation: held-${id} var(--t) step-end infinite; }`;
}

// Arka planda yavaş yağan kar: tane başına konum, boy, süre ve gecikme (sabit, her üretimde aynı)
const FLAKES = [[40, 2.2, 11, 0], [95, 1.6, 14, -6], [210, 2.6, 12, -3], [265, 1.4, 16, -9], [330, 2, 13, -1],
  [385, 1.6, 15, -7], [440, 2.4, 11, -4], [520, 1.8, 14, -10], [575, 2.2, 12, -2], [615, 1.5, 16, -12],
  [160, 1.8, 13, -8], [470, 1.4, 17, -5]];

function build(still) {
  const [l, r] = KIDS;
  const b1 = ball('a', hand(l), world(r, FACE), 12, 34);
  const b2 = ball('b', hand(r), world(l, FACE), 58, 80);
  const css = `
  :root { --t: 5s; }
  .bob { animation: bob 1.6s ease-in-out infinite; }
  @keyframes bob { 50% { transform: translateY(-1.5px); } }
  .flake { animation: fall linear infinite; }
  @keyframes fall { from { transform: translate(0, -20px); } 50% { transform: translate(8px, 180px); } to { transform: translate(0, 380px); } }
  ${kidCss('l', 0, 80, 92)}
  ${kidCss('r', 46, 34, 44)}
  ${b1.css}
  ${b2.css}`;
  const flakes = FLAKES.map(([x, rad, d, delay]) =>
    `<circle class="flake" cx="${x}" cy="0" r="${rad}" fill="#EAF3FA" opacity=".75" style="animation-duration:${d}s;animation-delay:${delay}s"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<!-- Kış Odası kartopu sahnesi. Üretici: test/tools/kis-scene.js (elle değiştirme). -->
<style>${still ? '' : css}</style>
<g>${still ? '' : flakes}</g>
${KIDS.map(kid).join('')}
${still ? '' : b1.el + b2.el}
</svg>
`;
}

// Buz sarkıtları: üstte kalın, yuvarlak kenarlı kar yastığı (alt kenarı dalgalı, ortasında açık bir dikiş), altında
// boğum boğum, yarı saydam buz sarkıtları: koyu kenar çizgisi, içinde beyaz parlak lekeler ve gri-mavi gölge
// lekeleri, ucu damla gibi yuvarlak. Şerit SW genişliğinde kendini tekrarlar (dalgalar SW'yi tam böler, sarkıtlar
// kenara taşmaz). Rastgelelik sabit tohumlu: her üretimde aynı çıktı.
function icicles() {
  const SW = 520;
  const SH = 120;
  const CAP = 28; // kar yastığının alt kenarının ortalama yüksekliği
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const f = (n) => n.toFixed(1);
  const wave = (x, a, k, ph) => a * Math.sin((x / SW) * Math.PI * 2 * k + ph);
  // Kar yastığı: üst kenar düz (çubuğun altına yapışık), alt kenar dalgalı
  const bottom = [];
  for (let x = -6; x <= SW + 6; x += 6) bottom.push([x, CAP + wave(x, 2.6, 4, 0.4) + wave(x, 1.4, 11, 2)]); // kenarların 6 birim dışına taşar: karolar dikişsiz birleşir
  const capPath = `M-6 0 H${SW + 6} V${f(bottom[bottom.length - 1][1])} ${bottom.slice().reverse().map(([x, y]) => `L${x} ${f(y)}`).join(' ')} Z`;
  const seam = bottom.map(([x, y], k) => `${k ? 'L' : 'M'}${x} ${f(y - 8 + wave(x, 2, 7, 1))}`).join(' ');
  const shade = bottom.map(([x, y], k) => `${k ? 'L' : 'M'}${x} ${f(y - 1.2)}`).join(' ');

  const ice = [];
  let x = 14 + rnd() * 10;
  while (x < SW - 14) {
    const long = rnd();
    const len = long > 0.72 ? 70 + rnd() * 22 : long > 0.35 ? 44 + rnd() * 20 : 22 + rnd() * 14;
    const w0 = Math.min(len > 65 ? 30 + rnd() * 8 : len > 40 ? 22 + rnd() * 7 : 14 + rnd() * 6, 2 * Math.min(x, SW - x) - 2);
    const lean = (rnd() - 0.5) * 6;
    const top = CAP - 3;
    const bulge = 3 + Math.floor(rnd() * 3);
    const ph = rnd() * 6;
    const N = 28;
    const left = [];
    const right = [];
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const cx = x + lean * t * t + Math.sin(t * 7 + ph) * 0.8;
      const half = (w0 / 2) * Math.pow(1 - t, 0.75) * (1 + 0.3 * Math.sin(t * Math.PI * bulge * 1.6 + ph)) * (k < 2 ? 0.9 : 1) + (k === N ? 0 : 0.8);
      const y = top + len * t;
      left.push([cx - half, y]);
      right.push([cx + half, y]);
    }
    const tip = left[N];
    const pts = [...left, ...right.slice(0, N).reverse()];
    const d = `M${pts.map(([a, b]) => `${f(a)} ${f(b)}`).join(' L')} Z`;
    ice.push(`<path d="${d}" fill="url(#ice)" stroke="#5E7286" stroke-opacity=".75" stroke-width="1.1" stroke-linejoin="round"/>`);
    // iç lekeler: beyaz parlak ve gri-mavi gölge, sarkığın içinde kalacak boyda
    for (let k = 1; k < N - 2; k += 1 + Math.floor(rnd() * 2)) {
      const cx = (left[k][0] + right[k][0]) / 2;
      const half = (right[k][0] - left[k][0]) / 2;
      if (half < 3) continue;
      // yatay, düzensiz parlak leke (iki üst üste elips) ve altında ince gri-mavi gölge kavsi
      const rx = half * (0.3 + rnd() * 0.35);
      const ry = Math.max(1.2, rx * (0.35 + rnd() * 0.25));
      const ox = (rnd() - 0.5) * (half - rx) * 1.4;
      const cy = left[k][1] + (rnd() - 0.5) * 2;
      const op = (0.3 + rnd() * 0.35).toFixed(2);
      ice.push(`<g fill="#FFFFFF" fill-opacity="${op}" transform="rotate(${f((rnd() - 0.5) * 24)} ${f(cx + ox)} ${f(cy)})"><ellipse cx="${f(cx + ox)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}"/><ellipse cx="${f(cx + ox + rx * 0.5)}" cy="${f(cy + ry * 0.4)}" rx="${f(rx * 0.6)}" ry="${f(ry * 0.8)}"/></g>`);
      if (rnd() < 0.6) ice.push(`<path d="M${f(cx + ox - rx)} ${f(cy + ry + 0.8)} q${f(rx)} ${f(ry * 1.2)} ${f(rx * 2)} 0" stroke="#4C6074" stroke-opacity=".4" stroke-width="1.2" fill="none" stroke-linecap="round"/>`);
    }
    // sol kenarın içinde kısa parlama (üst yarıda)
    const hl = left.slice(1, Math.round(N * 0.45)).map(([a, b], k2) => {
      const k3 = k2 + 1;
      return `${k2 ? 'L' : 'M'}${f(a + (right[k3][0] - a) * 0.22)} ${f(b)}`;
    }).join(' ');
    ice.push(`<path d="${hl}" stroke="#FFFFFF" stroke-opacity=".55" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    ice.push(`<ellipse cx="${f(tip[0])}" cy="${f(tip[1] - 0.6)}" rx="1.5" ry="2" fill="#E9F2F8" fill-opacity=".85" stroke="#5E7286" stroke-opacity=".6" stroke-width=".7"/>`);
    x += w0 / 2 + 8 + rnd() * 18;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SW} ${SH}" width="${SW}" height="${SH}">
<!-- Kış Odası buz sarkıtları. Üretici: test/tools/kis-scene.js (elle değiştirme). -->
<defs>
  <linearGradient id="ice" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#9FB3C4" stop-opacity=".55"/>
    <stop offset=".35" stop-color="#E4EEF5" stop-opacity=".42"/>
    <stop offset=".7" stop-color="#C8D7E3" stop-opacity=".38"/>
    <stop offset="1" stop-color="#8296A8" stop-opacity=".55"/>
  </linearGradient>
  <linearGradient id="snow" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFFFFF"/>
    <stop offset=".75" stop-color="#EEF3F7"/>
    <stop offset="1" stop-color="#C9D5DF"/>
  </linearGradient>
</defs>
${ice.join('\n')}
<path d="${capPath}" fill="url(#snow)"/>
<path d="${shade}" stroke="#AAB9C6" stroke-width="2" fill="none" stroke-opacity=".8"/>
<path d="${seam}" stroke="#FFFFFF" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-opacity=".9"/>
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'sarkit.svg'), icicles());
fs.writeFileSync(path.join(OUT, 'kartopu.svg'), build(false));
fs.writeFileSync(path.join(OUT, 'kartopu-durgun.svg'), build(true));
console.log('kartopu.svg, kartopu-durgun.svg, sarkit.svg yazıldı');
