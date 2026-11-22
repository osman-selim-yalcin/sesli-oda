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
  return m;
};
