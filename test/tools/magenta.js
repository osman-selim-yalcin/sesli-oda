#!/usr/bin/env node
// Macenta denemesi: temaya bağlanmamış (sabit yazılmış) renkleri ortaya çıkarır.
// Sayfayı başsız Chrome'da açar, değişken sözleşmesindeki bütün renkleri çiğ renklere çeker
// ve ekran görüntüsü alır:
//   #FF00FF  zeminler ve yumuşak zeminler (--bg, --surface*, --accent-soft, --danger-soft, --live-soft, --overlay)
//   #00FFFF  vurgu ve durum renkleri (--accent, --accent-2, --live, --danger); zemin üstünde de görünür
//   #00FF00  metin (--text, --muted, --accent-contrast, --danger-contrast, --avatar-text)
//   #FFFF00  kenarlık (--border, --border-strong)
// Görüntüde bu dört renkten başka bir renkte kalan her öğe temaya bağlanmamıştır.
// (Kişi tonu --hue gibi oyun içeriği renkleri kural gereği kendi renginde kalır.)
//
// Kullanım:
//   node test/tools/magenta.js <url> <çıktı.png> [genişlik] [seçenekler]
//   node test/tools/magenta.js http://localhost:3217/ giris.png 390
//   node test/tools/magenta.js http://localhost:3217/ oda.png 1440 --token test:Ali --room genel
// Seçenekler:
//   --token <belirteç>  localStorage.token yazılır (oturum açık açılır; test sunucusunda test:<Ad>)
//   --room <id>         /oda/<id> açılır, odanın kartına tıklanır, oda ekranı görünene kadar beklenir
//                       (--token ile birlikte; şifreli odada çalışmaz)
//   --height <px>       pencere yüksekliği (varsayılan: genişlik < 600 ise 844, değilse 900)
//   --full              bütün sayfanın görüntüsü (yalnız görünen alan değil)
//   --wait <ms>         görüntüden önce ek bekleme (varsayılan 800)
//   --no-magenta        renkleri değiştirmeden normal görüntü al
//   --eval <js>         görüntüden önce sayfada çalıştırılacak ifade (örn. bir pencereyi açmak)
//   --force-pseudo      data-pseudo="hover focus-visible …" taşıyan öğelere o durumları zorlar
//                       (bileşen vitrini: test/tools/components.html, file:// adresiyle açılır)
//   --profile <klasör>  Chrome profil klasörü (varsayılan: deponun git'e girmeyen .superpowers/ altında
//                       geçici bir klasör; iş bitince silinir)
//   --chrome <yol>      Chrome yolu (varsayılan: CHROME ortam değişkeni ya da macOS'taki Google Chrome)
// Sunucu yalnız test önyüklemesiyle çalıştırılır: PORT=<port> node -r ./test/preload.js server.js
// Bağımlılık yok: Node'un yerleşik WebSocket ve fetch'i (Node 22+) ile CDP konuşur.
// Bu dosya bir test değildir; `npm test` (node --test test/) yalnız *.test.js dosyalarını çalıştırır.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONTRACT = {
  '#FF00FF': ['--bg', '--surface', '--surface-2', '--surface-3', '--accent-soft', '--danger-soft', '--live-soft', '--overlay'],
  '#00FFFF': ['--accent', '--accent-2', '--live', '--danger'],
  '#00FF00': ['--text', '--muted', '--accent-contrast', '--danger-contrast', '--avatar-text'],
  '#FFFF00': ['--border', '--border-strong'],
};
const EXTRA = { '--shadow-1': '0 0 0 1px #FF00FF', '--shadow-2': '0 0 0 1px #FF00FF', '--focus-ring': '0 0 0 3px #FF00FF' };

function parseArgs(argv) {
  const opts = { wait: 800, magenta: true, full: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token') opts.token = argv[++i];
    else if (a === '--room') opts.room = argv[++i];
    else if (a === '--height') opts.height = Number(argv[++i]);
    else if (a === '--wait') opts.wait = Number(argv[++i]);
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--chrome') opts.chrome = argv[++i];
    else if (a === '--full') opts.full = true;
    else if (a === '--no-magenta') opts.magenta = false;
    else if (a === '--eval') opts.eval = argv[++i];
    else if (a === '--force-pseudo') opts.forcePseudo = true;
    else if (a.startsWith('--')) throw new Error(`Bilinmeyen seçenek: ${a}`);
    else pos.push(a);
  }
  [opts.url, opts.out, opts.width] = pos;
  if (!opts.url || !opts.out) throw new Error('Kullanım: node test/tools/magenta.js <url> <çıktı.png> [genişlik] [--token t] [--room id]');
  opts.width = Number(opts.width) || 1440;
  opts.height ||= opts.width < 600 ? 844 : 900;
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Zaman aşımı: ${what}`);
    await sleep(150);
  }
}

// Basit CDP istemcisi (tek sayfa oturumu).
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const calls = new Map();
  const waiters = [];
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && calls.has(msg.id)) {
      const { resolve, reject } = calls.get(msg.id);
      calls.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      listeners.get(msg.method)?.(msg.params);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].method === msg.method) waiters.splice(i, 1)[0].resolve(msg.params);
      }
    }
  };
  const open = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP bağlantısı açılamadı'));
  });
  return {
    open,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      calls.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    on: (method, fn) => listeners.set(method, fn),
    once: (method) => new Promise((resolve) => waiters.push({ method, resolve })),
    close: () => ws.close(),
  };
}

function chromePath(opts) {
  return opts.chrome || process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tempProfile = !opts.profile;
  // Varsayılan profil deponun .superpowers/ klasöründe (git'e girmez; /tmp kullanılmaz).
  const scratch = path.join(__dirname, '..', '..', '.superpowers', 'tmp');
  if (tempProfile) fs.mkdirSync(scratch, { recursive: true });
  const profile = opts.profile || fs.mkdtempSync(path.join(scratch, 'magenta-chrome-'));
  const chrome = spawn(chromePath(opts), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });
  let client;
  try {
    // Chrome seçtiği portu profil klasöründeki DevToolsActivePort dosyasına yazar.
    const port = await waitFor(async () => {
      const txt = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8');
      return txt.split('\n')[0].trim() || null;
    }, 15000, 'Chrome açılmadı');
    const page = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((t) => t.type === 'page');
    }, 10000, 'sayfa hedefi');
    client = cdp(page.webSocketDebuggerUrl);
    await client.open;
    const { send, once } = client;
    // Konsol hataları ve yakalanmamış istisnalar sonda yazdırılır.
    const problems = [];
    client.on('Runtime.exceptionThrown', (p) => problems.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    client.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') problems.push(p.args.map((a) => a.value ?? a.description).join(' '));
    });
    client.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') problems.push(`${p.entry.text} ${p.entry.url || ''}`.trim());
    });
    await send('Log.enable');
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: opts.width < 600,
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const go = async (url) => {
      const loaded = once('Page.loadEventFired');
      await send('Page.navigate', { url });
      await loaded;
    };

    const base = new URL(opts.url);
    if (opts.token) {
      await go(base.origin + '/');
      await evaluate(`localStorage.setItem('token', ${JSON.stringify(opts.token)}); true`);
    }
    const target = opts.room ? new URL(`/oda/${encodeURIComponent(opts.room)}`, base.origin).href : base.href;
    await go(target);
    if (opts.room) {
      // /oda/<id> listede odanın kartını işaretler; giriş bir kullanıcı tıklaması ister (ses izni).
      const box = await waitFor(() => evaluate(`(() => {
        const c = document.querySelector('.room-card.target');
        if (!c) return null;
        c.scrollIntoView({ block: 'center' });
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`), 15000, 'oda kartı bulunamadı');
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await waitFor(() => evaluate(`!document.getElementById('room-screen').hidden`), 20000, 'oda ekranı görünmedi');
    } else {
      await waitFor(() => evaluate(`document.readyState === 'complete'`), 10000, 'sayfa yüklenmedi');
    }
    if (opts.eval) await evaluate(opts.eval);
    if (opts.forcePseudo) {
      await send('DOM.enable');
      await send('CSS.enable');
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-pseudo]' });
      for (const nodeId of nodeIds) {
        const { attributes } = await send('DOM.getAttributes', { nodeId });
        const states = attributes[attributes.indexOf('data-pseudo') + 1].split(/\s+/).filter(Boolean);
        await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states });
      }
    }
    await evaluate('document.fonts.ready.then(() => true)');
    if (opts.magenta) {
      const decls = [];
      for (const [color, names] of Object.entries(CONTRACT)) for (const n of names) decls.push(`${n}: ${color} !important;`);
      for (const [n, v] of Object.entries(EXTRA)) decls.push(`${n}: ${v} !important;`);
      const css = `:root, :root[data-theme] { ${decls.join(' ')} }`;
      // Tema değişince de geçerli kalsın diye <head> sonuna eklenir ve !important taşır.
      await evaluate(`(() => {
        const s = document.createElement('style');
        s.id = 'magenta-probe';
        s.textContent = ${JSON.stringify(css)};
        document.head.append(s);
        return true;
      })()`);
    }
    await sleep(opts.wait);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: opts.full });
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, Buffer.from(shot.data, 'base64'));
    for (const p of problems) console.log(`konsol hatası: ${p}`);
    console.log(`${opts.magenta ? 'macenta' : 'normal'} görüntü: ${opts.out} (${opts.width}x${opts.height})`);
  } finally {
    client?.close();
    chrome.kill();
    await new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once('exit', r)));
    if (tempProfile) fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
