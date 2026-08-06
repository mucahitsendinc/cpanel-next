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
