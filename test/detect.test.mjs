import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProject } from '../lib/detect.mjs';
import { setLocale } from '../lib/i18n/index.mjs';

setLocale('en');

/*
 * Buradaki her blocker gerçek bir arıza senaryosundan geliyor, temkinden değil.
 * Bir blocker sessizce kaybolursa kullanıcı sunucuda patlayan bir uygulama
 * bulur ve sebebini bulamaz — o yüzden hepsi teste bağlı.
 */

const roots = [];
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-detect-'));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
const pkg = (o) => JSON.stringify({ name: 't', ...o });

after(() => roots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('geçerli Next.js projesi tanınır', () => {
  const d = project({
    'package.json': pkg({ dependencies: { next: '16.3.0' }, scripts: { build: 'next build' } }),
    'app/page.js': '',
    'package-lock.json': '{}',
  });
  const r = detectProject(d);
  assert.equal(r.framework, 'nextjs');
  assert.equal(r.router, 'app');
  assert.equal(r.nextVersion, '16.3.0');
  assert.equal(r.deployable, true);
  assert.deepEqual(r.blockers, []);
});

test('pages router ve src/ dizini tanınır', () => {
  const d = project({
    'package.json': pkg({ dependencies: { next: '14.2.0' }, scripts: { build: 'next build' } }),
    'src/pages/index.js': '',
    'package-lock.json': '{}',
  });
  const r = detectProject(d);
  assert.equal(r.router, 'pages');
  assert.equal(r.srcDir, true);
});

test('next bağımlılığı yoksa yayınlanamaz', () => {
  const d = project({ 'package.json': pkg({ scripts: { build: 'vite build' } }) });
  const r = detectProject(d);
  assert.equal(r.deployable, false);
  assert.match(r.blockers.join(' '), /next/i);
});

test('build betiği yoksa yayınlanamaz', () => {
  const d = project({ 'package.json': pkg({ dependencies: { next: '16.0.0' } }) });
  const r = detectProject(d);
  assert.equal(r.deployable, false);
  assert.match(r.blockers.join(' '), /build/i);
});

test("output: 'standalone' engellenir", () => {
  // Next'in kendi dokümanı: standalone ile özel server birlikte kullanılamaz,
  // Passenger ise özel server gerektiriyor.
  const d = project({
    'package.json': pkg({ dependencies: { next: '16.0.0' }, scripts: { build: 'next build' } }),
    'next.config.mjs': "export default { output: 'standalone' }",
    'app/page.js': '',
  });
  const r = detectProject(d);
  assert.equal(r.standalone, true);
  assert.equal(r.deployable, false);
  assert.match(r.blockers.join(' '), /standalone/i);
});

test('Next 13.4.x engellenir, 13.5.6 geçer', () => {
  // 13.4 router-server ikinci bir http.Server açıyor; Passenger
  // "listen() was called more than once" ile patlıyor.
  const broken = project({
    'package.json': pkg({ dependencies: { next: '13.4.19' }, scripts: { build: 'next build' } }),
    'app/page.js': '',
  });
  assert.equal(detectProject(broken).deployable, false);
  assert.match(detectProject(broken).blockers.join(' '), /13\.4/);

  const fixed = project({
    'package.json': pkg({ dependencies: { next: '13.5.6' }, scripts: { build: 'next build' } }),
    'app/page.js': '',
  });
  assert.equal(detectProject(fixed).deployable, true);
});

test('"type": "module" ise başlangıç dosyası server.cjs olur', () => {
  // Passenger ESM yükleyemiyor; .js dosyası ESM sayılır ve ERR_REQUIRE_ESM verir.
  const d = project({
    'package.json': pkg({
      type: 'module',
      dependencies: { next: '16.0.0' },
      scripts: { build: 'next build' },
    }),
    'app/page.js': '',
  });
  const r = detectProject(d);
  assert.equal(r.isEsm, true);
  assert.equal(r.startupFile, 'server.cjs');
  assert.equal(r.deployable, true);
});

test('CommonJS projede başlangıç dosyası server.js', () => {
  const d = project({
    'package.json': pkg({ dependencies: { next: '16.0.0' }, scripts: { build: 'next build' } }),
    'app/page.js': '',
  });
  assert.equal(detectProject(d).startupFile, 'server.js');
});

test('mevcut server.js tanınır', () => {
  const d = project({
    'package.json': pkg({ dependencies: { next: '16.0.0' }, scripts: { build: 'next build' } }),
    'app/page.js': '',
    'server.js': '',
  });
  assert.equal(detectProject(d).hasServerJs, true);
});

test('Laravel projesi tanınır ve yayınlanabilir', () => {
  const d = project({
    'composer.json': '{"require":{"laravel/framework":"^11.9"}}',
    'composer.lock': '{"packages":[]}',
    artisan: '',
    'public/index.php': '<?php',
  });
  const r = detectProject(d);
  assert.equal(r.framework, 'laravel');
  assert.equal(r.laravelVersion, '11.9');
  assert.equal(r.deployable, true);
  // Laravel'i Passenger değil sunucunun PHP işleyicisi çalıştırıyor.
  assert.equal(r.startupFile, null);
});

test('composer.lock yoksa Laravel yayınlanamaz', () => {
  // Onsuz "lock değişmediyse vendor gönderme" kararı verilemez ve sunucudaki
  // sürümler yereldekinden kayabilir.
  const d = project({
    'composer.json': '{"require":{"laravel/framework":"^11"}}',
    artisan: '',
    'public/index.php': '<?php',
  });
  const r = detectProject(d);
  assert.equal(r.deployable, false);
  assert.match(r.blockers.join(' '), /composer\.lock/);
});

test('public/index.php yoksa Laravel sayılmaz', () => {
  const d = project({ 'composer.json': '{}', 'composer.lock': '{}', artisan: '' });
  assert.equal(detectProject(d).deployable, false);
});

test('package.json olan Laravel yine Laravel sayılır — Next değil', () => {
  // Vite/Mix kullanan her Laravel projesinde package.json var; belirleyici
  // olan `artisan` + `composer.json` ikilisi.
  const d = project({
    'composer.json': '{"require":{"laravel/framework":"^11"}}',
    'composer.lock': '{}',
    artisan: '',
    'public/index.php': '<?php',
    'vite.config.js': '',
    'package.json': pkg({ devDependencies: { vite: '^5' }, scripts: { build: 'vite build' } }),
  });
  const r = detectProject(d);
  assert.equal(r.framework, 'laravel');
  assert.equal(r.assetBuilder, 'vite');
  assert.match(r.warnings.join(' '), /public\/build|vite/);
});

test('lockfile yoksa uyarı verilir ama engellenmez', () => {
  const d = project({
    'package.json': pkg({ dependencies: { next: '16.0.0' }, scripts: { build: 'next build' } }),
    'app/page.js': '',
  });
  const r = detectProject(d);
  assert.equal(r.deployable, true);
  assert.match(r.warnings.join(' '), /lockfile/i);
});

test('package.json olmayan dizin reddedilir', () => {
  const d = project({ 'readme.txt': 'x' });
  assert.equal(detectProject(d).deployable, false);
});
