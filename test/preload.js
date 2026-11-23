// Test sunucusu: .env yok, Supabase yok, "test:<ad>" belirteçleri kabul edilir.
// Sunucu bu worktree'de ASLA bu dosya olmadan çalıştırılmaz (canlı veritabanına bağlanır).
process.loadEnvFile = () => {};
for (const k of Object.keys(process.env)) if (/SUPABASE|TURN|CF_/.test(k)) delete process.env[k];
const Module = require('module');
const orig = Module._load;
// accounts.js keyOf'u henüz dışa aktarmıyor; aynı kuralla burada yeniden yazılır.
const keyOf = (name) => name.toLocaleLowerCase('tr-TR');
Module._load = function (req, ...rest) {
  const m = orig.call(this, req, ...rest);
  if (req === './accounts' && !m.__t) {
    const a = m.accountByToken;
    m.accountByToken = (t) => (typeof t === 'string' && t.startsWith('test:') ? { key: keyOf(t.slice(5)), name: t.slice(5) } : a(t));
    m.seen = () => {};
    const setup = m.setup;
    m.setup = (app, opts) => {
      app.get('/auth/me', (req, res, next) => {
        const t = req.get('authorization')?.replace(/^Bearer /, '') || '';
        if (!t.startsWith('test:')) return next();
        res.json({ name: t.slice(5), avatar: null, admin: Boolean(m.isAdmin?.(keyOf(t.slice(5)))) });
      });
      return setup(app, opts);
    };
    m.__t = true;
  }
  if (req === './rooms' && !m.__t) {
    addTestTheme(m);
    m.__t = true;
  }
  return m;
};

// Denemelik ikinci tema (canlı tema değişimini denemek için): yalnız bu önyüklemeyle çalışan sunucuda vardır.
// Dosyası test/tools/themes/deneme.css; public/ altında değildir, public/theme.js ve rooms.js listelerine yazılmaz.
// İkon seti: Lucide'in kalın, köşeli çizgili bir kopyası (dosya tutulmaz, istekte üretilir), değişim gözle görülsün.
function addTestTheme(rooms) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  rooms.THEMES.push('deneme');
  rooms.THEME_INFO.deneme = {
    name: 'Deneme (test)',
    icons: 'deneme',
    preview: { bg: '#F4F1EA', surface: '#FFFFFF', text: '#1F2328', accent: '#C2410C' },
  };
  const setup = rooms.setup;
  rooms.setup = (app, opts) => {
    app.get('/themes/deneme.css', (req, res) => res.type('css').sendFile(path.join(ROOT, 'test/tools/themes/deneme.css')));
    app.get('/icons/ui/deneme.svg', (req, res) => {
      const svg = fs.readFileSync(path.join(ROOT, 'public/icons/ui/lucide.svg'), 'utf8')
        .replace(/(<symbol [^>]*>)/g, '$1<g stroke-width="3" stroke-linecap="square" stroke-linejoin="miter">')
        .replace(/<\/symbol>/g, '</g></symbol>');
      res.type('image/svg+xml').send(svg);
    });
    return setup(app, opts);
  };
}
