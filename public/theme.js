// Tema yükleyici. Tema = public/themes/<id>.css (değişken sözleşmesi: css/base.css).
// Varsayılan tema index.html'de <link id="theme-css"> ile baştan bağlıdır; ilk boyama temalı olur.
// Theme.apply(id): tema farklıysa yeni CSS'i yükler, yüklenince (ve ikon seti hazır olunca) eski bağlantıyı
// kaldırır ve <html data-theme> değerini değiştirir. Yarım yüklenmiş tema (yeni renk + eski ikon) görünmez.
// Oda listesi ve giriş ekranı her zaman 'gece'; odada odanın teması.
window.Theme = (() => {
  const LIST = ['gece'];
  const DEFAULT = 'gece';
  const root = document.documentElement;
  let current = root.dataset.theme || DEFAULT;
  let wanted = current;
  let job = null; // { id, promise } süren yükleme

  const href = (id) => `/themes/${id}.css`;

  // İkon seti kancası (Task 2): temanın ikonlarını hazırlar ve bir "uygula" işlevi döndürür.
  // Şimdilik index.html'deki satır içi SVG seti kullanılır; hazırlanacak bir şey yok.
  async function prepareIcons(id) {
    return () => {};
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
  };
})();
