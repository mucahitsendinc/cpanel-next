import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planZip, buildExcludeMatcher, DEFAULT_EXCLUDES } from '../lib/packager.mjs';

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
