// Dev rozeti: yalnız dev.* adresinde görünür, canlıda hiçbir şey yapmaz.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'public/dev.js'), 'utf8');

function run(hostname) {
  const added = [];
  const doc = {
    documentElement: { dataset: {} },
    body: { appendChild: (el) => added.push(el) },
    createElement: (tag) => ({ tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
  };
  vm.runInNewContext(code, { location: { hostname }, document: doc });
  return { added, doc };
}

test('dev.agalar.app: DEV rozeti eklenir, ekran okuyucudan gizli', () => {
  const { added, doc } = run('dev.agalar.app');
  assert.equal(added.length, 1);
  const el = added[0];
  assert.equal(el.tag, 'div');
  assert.equal(el.className, 'dev-badge');
  assert.equal(el.textContent, 'DEV');
  assert.equal(el.attrs['aria-hidden'], 'true');
  assert.equal(doc.documentElement.dataset.env, 'dev');
});

test('canlı ve yerel adreslerde rozet yok', () => {
  for (const h of ['agalar.app', 'www.agalar.app', 'localhost', '127.0.0.1', 'devagalar.app', 'x.dev.agalar.app']) {
    const { added, doc } = run(h);
    assert.equal(added.length, 0, h);
    assert.equal(doc.documentElement.dataset.env, undefined, h);
  }
});

test('rozet sayfaya bağlı, stili tema değişkenleriyle ve tıklamayı engellemiyor', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /<script src="\/dev\.js"><\/script>/);
  const css = fs.readFileSync(path.join(ROOT, 'public/css/base.css'), 'utf8');
  const rule = css.match(/\.dev-badge \{[^}]*\}/)?.[0] || '';
  assert.match(rule, /pointer-events: none/);
  assert.match(rule, /position: fixed/);
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(rule), 'sabit renk yok, yalnız değişken');
});
