import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHooks, hasHooks, HOOK_STAGES } from '../lib/hooks.mjs';

/*
 * Hook tanımı, kullanıcının elle yazdığı tek serbest metin alanı ve doğrudan
 * sunucuda kabuğa gidiyor. Buradaki testler "çalışıyor mu" değil, "bozuk
 * tanımı sessizce kabul ediyor mu" diye soruyor.
 */

test('normal tanım aynen geçer', () => {
  const { hooks, warnings, count } = normalizeHooks({
    preInstall: ['cp .env.production .env'],
    postInstall: ['npx prisma migrate deploy', 'npx prisma generate'],
  });
  assert.deepEqual(hooks.preInstall, ['cp .env.production .env']);
  assert.equal(hooks.postInstall.length, 2);
  assert.equal(count, 3);
  assert.deepEqual(warnings, []);
});

test('tek metin diziye çevrilir — karakter karakter dönmez', () => {
  const { hooks, count } = normalizeHooks({ postInstall: 'npm run migrate' });
  assert.deepEqual(hooks.postInstall, ['npm run migrate']);
  assert.equal(count, 1);
});

test('bilinmeyen aşama adı sessizce yok sayılmaz', () => {
  const { hooks, warnings } = normalizeHooks({ preDeploy: ['echo hi'] });
  assert.deepEqual(hooks, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /preDeploy/);
});

test('metin olmayan komutlar atılır ve uyarı üretir', () => {
  const { hooks, warnings } = normalizeHooks({ postStart: ['curl x', 42, '', null] });
  assert.deepEqual(hooks.postStart, ['curl x']);
  assert.equal(warnings.length, 3);
});

test('hooks nesne değilse tümü reddedilir', () => {
  for (const raw of [['a'], 'x', 5, true]) {
    const { hooks, warnings } = normalizeHooks(raw);
    assert.deepEqual(hooks, {});
    assert.equal(warnings.length, 1);
  }
});

test('hooks yoksa uyarı da yok', () => {
  for (const raw of [null, undefined, {}]) {
    const { hooks, warnings, count } = normalizeHooks(raw);
    assert.deepEqual(hooks, {});
    assert.deepEqual(warnings, []);
    assert.equal(count, 0);
  }
});

test('boş dizi hook sayılmaz', () => {
  const { hooks } = normalizeHooks({ postInstall: [] });
  assert.equal(hasHooks(hooks), false);
});

test('hasHooks her aşamayı tanır', () => {
  for (const stage of HOOK_STAGES) {
    assert.equal(hasHooks({ [stage]: ['echo'] }), true, stage);
  }
  assert.equal(hasHooks({}), false);
  assert.equal(hasHooks(null), false);
});

test('komutlardaki baş/son boşluk kırpılır', () => {
  const { hooks } = normalizeHooks({ preInstall: ['  npm ci  '] });
  assert.deepEqual(hooks.preInstall, ['npm ci']);
});

/* ------------------------------------------------- Laravel hook duraklari */

import { normalizeHooks as nh } from '../lib/hooks.mjs';

test('üç durak da Laravel için tanımlı', () => {
  /*
   * Laravel ve Next AYNI aşama adlarını kullanıyor: tek bir
   * `.cpanel-next.json` biçimi iki çatıya da yetsin, kullanıcı iki ayrı
   * sözlük öğrenmesin.
   */
  const { hooks, count } = nh({
    preInstall: 'echo once',
    postInstall: ['"$PHP" artisan storage:link'],
    postStart: ['"$PHP" artisan queue:restart', '"$PHP" artisan horizon:terminate'],
  });
  assert.equal(count, 4);
  assert.deepEqual(Object.keys(hooks).sort(), ['postInstall', 'postStart', 'preInstall']);
  // Tek metin, tek elemanlı diziye çevriliyor — karakter karakter DEĞİL.
  assert.deepEqual(hooks.preInstall, ['echo once']);
});

test('kullanıcı komutu $PHP ve $APPDIR kullanabiliyor', () => {
  // Bu iki değişken sunucu betiğinde tanımlı; kullanıcının doğru PHP
  // sürümünü tahmin etmesi gerekmiyor.
  const { hooks } = nh({ postStart: '"$PHP" artisan app:rapor --gun=1' });
  assert.match(hooks.postStart[0], /\$PHP/);
});

test('proje ayarı kaydedilirken iç alanlar dosyaya yazılmıyor', async () => {
  /*
   * `loadProjectConfig` okuduğu nesneye `__file`/`__dir` ekliyor. "Oku,
   * değiştir, geri yaz" akışı onları dosyaya taşıyordu — içlerinde makineye
   * özgü mutlak yollar var ve bu dosya commit ediliyor.
   */
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pm = await import('node:path');
  const { saveProjectConfig, loadProjectConfig } = await import('../lib/config.mjs');

  const dir = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'cn-proj-'));
  saveProjectConfig(dir, { framework: 'laravel' });
  const loaded = loadProjectConfig(dir);
  assert.equal('__dir' in loaded, true, 'yükleyici iç alanı ekliyor olmalı');

  saveProjectConfig(dir, { ...loaded, hooks: { postStart: ['echo bitti'] } });
  const raw = JSON.parse(fsm.readFileSync(pm.join(dir, '.cpanel-next.json'), 'utf8'));

  assert.equal('__dir' in raw, false, '__dir dosyaya yazılmamalı');
  assert.equal('__file' in raw, false, '__file dosyaya yazılmamalı');
  assert.equal(raw.framework, 'laravel', 'mevcut ayar korunmalı');
  assert.deepEqual(raw.hooks.postStart, ['echo bitti']);

  fsm.rmSync(dir, { recursive: true, force: true });
});
