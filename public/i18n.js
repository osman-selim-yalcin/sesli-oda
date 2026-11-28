// ---------- Dil desteği (Türkçe / English) ----------
// Sitenin kaynak dili Türkçe. İngilizce seçiliyse sayfadaki metinler ekrana çıktığı anda çevrilir: metin düğümleri,
// placeholder/title/aria-label nitelikleri, alert/confirm/prompt. Sözlük public/lang/en-*.js dosyalarındadır
// (I18N.add ile eklenir). Anahtarlar ekrandaki Türkçe metnin kendisidir; {0}, {1}… değişken parçalardır ve
// çevirinin içinde aynı numarayla yer alır. Kullanıcının yazdığı şeyler (sohbet, isimler, başlıklar)
// translate="no" taşıyan kutuların içinde durur ve çevrilmez.
// Oyunlar kendi verisini dile göre seçmek isterse I18N.lang'e bakar ve 'langchange' olayını dinler.
(() => {
  const KEY = 'lang';
  const LANGS = ['tr', 'en'];
  const FILES = ['/lang/en-ui.js?v=2', '/lang/en-games.js?v=kart4', '/lang/en-server.js?v=kart1'];
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  function initial() {
    try {
      const saved = localStorage.getItem(KEY);
      if (LANGS.includes(saved)) return saved;
    } catch {}
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'tr';
    return /^tr\b/i.test(nav) ? 'tr' : 'en';
  }

  const exact = new Map(); // normalleştirilmiş Türkçe -> İngilizce
  const lower = new Map(); // küçük harfli eşleşme (cümle içindeki tek kelimeler için)
  const patterns = []; // { re, out, literal }
  let sorted = true;

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function add(dict) {
    for (const [tr, en] of Object.entries(dict)) {
      const key = norm(tr);
      if (/\{\d+\}/.test(key)) {
        const order = [];
        const src = key.split(/(\{\d+\})/).map((part) => {
          const m = /^\{(\d+)\}$/.exec(part);
          if (!m) return escape(part);
          order.push(Number(m[1]));
          return '([\\s\\S]*?)';
        }).join('');
        patterns.push({ re: new RegExp(`^${src}$`), order, out: en, literal: key.replace(/\{\d+\}/g, '').length });
        sorted = false;
      } else {
        exact.set(key, en);
        lower.set(key.toLocaleLowerCase('tr'), en);
      }
    }
  }

  // Bir parçayı çevirir; bulamazsa null. Değişken parçalar da (ör. "kolay", "Ali ayrıldı.") çevrilmeye çalışılır.
  function lookup(text, depth = 0) {
    const s = norm(text);
    if (!s || !/\p{L}/u.test(s)) return null;
    if (exact.has(s)) return exact.get(s);
    if (!sorted) {
      patterns.sort((a, b) => b.literal - a.literal);
      sorted = true;
    }
    // Değişken parça " · " ile birleşmiş bir özet satırıysa (ör. "Ali 3 deneme · Can bulamadı") parça parça çevrilir.
    if (depth > 0 && s.includes(' · ')) {
      const pieces = s.split(' · ');
      const out = pieces.map((x) => lookup(x, depth + 1));
      if (out.some((x) => x != null)) return pieces.map((x, i) => out[i] ?? x).join(' · ');
    }
    if (depth < 4) {
      for (const p of patterns) {
        const m = p.re.exec(s);
        if (!m) continue;
        const parts = [];
        p.order.forEach((n, i) => { parts[n] = m[i + 1]; });
        return p.out.replace(/\{(\d+)\}/g, (_, n) => {
          const v = parts[Number(n)] ?? '';
          const lead = /^\s*/.exec(v)[0];
          const tail = /\s*$/.exec(v)[0];
          const t = lookup(v, depth + 1);
          return t == null ? v : lead + t + tail;
        });
      }
    }
    // Sıra numarasıyla başlayan parça: "3. Kalabalık"
    const num = /^(\d+\.\s+)(\S[\s\S]*)$/.exec(s);
    if (num && depth < 4) {
      const rest = lookup(num[2], depth + 1);
      if (rest != null) return num[1] + rest;
    }
    // Başında/sonunda işaret olan parça: "· çözüyor", "(ayrıldı)", "Hazır:" gibi.
    const m = /^([^\p{L}\p{N}"'{]*)([\s\S]*?)([^\p{L}\p{N}"'}]*)$/u.exec(s);
    if (m && (m[1] || m[3]) && m[2]) {
      const core = exact.get(m[2]) ?? (depth < 4 ? lookup(m[2], depth + 1) : null);
      if (core != null) return m[1] + core + m[3];
    }
    // Birden çok cümle: "Ali oyunu bitirdi. Oyun bitti" → cümle cümle
    if (depth < 3) {
      const sentences = s.split(/(?<=[.!?])\s+(?=\S)/);
      if (sentences.length > 1) {
        const out = sentences.map((x) => lookup(x, depth + 1));
        if (out.some((x) => x != null)) return sentences.map((x, i) => out[i] ?? x).join(' ');
      }
    }
    if (depth > 0) {
      const lo = lower.get(s.toLocaleLowerCase('tr'));
      if (lo != null) return lo;
    }
    return null;
  }

  // Dışarıdan çağrılan çeviri: Türkçe seçiliyse aynen döner.
  function t(text) {
    if (I18N.lang !== 'en' || text == null) return text;
    const s = String(text);
    const out = lookup(s, 0) ?? lookup(s, 1);
    if (out == null) return s;
    return /^\s*/.exec(s)[0] + out + /\s*$/.exec(s)[0];
  }

  // ---------- DOM ----------
  const origText = new WeakMap(); // metin düğümü -> { tr, en }
  const origAttr = new WeakMap(); // eleman -> { nitelik: { tr, en } }
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'svg', 'SVG']);
  // Kullanıcının yazdıkları ve oyunların Türkçe kelime içerikleri (Daktilo, Kelime, Hızlı okuma) çevrilmez.
  const KEEP = '.q-title, .tier-card-text, .kelime-word, .blok-item, .takisto-word, #daktilo-text, #kelime-chosen-word, #kelime-slot, .daktilo-word';
  const keep = (e) => SKIP.has(e.tagName) || e.getAttribute('translate') === 'no' || e.isContentEditable || e.matches(KEEP);

  function skipped(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (keep(e)) return true;
    return false;
  }

  function doText(node) {
    const cur = node.nodeValue;
    const rec = origText.get(node);
    if (rec && rec.en === cur) return;
    if (!/\p{L}/u.test(cur)) return;
    const out = t(cur);
    if (out === cur) return;
    origText.set(node, { tr: cur, en: out });
    node.nodeValue = out;
  }

  function doAttrs(el) {
    let rec = origAttr.get(el);
    for (const a of ATTRS) {
      const cur = el.getAttribute(a);
      if (!cur || rec?.[a]?.en === cur) continue;
      const out = t(cur);
      if (out === cur) continue;
      if (!rec) origAttr.set(el, (rec = {}));
      rec[a] = { tr: cur, en: out };
      el.setAttribute(a, out);
    }
  }

  function walk(root) {
    if (root.nodeType === 3) {
      if (!skipped(root.parentElement)) doText(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && skipped(root)) return;
    if (root.nodeType === 1) doAttrs(root);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType === 1) return keep(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === 3) doText(n);
      else doAttrs(n);
    }
  }

  let observer = null;
  function observe() {
    if (observer || !document.body) return;
    observer = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'childList') m.addedNodes.forEach(walk);
        else if (m.type === 'characterData') { if (!skipped(m.target.parentElement)) doText(m.target); }
        else if (m.type === 'attributes' && !skipped(m.target)) doAttrs(m.target);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  // Türkçeye dönüş: çevrilmiş ve sonradan değişmemiş metinleri eski hâline getirir.
  function restore(root = document.body) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = tw.currentNode; n; n = tw.nextNode()) {
      if (n.nodeType === 3) {
        const rec = origText.get(n);
        if (rec && n.nodeValue === rec.en) n.nodeValue = rec.tr;
        origText.delete(n);
      } else {
        const rec = origAttr.get(n);
        if (!rec) continue;
        for (const [a, v] of Object.entries(rec)) if (n.getAttribute(a) === v.en) n.setAttribute(a, v.tr);
        origAttr.delete(n);
      }
    }
  }

  // ---------- Sözlük yükleme ----------
  let loaded = false;
  let loading = null;
  function loadDicts() {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    loading = Promise.all(FILES.map((src) => new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { console.warn('dil dosyası yüklenemedi:', src); resolve(); };
      document.head.append(s);
    }))).then(() => { loaded = true; });
    return loading;
  }

  function start() {
    document.documentElement.lang = I18N.lang;
    if (I18N.lang !== 'en') return;
    const go = () => { if (document.body) walk(document.body); document.title = t(document.title); observe(); };
    if (document.body) go();
    else document.addEventListener('DOMContentLoaded', go, { once: true });
  }

  async function setLang(lang) {
    if (!LANGS.includes(lang) || lang === I18N.lang) return;
    try { localStorage.setItem(KEY, lang); } catch {}
    if (lang === 'en') await loadDicts();
    I18N.lang = lang;
    document.documentElement.lang = lang;
    syncSelects();
    if (lang === 'en') {
      walk(document.body);
      document.title = t(document.title);
      observe();
    } else {
      observer?.disconnect();
      observer = null;
      restore();
      document.title = document.title.replace(/\bVoice Room\b/, 'Sesli Oda');
    }
    dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
  }

  // Dil seçme kutuları: class="lang-select" taşıyan her <select>.
  function syncSelects() {
    for (const sel of document.querySelectorAll('select.lang-select')) sel.value = I18N.lang;
  }
  function bindSelects() {
    for (const sel of document.querySelectorAll('select.lang-select')) {
      if (sel.dataset.bound) continue;
      sel.dataset.bound = '1';
      sel.value = I18N.lang;
      sel.addEventListener('change', () => setLang(sel.value));
    }
  }

  // Tarayıcı pencereleri
  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  const nativePrompt = window.prompt.bind(window);
  window.alert = (msg) => nativeAlert(t(msg));
  window.confirm = (msg) => nativeConfirm(t(msg));
  window.prompt = (msg, def) => nativePrompt(t(msg), def);

  const I18N = {
    lang: initial(), t, add, setLang, ready: null,
    // Tarih ve sayı biçimi için dil kodu (ay adları, ondalık ayırıcı)
    get locale() { return this.lang === 'en' ? 'en-GB' : 'tr-TR'; },
  };
  window.I18N = I18N;

  if (I18N.lang === 'en') {
    // Sözlük dosyaları sayfa çizilmeden yüklensin (Türkçe metin bir an bile görünmesin).
    if (document.readyState === 'loading') {
      for (const src of FILES) document.write(`<script src="${src}"><\/script>`);
      loaded = true;
    } else loadDicts();
  }
  I18N.ready = loaded ? Promise.resolve() : loadDicts();
  start();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindSelects, { once: true });
  else bindSelects();
})();
