// Dev ortamı rozeti: dev.agalar.app dev dalının ön yüzünü canlı sunucu ve veritabanıyla gösterir; canlı siteyle
// karıştırılmasın diye üstte küçük bir "DEV" etiketi çıkar. Canlıda (agalar.app) ve yerelde hiçbir şey yapmaz.
(function devBadge(hostname, doc) {
  if (!/^dev\./.test(hostname)) return;
  const el = doc.createElement('div');
  el.className = 'dev-badge';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = 'DEV';
  doc.body.appendChild(el);
  doc.documentElement.dataset.env = 'dev';
}(location.hostname, document));
