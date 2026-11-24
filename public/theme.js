// Tema yükleyici. Tema = public/themes/<id>.css (değişken sözleşmesi: css/base.css).
// Varsayılan tema index.html'de <link id="theme-css"> ile baştan bağlıdır; ilk boyama temalı olur.
// Theme.apply(id): tema farklıysa yeni CSS'i yükler, yüklenince (ve ikon seti hazır olunca) eski bağlantıyı
// kaldırır ve <html data-theme> değerini değiştirir. Yarım yüklenmiş tema (yeni renk + eski ikon) görünmez.
// Oda listesi ve giriş ekranı her zaman varsayılan tema; odada odanın teması.
// Temaların listesi sunucudan da gelir (GET /theme-list, açılışta bir kez): sunucunun tanımadığı tema seçicide
// çıkmaz; test sunucusu (test/preload.js) yalnız denemelik bir temayı adı ve önizleme renkleriyle buradan ekler.
// Liste değişince document'a 'themelist' olayı gelir (seçiciler ve oda kartları yeniden çizilir).
window.Theme = (() => {
  const LIST = ['gece', 'aydinlik', 'piksel', 'kis'];
  const DEFAULT = 'gece';
  const NAMES = { gece: 'Gece Odası', aydinlik: 'Aydınlık Oda', piksel: 'Piksel Oda', kis: 'Kış Odası' };
  // Temanın ikon seti: public/icons/ui/<set>.svg, hepsi aynı adları (i-play, i-mic…) taşır.
  // Varsayılan set index.html'de <svg id="ui-icons" data-set="lucide"> olarak gömülüdür (ilk boyamada ikon olsun diye).
  const ICON_SETS = { gece: 'lucide', aydinlik: 'lucide', piksel: 'piksel', kis: 'lucide' };
  // Oda kartındaki önizleme şeridinin ve tema seçici kutucuğunun renkleri (zemin, panel, metin, vurgu). Kart ve
  // seçici başka temaları da gösterdiği için bu renkler o anki temanın değişkenlerinden değil, bu tablodan gelir
  // (tema CSS'i yüklenmeden); sabit renkler yalnız burada durur, kurallar onları yerel değişkenlerle kullanır.
  const PREVIEW = {
    gece: { bg: '#0E0F13', surface: '#1E2129', text: '#E8E9ED', accent: '#8B9CFF' },
    aydinlik: { bg: '#F6F4EF', surface: '#FFFFFF', text: '#171A22', accent: '#4553C4' },
    piksel: { bg: '#13152F', surface: '#232753', text: '#EEEAF8', accent: '#5AD8F0' },
    kis: { bg: '#0B1622', surface: '#19293B', text: '#EAF3FA', accent: '#8FD6F5' },
  };
  const root = document.documentElement;
  let current = root.dataset.theme || DEFAULT;
  let wanted = current;
  let job = null; // { id, promise } süren yükleme

  // Tema dosyaları tarayıcıda ve CDN'de saatlerce önbellekte kalır: bir tema dosyası değişince bu sürüm (ve index.html'deki
  // theme.js?v=…) değiştirilir, yoksa eski görünüm kalır. Varsayılan temanın index.html'deki bağlantısı sürümsüzdür.
  const CSS_VERSION = 'kis3';
  const href = (id) => `/themes/${id}.css?v=${CSS_VERSION}`;

  // İkon seti: temanın seti gömülü olandan farklıysa dosyayı alır ve bir "uygula" işlevi döndürür.
  // Uygulama tema değiştiği anda yapılır (yeni renk + eski ikon görünmez). Hata verirse apply eski temada kalır.
  const iconFiles = new Map(); // set → Promise<symbol[]>
  const iconSprite = () => document.getElementById('ui-icons');

  function fetchIcons(set) {
    if (!iconFiles.has(set)) {
      const p = fetch(`/icons/ui/${set}.svg`)
        .then((res) => {
          if (!res.ok) throw new Error(`ikon seti alınamadı: ${set} (${res.status})`);
          return res.text();
        })
        .then((text) => {
          const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
          const symbols = [...doc.querySelectorAll('symbol[id^="i-"]')];
          if (doc.querySelector('parsererror') || !symbols.length) throw new Error(`ikon seti bozuk: ${set}`);
          return symbols;
        });
      p.catch(() => iconFiles.delete(set)); // sonraki deneme yeniden alır
      iconFiles.set(set, p);
    }
    return iconFiles.get(set);
  }

  async function prepareIcons(id) {
    const set = ICON_SETS[id] || ICON_SETS[DEFAULT];
    if (iconSprite()?.dataset.set === set) return () => {};
    const symbols = await fetchIcons(set);
    return () => {
      const sprite = iconSprite();
      sprite.replaceChildren(...symbols.map((s) => document.importNode(s, true)));
      sprite.dataset.set = set;
    };
  }

  // Yeni bağlantı media="not all" ile eklenir: dosya iner ama uygulanmaz. Tema, ikonlarla aynı anda
  // (load içindeki uygulama adımında) media="all" yapılarak açılır; yarıda kalan ya da hata veren yükleme görünmez.
  function loadCss(id) {
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.media = 'not all';
      link.href = href(id);
      link.dataset.theme = id;
      link.onload = () => resolve(link);
      link.onerror = () => {
        link.remove();
        resolve(null);
      };
      const old = document.getElementById('theme-css');
      if (old) old.after(link);
      else document.head.prepend(link);
    });
  }

  // Temanın kendi yazı tipleri (tema dosyasındaki @font-face): tema açılmadan önce indirilir ki yeni renklerle birlikte
  // bir an yedek yazı tipi görünmesin. Bağlantı media="not all" iken kuralları okunabilir ama yazı tipleri yüklenmez;
  // aynı tanımla FontFace oluşturulup document.fonts'a eklenir. En çok FONT_WAIT beklenir; inmeyen ya da hata veren
  // dosya temayı durdurmaz (font-display: swap, yedek yazı tipiyle açılır).
  const FONT_WAIT = 1500;
  const fontFaces = new Map(); // src → Promise
  const FONT_DESCRIPTORS = [
    ['font-weight', 'weight'], ['font-style', 'style'], ['font-stretch', 'stretch'], ['font-display', 'display'],
    ['unicode-range', 'unicodeRange'], ['font-feature-settings', 'featureSettings'], ['size-adjust', 'sizeAdjust'],
    ['ascent-override', 'ascentOverride'], ['descent-override', 'descentOverride'], ['line-gap-override', 'lineGapOverride'],
  ];
  function loadFonts(link) {
    let rules = [];
    try {
      rules = [...link.sheet.cssRules].filter((r) => r instanceof CSSFontFaceRule);
    } catch {
      return Promise.resolve();
    }
    const jobs = rules.map((r) => {
      const st = r.style;
      const family = st.getPropertyValue('font-family').trim().replace(/^['"]|['"]$/g, '');
      const src = st.getPropertyValue('src');
      const key = `${family}|${src}|${st.getPropertyValue('unicode-range')}`;
      if (!fontFaces.has(key)) {
        // @font-face tanımlayıcılarının hepsi FontFace'e aynen geçer (unicode-range önemli: Piksel Oda'da rakamlar
        // başka yüzden çizilir); tanımlanmamış olan FontFace'in varsayılanında kalır.
        const desc = {};
        for (const [prop, key] of FONT_DESCRIPTORS) {
          const val = st.getPropertyValue(prop).trim();
          if (val) desc[key] = val;
        }
        let face;
        try {
          face = new FontFace(family, src, desc);
        } catch {
          return Promise.resolve();
        }
        fontFaces.set(key, face.load().then((f) => document.fonts.add(f)).catch(() => fontFaces.delete(key)));
      }
      return fontFaces.get(key);
    });
    if (!jobs.length) return Promise.resolve();
    return Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, FONT_WAIT))]);
  }

  // JS'te çizilen arayüz renkleri (tuval, harita, 3B sahne) değişkenden okunur: Theme.color('--accent').
  // Okunan değer tema değişene kadar saklanır; her karede getComputedStyle çağrılmaz.
  // Tema değişince document'a 'themechange' olayı gelir (detail: { id }); renk okuyan kod onu dinleyip yeniden çizer.
  const colors = new Map();
  function color(name) {
    if (!colors.has(name)) colors.set(name, getComputedStyle(root).getPropertyValue(name).trim());
    return colors.get(name);
  }
  // Renkler değişti (tema değişimi ya da sayfaya eklenen bir değişken katmanı, örn. test/tools/magenta.js):
  // saklananlar silinir, tarayıcı çubuğu güncellenir, dinleyenlere haber verilir.
  function changed() {
    colors.clear();
    syncMeta();
    document.dispatchEvent(new CustomEvent('themechange', { detail: { id: current } }));
  }

  // Tarayıcı çubuğunun rengi temanın zeminine uyar.
  function syncMeta() {
    const meta = document.querySelector('meta[name="theme-color"]');
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (meta && bg) meta.content = bg;
  }

  // Sunucudaki tema listesi: bilinmeyen tema yalnız adı ve geçerli önizleme renkleriyle eklenir; ikon seti
  // verilmezse varsayılan set. Liste yoksa (eski sunucu, ağ hatası) yerleşik liste kalır.
  const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i; // #rgb #rgba #rrggbb #rrggbbaa
  function register(info) {
    const id = info?.id;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(id) || LIST.includes(id)) return false;
    const pv = info.preview || {};
    if (typeof info.name !== 'string' || !['bg', 'surface', 'text', 'accent'].every((k) => HEX.test(pv[k] || ''))) return false;
    LIST.push(id);
    NAMES[id] = info.name.slice(0, 40);
    PREVIEW[id] = { bg: pv.bg, surface: pv.surface, text: pv.text, accent: pv.accent };
    if (typeof info.icons === 'string' && /^[a-z0-9-]+$/.test(info.icons)) ICON_SETS[id] = info.icons;
    return true;
  }
  // Liste en çok 5 sn beklenir: sunucu cevap vermezse bilinmeyen tema için apply sonsuza dek beklemesin.
  const LIST_TIMEOUT = 5000;
  const listSignal = () => {
    if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(LIST_TIMEOUT);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), LIST_TIMEOUT);
    return ctrl.signal;
  };
  const ready = fetch('/theme-list', { signal: listSignal() })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const themes = Array.isArray(data?.themes) ? data.themes : null;
      if (!themes) return;
      const known = new Set(themes.map((t) => t?.id));
      let changedList = false;
      for (const t of themes) changedList = register(t) || changedList;
      // Sunucunun artık tanımadığı tema seçicide çıkmasın (varsayılan her zaman kalır).
      for (let i = LIST.length - 1; i >= 0; i--) {
        if (LIST[i] !== DEFAULT && !known.has(LIST[i])) {
          LIST.splice(i, 1);
          changedList = true;
        }
      }
      if (changedList) document.dispatchEvent(new CustomEvent('themelist'));
    })
    .catch(() => {});

  // Promise<boolean>: false yalnız tema dosyası ya da ikon seti yüklenemediyse (önceki tema kalır; çağıran
  // kullanıcıya söyler). Başka tema istendiği için yarıda bırakılan yükleme true döner. Hiç reddetmez.
  let seq = 0; // en son istenen kazanır (liste beklenirken sonradan istenen tema öne geçmesin)
  async function apply(id) {
    const mine = ++seq;
    if (!LIST.includes(id)) {
      await ready; // liste sunucudan gelmeden istenen tema (örn. test teması) beklesin
      if (mine !== seq) return true;
    }
    return load(id);
  }

  function load(id) {
    if (!LIST.includes(id)) id = DEFAULT;
    wanted = id;
    const linked = document.getElementById('theme-css')?.dataset.theme;
    if (id === linked) {
      root.dataset.theme = current = id;
      return job?.promise.then(() => true) ?? Promise.resolve(true);
    }
    if (job?.id === id) return job.promise;
    const css = loadCss(id);
    // apply hiçbir zaman reddetmez: ikon ya da yükleme hatasında uyarı yazılır, önceki tema kalır.
    const promise = Promise.all([css.then(async (link) => (link && (await loadFonts(link)), link)), prepareIcons(id)])
      .then(([link, commitIcons]) => {
        if (!link) {
          console.warn(`Tema dosyası yüklenemedi (${id}), önceki tema kalıyor.`);
          return false; // eski tema kalır
        }
        if (wanted !== id) {
          link.remove(); // bu arada başka tema istendi
          return true;
        }
        commitIcons(); // hata verirse aşağıdaki catch yeni bağlantıyı kaldırır, eski tema kalır
        link.media = 'all'; // renk ve yazı tipi ikonlarla aynı anda değişir
        document.getElementById('theme-css')?.remove();
        link.id = 'theme-css';
        root.dataset.theme = current = id;
        changed();
        return true;
      })
      .catch((err) => {
        console.warn(`Tema uygulanamadı (${id}), önceki tema kalıyor:`, err);
        css.then((link) => link?.id !== 'theme-css' && link?.remove());
        return false;
      })
      .finally(() => {
        if (job?.promise === promise) job = null;
      });
    job = { id, promise };
    return promise;
  }

  const known = (id) => (Object.hasOwn(PREVIEW, id) ? id : DEFAULT);
  return {
    get list() {
      return LIST.slice();
    },
    DEFAULT,
    ready,
    apply,
    current: () => current,
    color,
    changed,
    name: (id) => NAMES[known(id)],
    preview: (id) => ({ ...PREVIEW[known(id)] }),
  };
})();
