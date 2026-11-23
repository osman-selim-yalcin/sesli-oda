// İstemci dosyalarında tanımsız fonksiyon çağrısı denetimi (statik, ayrıştırıcı bağımlılığı yok).
// public/*.js içinde çıplak çağrılan her ad (`foo(`, `new Foo(`) şunlardan biri olmalı:
//   - aynı dosyada çağrı dışında bir yerde geçen ad (fonksiyon/değişken/parametre/içe aktarma),
//   - index.html'de yüklenen öteki betiklerin en üst düzeyde tanımladığı ad (ya da window.X),
//   - tarayıcı/JS yerleşik global'i.
// Bir fonksiyon yeniden adlandırılıp eski adla çağrı kalırsa (lobby.js fmtDate) bu test kırılır.
// Kaba bir denetimdir: aynı ad dosyada başka bir yerde (ör. nesne anahtarı) geçiyorsa yakalamaz.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');

const KEYWORDS = new Set(`if for while switch catch function return typeof instanceof in of new delete void throw
  do else try finally case default break continue var let const class extends super this import export from as
  await async yield with debugger null true false undefined get set static`.split(/\s+/));

// Tarayıcı ve JS yerleşikleri (Node'un global'leri ayrıca eklenir).
const BROWSER = `window document navigator location history localStorage sessionStorage console alert confirm prompt
  requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback getComputedStyle matchMedia
  setTimeout clearTimeout setInterval clearInterval queueMicrotask fetch structuredClone atob btoa
  Image Audio AudioContext OfflineAudioContext MediaRecorder MediaStream RTCPeerConnection RTCSessionDescription
  RTCIceCandidate AudioWorkletNode GainNode AnalyserNode Worker Blob File FileReader FormData URL URLSearchParams
  Event CustomEvent KeyboardEvent MouseEvent PointerEvent ResizeObserver IntersectionObserver MutationObserver
  DOMParser HTMLElement Node NodeFilter Element DocumentFragment Range Selection Notification BroadcastChannel
  CSS FontFace Path2D TextEncoder TextDecoder AbortController AbortSignal WebSocket screen devicePixelRatio
  Intl Date Math JSON Promise Array Object String Number Boolean Symbol Map Set WeakMap WeakSet Error TypeError
  RangeError RegExp Reflect Proxy BigInt Uint8Array Int16Array Int8Array Float32Array Float64Array Uint16Array
  Uint32Array Int32Array ArrayBuffer DataView isNaN isFinite parseInt parseFloat encodeURIComponent
  decodeURIComponent encodeURI decodeURI performance crypto scrollTo open close print focus blur
  addEventListener removeEventListener dispatchEvent createImageBitmap Option
  io YT onYouTubeIframeAPIReady`.split(/\s+/);
// İş parçacığı ve ses işleyici global'leri.
const WORKER = ['importScripts', 'postMessage', 'self', 'lamejs', 'onmessage'];
const WORKLET = ['registerProcessor', 'AudioWorkletProcessor', 'sampleRate', 'currentTime', 'currentFrame', 'port'];
const GLOBALS = new Set([...Object.getOwnPropertyNames(globalThis), ...BROWSER, ...WORKER, ...WORKLET]);

// Kaba sözcükleyici: yorum, dize, şablon dizesi (${} içi kod sayılır) ve düzenli ifadeleri atlar.
function tokenize(src) {
  const out = [];
  const tpl = []; // açık şablon ${ içindeki süslü parantez derinlikleri
  let i = 0;
  const prevSig = () => out[out.length - 1];
  const regexOk = () => {
    const p = prevSig();
    if (!p) return true;
    if (p.type === 'id') return KEYWORDS.has(p.value) && !['this', 'super', 'null', 'true', 'false', 'undefined'].includes(p.value);
    if (p.type === 'num' || p.type === 'str') return false;
    return !(p.value === ')' || p.value === ']');
  };
  const readTemplate = () => { // i, ` sonrasında; ya kapanış `'ına ya da ${'e kadar okur
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; out.push({ type: 'str' }); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; tpl.push(0); out.push({ type: 'punct', value: '(' }); return; }
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      out.push({ type: 'str' });
      continue;
    }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '/' && regexOk()) {
      i++;
      let cls = false;
      while (i < src.length) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        else if (r === '\n') break;
        i++;
      }
      i++;
      while (/[a-z]/.test(src[i] || '')) i++;
      out.push({ type: 'str' });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (/[\w$]/.test(src[j] || '')) j++;
      out.push({ type: 'id', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (/[\w.]/.test(src[j] || '')) j++;
      out.push({ type: 'num' });
      i = j;
      continue;
    }
    if (c === '?' && src[i + 1] === '.' && !/[0-9]/.test(src[i + 2] || '')) { out.push({ type: 'punct', value: '?.' }); i += 2; continue; }
    if (c === '=' && src[i + 1] === '>') { out.push({ type: 'punct', value: '=>' }); i += 2; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { out.push({ type: 'punct', value: '...' }); i += 3; continue; }
    if (tpl.length) {
      if (c === '{') tpl[tpl.length - 1]++;
      if (c === '}') {
        if (tpl[tpl.length - 1] === 0) { tpl.pop(); i++; out.push({ type: 'punct', value: ')' }); readTemplate(); continue; }
        tpl[tpl.length - 1]--;
      }
    }
    out.push({ type: 'punct', value: c });
    i++;
  }
  return out;
}

// Çağrı yerleri, çağrı dışı geçen adlar ve en üst düzey tanımlar.
function analyze(src) {
  const t = tokenize(src);
  const calls = new Map(); // ad -> ilk geçtiği sıra
  const names = new Set();
  const topLevel = new Set();
  let depth = 0;
  const closeOf = (k) => { // k: '(' tokeni; eşleşen ')' indeksini döner
    let d = 0;
    for (let j = k; j < t.length; j++) {
      if (t[j].value === '(') d++;
      else if (t[j].value === ')' && --d === 0) return j;
    }
    return t.length - 1;
  };
  for (let k = 0; k < t.length; k++) {
    const tok = t[k];
    if (tok.type === 'punct') {
      if (tok.value === '{' || tok.value === '(' || tok.value === '[') depth++;
      if (tok.value === '}' || tok.value === ')' || tok.value === ']') depth--;
      continue;
    }
    if (tok.type !== 'id') continue;
    const prev = t[k - 1];
    const member = prev && (prev.value === '.' || prev.value === '?.');
    if (depth === 0 && prev?.type === 'id' && ['function', 'class', 'const', 'let', 'var'].includes(prev.value)) topLevel.add(tok.value);
    if (prev?.value === '.' && t[k - 2]?.value === 'window' && t[k + 1]?.value === '=') topLevel.add(tok.value);
    if (member || KEYWORDS.has(tok.value)) continue;
    const nextTok = t[k + 1];
    const isCall = nextTok?.value === '(' && prev?.value !== 'function'
      && !['{', '=>'].includes(t[closeOf(k + 1) + 1]?.value); // yöntem tanımı / ok fonksiyonu değil
    if (isCall) { if (!calls.has(tok.value)) calls.set(tok.value, k); } else names.add(tok.value);
  }
  return { calls, names, topLevel };
}

function scriptsInIndex() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  return [...html.matchAll(/<script[^>]*src="\/([^"/]+\.js)"/g)].map((m) => m[1]).filter((f) => fs.existsSync(path.join(PUBLIC, f)));
}

function undefinedCalls(file, src, shared) {
  const { calls, names } = analyze(src);
  return [...calls.keys()].filter((n) => !names.has(n) && !shared.has(n) && !GLOBALS.has(n));
}

test('denetim çalışıyor: silinmiş fonksiyona çağrı yakalanır, tanımlı olan yakalanmaz', () => {
  const src = `const fmtDay = (ms) => ms;\nfunction a(x) { return x.y(fmtDate(x), fmtDay(x), \`\${gone(1)}\`, /a(b)/.test('c(d)')); }\nconst o = { m() { return 1; } };`;
  assert.deepEqual(undefinedCalls('x.js', src, new Set()).sort(), ['fmtDate', 'gone']);
});

test('public/*.js dosyalarında tanımsız ada çağrı yok', () => {
  const loaded = scriptsInIndex();
  const shared = new Set();
  for (const f of loaded) for (const n of analyze(fs.readFileSync(path.join(PUBLIC, f), 'utf8')).topLevel) shared.add(n);
  const problems = [];
  for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    const bad = undefinedCalls(f, src, loaded.includes(f) ? shared : new Set());
    if (bad.length) problems.push(`${f}: ${bad.join(', ')}`);
  }
  assert.deepEqual(problems, []);
});
