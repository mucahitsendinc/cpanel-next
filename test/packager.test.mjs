import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planZip, buildExcludeMatcher, DEFAULT_EXCLUDES , isBlockedDotDir, isToolDirectory} from '../lib/packager.mjs';

/*
 * DOTENV SIZINTISI — bu dosyanın var olma sebebi.
 *
 * Aynı hattın önceki sürümünde `.env` tam eşleşmeyle dışlanıyordu ve anahtar
 * rotasyonundan kalan `.env.bak-rotasyon-20260803-122228` (gerçek .env'in
 * birebir kopyası: DB, ödeme ve imza anahtarları) desene uymadığı için ÜÇ
 * yayınlanmış pakete girdi.
 *
 * Yedek dosya adı serbest metindir; `.env.bak*`, `.env.save`, `.env.old`,
 * `.env.2026-08-03` diye tek tek kovalamak kapanmayan bir listedir. Bu yüzden
 * kural izin listesidir: dotenv ailesinden olup ADI GEÇMEYEN her dosya elenir.
 */

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-test-'));
  const w = (rel, content = 'x') => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('package.json', '{"name":"t"}');
  w('server.js');
  w('app/page.js');
  w('.next/BUILD_ID');
  w('.next/static/chunk.js');
  // elenmesi gerekenler
  w('.next/cache/big.bin');
  w('node_modules/left-pad/index.js');
  w('.git/config');
  w('.env', 'SECRET=1');
  w('.env.local', 'SECRET=2');
  w('.env.production', 'SECRET=3');
  w('.env.bak-rotasyon-20260803-122228', 'SECRET=leak');
  w('.env.save');
  w('env.production.orig');
  w('dump.sql', 'DROP TABLE');
  w('backup.zip');
  w('data.sqlite');
  w('.DS_Store');
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('hiçbir dotenv dosyası pakete girmez', () => {
  const plan = planZip(dir, { excludes: DEFAULT_EXCLUDES, allowEnv: [] });
  const leaked = plan.included.filter((f) => path.basename(f).startsWith('.env'));
  assert.deepEqual(leaked, [], `sızan dotenv dosyaları: ${leaked.join(', ')}`);
});

test('yedek adlı dotenv dosyası da elenir (asıl olay)', () => {
  const plan = planZip(dir, { excludes: DEFAULT_EXCLUDES, allowEnv: [] });
  assert.ok(plan.skippedEnv.includes('.env.bak-rotasyon-20260803-122228'));
  assert.ok(plan.skippedEnv.includes('.env.save'));
  assert.ok(plan.skippedEnv.includes('.env.production'));
});

test('izin listesindeki dotenv dosyası geçebilir', () => {
  const plan = planZip(dir, { excludes: DEFAULT_EXCLUDES, allowEnv: ['.env.local'] });
  assert.ok(plan.included.includes('.env.local'));
  assert.ok(!plan.included.includes('.env'));
});

test('node_modules, .git ve .next/cache gönderilmez', () => {
  const plan = planZip(dir, { excludes: DEFAULT_EXCLUDES, allowEnv: [] });
  for (const bad of ['node_modules/', '.git/', '.next/cache/']) {
    assert.ok(
      !plan.included.some((f) => f.startsWith(bad)),
      `${bad} pakete girmiş`
    );
  }
});

test('veritabanı ve arşiv dosyaları gönderilmez', () => {
  const plan = planZip(dir, { excludes: DEFAULT_EXCLUDES, allowEnv: [] });
  for (const bad of ['dump.sql', 'backup.zip', 'data.sqlite', '.DS_Store']) {
    assert.ok(!plan.included.includes(bad), `${bad} pakete girmiş`);
  }
});

test('uygulama dosyaları ve build çıktısı gönderilir', () => {
  const plan = planZip(dir, { excludes: DEFAULT_EXCLUDES, allowEnv: [] });
  for (const need of ['package.json', 'server.js', 'app/page.js', '.next/BUILD_ID', '.next/static/chunk.js']) {
    assert.ok(plan.included.includes(need), `${need} pakete girmemiş`);
  }
});

/* ---------------------------------------------------------- desen motoru */

test('exclude deseni: dizin, uzantı ve tek seviye', () => {
  const m = buildExcludeMatcher(['node_modules/**', '*.log', 'a/b/*.tmp']);
  assert.ok(m('node_modules/x/y.js'));
  assert.ok(m('node_modules'));
  assert.ok(m('deep/nested/file.log'), 'uzantı deseni her derinlikte eşleşmeli');
  assert.ok(m('a/b/c.tmp'));
  assert.equal(m('a/b/c/d.tmp'), null, 'tek yıldız alt dizine inmemeli');
  assert.equal(m('src/index.js'), null);
});

test('exclude deseni benzer adlı dizini yanlışlıkla yakalamaz', () => {
  const m = buildExcludeMatcher(['test/**']);
  assert.ok(m('test/a.js'));
  assert.equal(m('tests-utils/a.js'), null);
});

/* ------------------------------------------------------------------------ *
 * Sürüm sabitleme
 *
 * Canlı bir hesapta bulunan arıza: build yerelde next 16.1.1 ile koşuyor,
 * sunucuda `^16.1.1` 16.3.0 çekiyor ve 16.1.1 için derlenmiş `.next`'i 16.3.0
 * çalıştırınca uygulama çerçevenin İÇİNDE `undefined.map` ile çöküyor. Yığın
 * izi `at ignore-listed frames` diyor, yani kullanıcı hiçbir ipucu göremiyor.
 * ------------------------------------------------------------------------ */

import { pinToLockfile } from '../lib/packager.mjs';

function fixture(pkg, lock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  if (lock) fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
  return dir;
}

const LOCK = {
  packages: {
    'node_modules/next': { version: '16.1.1' },
    'node_modules/react': { version: '19.2.3' },
    'node_modules/typescript': { version: '5.9.2' },
  },
};

test('caret aralıkları lockfile sürümüne sabitleniyor', () => {
  const dir = fixture(
    { dependencies: { next: '^16.1.1', react: '^19.2.3' }, devDependencies: { typescript: '~5.9.0' } },
    LOCK
  );
  const out = pinToLockfile(dir);
  const pkg = JSON.parse(out.content);
  assert.equal(pkg.dependencies.next, '16.1.1');
  assert.equal(pkg.dependencies.react, '19.2.3');
  assert.equal(pkg.devDependencies.typescript, '5.9.2');
  assert.equal(out.pinned.length, 3);
});

test('lockfile yoksa sabitleme yapılmıyor', () => {
  const dir = fixture({ dependencies: { next: '^16.1.1' } }, null);
  assert.equal(pinToLockfile(dir), null);
});

test('zaten kesin olan sürümler değiştirilmiyor', () => {
  const dir = fixture({ dependencies: { next: '16.1.1', react: '19.2.3' } }, LOCK);
  assert.equal(pinToLockfile(dir), null, 'değişiklik yoksa null dönmeli');
});

test('file:/link:/git+ tanımlarına DOKUNULMUYOR', () => {
  /*
   * Bunların üzerine kesin sürüm yazmak bağımlılığı başka bir pakete çevirir —
   * yerel bir paketi npm kayıtındaki aynı adlı pakete. Sessiz ve yıkıcı olurdu.
   */
  const dir = fixture(
    {
      dependencies: {
        next: '^16.1.1',
        yerel: 'file:../yerel',
        bagli: 'link:../bagli',
        depo: 'git+https://github.com/x/y.git',
        takma: 'npm:baska-paket@^1.0.0',
      },
    },
    {
      packages: {
        'node_modules/next': { version: '16.1.1' },
        'node_modules/yerel': { version: '1.0.0' },
        'node_modules/bagli': { version: '2.0.0' },
        'node_modules/depo': { version: '3.0.0' },
        'node_modules/takma': { version: '4.0.0' },
      },
    }
  );
  const pkg = JSON.parse(pinToLockfile(dir).content);
  assert.equal(pkg.dependencies.next, '16.1.1', 'sürüm aralığı sabitlenmeli');
  assert.equal(pkg.dependencies.yerel, 'file:../yerel');
  assert.equal(pkg.dependencies.bagli, 'link:../bagli');
  assert.equal(pkg.dependencies.depo, 'git+https://github.com/x/y.git');
  assert.equal(pkg.dependencies.takma, 'npm:baska-paket@^1.0.0');
});

test('lockfile bozuksa deploy durmuyor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"next":"^16.1.1"}}');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{ bozuk json');
  assert.equal(pinToLockfile(dir), null);
});

test('lockfile’da olmayan bağımlılık atlanıyor', () => {
  const dir = fixture({ dependencies: { next: '^16.1.1', bilinmeyen: '^1.0.0' } }, LOCK);
  const pkg = JSON.parse(pinToLockfile(dir).content);
  assert.equal(pkg.dependencies.next, '16.1.1');
  assert.equal(pkg.dependencies.bilinmeyen, '^1.0.0', 'kilitte yoksa dokunulmamalı');
});

test('package.json’ın diğer alanları korunuyor', () => {
  const dir = fixture(
    { name: 'frontend', type: 'module', scripts: { build: 'next build' }, dependencies: { next: '^16.1.1' } },
    LOCK
  );
  const pkg = JSON.parse(pinToLockfile(dir).content);
  assert.equal(pkg.name, 'frontend');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts.build, 'next build');
});

/* --------------------------------------------- araç klasörleri: ad değil kural */

test('izin verilmeyen noktalı klasörler pakete girmiyor', () => {
  // Ad listesi kapanmayan bir listeydi: her yeni araç kendi noktalı klasörünü
  // bırakıyor ve listeye eklenene kadar sunucuya gidiyordu.
  for (const name of ['.vscode', '.idea', '.git', '.turbo', '.vercel', '.github', '.yarn', '.nx']) {
    assert.equal(isBlockedDotDir(name), true, name);
  }
});

test('build çıktısı ve doğrulama klasörü İZİNLİ', () => {
  // `.next` gitmezse uygulama çalışmaz; `.well-known` gitmezse alan doğrulama
  // ve AutoSSL kırılır.
  assert.equal(isBlockedDotDir('.next'), false);
  assert.equal(isBlockedDotDir('.well-known'), false);
});

test('noktalı DOSYALAR elenmiyor', () => {
  // Dosyalar bu kuraldan hiç geçmiyor; kural yalnızca dizin bileşenlerine
  // uygulanıyor.
  assert.equal(isToolDirectory('.htaccess'), false);
  assert.equal(isToolDirectory('public/.htaccess'), false);
  assert.equal(isToolDirectory('storage/logs/.gitignore'), false);
});

test('araç klasörünün ALTINDAKİ dosyalar da eleniyor', () => {
  assert.equal(isToolDirectory('.vscode/settings.json'), true);
  assert.equal(isToolDirectory('a/.idea/workspace.xml'), true);
});

test('.next altındaki derin yollar korunuyor', () => {
  // Tam yola bakan ilk sürüm `.next/static`'i eledi ve build çıktısının
  // yarısı pakete hiç girmedi.
  assert.equal(isToolDirectory('.next/static/chunks/app.js'), false);
  assert.equal(isToolDirectory('.next/server/pages/index.js'), false);
});
