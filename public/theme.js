// Tema yükleyici. Tema = public/themes/<id>.css (değişken sözleşmesi: css/base.css).
// Varsayılan tema index.html'de <link id="theme-css"> ile baştan bağlıdır; ilk boyama temalı olur.
// Theme.apply(id): tema farklıysa yeni CSS'i yükler, yüklenince (ve ikon seti hazır olunca) eski bağlantıyı
// kaldırır ve <html data-theme> değerini değiştirir. Yarım yüklenmiş tema (yeni renk + eski ikon) görünmez.
// Oda listesi ve giriş ekranı her zaman 'gece'; odada odanın teması.
window.Theme = (() => {
  const LIST = ['gece'];
  const DEFAULT = 'gece';
  // Temanın ikon seti: public/icons/ui/<set>.svg, hepsi aynı adları (i-play, i-mic…) taşır.
  // Varsayılan set index.html'de <svg id="ui-icons" data-set="lucide"> olarak gömülüdür (ilk boyamada ikon olsun diye).
  const ICON_SETS = { gece: 'lucide' };
  // Oda kartındaki tema önizleme şeridinin üç rengi (zemin, panel, vurgu). Kart başka bir temanın odasını da
  // gösterebildiği için bu renkler o anki temanın değişkenlerinden değil, bu tablodan gelir; sabit renkler
  // yalnız burada durur (kart onları --pv-bg/--pv-surface/--pv-accent yerel değişkenleriyle kullanır).
  const PREVIEW = {
    gece: { bg: '#0E0F13', surface: '#1E2129', accent: '#8B9CFF' },
  };
  const root = document.documentElement;
  let current = root.dataset.theme || DEFAULT;
  let wanted = current;
  let job = null; // { id, promise } süren yükleme

  const href = (id) => `/themes/${id}.css`;

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

  function loadCss(id) {
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
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

  // Tarayıcı çubuğunun rengi temanın zeminine uyar.
  function syncMeta() {
    const meta = document.querySelector('meta[name="theme-color"]');
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (meta && bg) meta.content = bg;
  }

  function apply(id) {
    if (!LIST.includes(id)) id = DEFAULT;
    wanted = id;
    const linked = document.getElementById('theme-css')?.dataset.theme;
    if (id === linked) {
      root.dataset.theme = current = id;
      return job?.promise ?? Promise.resolve();
    }
    if (job?.id === id) return job.promise;
    const css = loadCss(id);
    // apply hiçbir zaman reddetmez: ikon ya da yükleme hatasında uyarı yazılır, önceki tema kalır.
    const promise = Promise.all([css, prepareIcons(id)])
      .then(([link, commitIcons]) => {
        if (!link) return; // yüklenemedi: eski tema kalır
        if (wanted !== id) return link.remove(); // bu arada başka tema istendi
        commitIcons(); // hata verirse aşağıdaki catch yeni bağlantıyı kaldırır, eski tema kalır
        document.getElementById('theme-css')?.remove();
        link.id = 'theme-css';
        root.dataset.theme = current = id;
        syncMeta();
      })
      .catch((err) => {
        console.warn(`Tema uygulanamadı (${id}), önceki tema kalıyor:`, err);
        css.then((link) => link?.id !== 'theme-css' && link?.remove());
      })
      .finally(() => {
        if (job?.promise === promise) job = null;
      });
    job = { id, promise };
    return promise;
  }

  return {
    list: LIST.slice(),
    apply,
    current: () => current,
    preview: (id) => ({ ...(Object.hasOwn(PREVIEW, id) ? PREVIEW[id] : PREVIEW[DEFAULT]) }),
  };
})();
