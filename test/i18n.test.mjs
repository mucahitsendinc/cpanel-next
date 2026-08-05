import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, setLocale, getLocale, detectLocale, AVAILABLE } from '../lib/i18n/index.mjs';
import tr from '../lib/i18n/locales/tr.mjs';
import en from '../lib/i18n/locales/en.mjs';

const keys = (o, prefix = '') =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );

test('iki sözlük birebir aynı anahtarlara sahip', () => {
  const a = keys(tr);
  const b = keys(en);
  const onlyTr = a.filter((k) => !b.includes(k));
  const onlyEn = b.filter((k) => !a.includes(k));
  assert.deepEqual(onlyTr, [], `yalnız TR: ${onlyTr.join(', ')}`);
  assert.deepEqual(onlyEn, [], `yalnız EN: ${onlyEn.join(', ')}`);
  assert.ok(a.length > 300, 'sözlük beklenenden küçük');
});

test('desteklenen diller', () => {
  assert.deepEqual(AVAILABLE.sort(), ['en', 'tr']);
});

test('dil değişimi metni değiştirir', () => {
  setLocale('tr');
  const trText = t('deploy.live');
  setLocale('en');
  const enText = t('deploy.live');
  assert.notEqual(trText, enText);
  assert.equal(enText, 'Live.');
});

test('yer tutucular doldurulur', () => {
  setLocale('en');
  const out = t('guards.docrootClash', { name: 'shop', docroot: '/home/u/shop' });
  assert.match(out, /shop/);
  assert.match(out, /\/home\/u\/shop/);
  assert.ok(!out.includes('{'), 'doldurulmamış yer tutucu kalmış');
});

test('eksik parametre yer tutucuyu bozmadan bırakır', () => {
  setLocale('en');
  const out = t('guards.docrootClash', { name: 'shop' });
  assert.match(out, /\{docroot\}/, 'eksik parametre görünür kalmalı ki fark edilsin');
});

test('dizi değerler dizi olarak döner (tablo başlıkları)', () => {
  // String()'e çevrilirse tablo başlıkları tek bir virgüllü metne dönüşür
  // ve `headers.map is not a function` ile patlar.
  setLocale('en');
  const h = t('apps.headers');
  assert.ok(Array.isArray(h));
  assert.ok(h.length >= 5);
  assert.equal(typeof h[0], 'string');
});

test('bilinmeyen anahtar sessizce kaybolmaz', () => {
  setLocale('en');
  assert.equal(t('yok.boyle.bir.anahtar'), 'yok.boyle.bir.anahtar');
});

test('bilinmeyen dil İngilizceye düşer', () => {
  assert.equal(setLocale('zz'), 'en');
  assert.equal(getLocale(), 'en');
});

test('yerel tespiti ortam değişkeninden okur', () => {
  assert.equal(detectLocale('tr'), 'tr');
  assert.equal(detectLocale('tr_TR.UTF-8'), 'tr');
  assert.equal(detectLocale('en_US.UTF-8'), 'en');
  assert.equal(detectLocale('de_DE.UTF-8'), 'en', 'desteklenmeyen dil İngilizceye düşmeli');
});

test('kritik uyarı metinleri iki dilde de dolu', () => {
  // Bunlar kullanıcıyı veri kaybından koruyan metinler; boş kalamazlar.
  for (const key of [
    'guards.notOwned',
    'guards.notOwnedHint',
    'deploy.destructiveWarn',
    'deploy.confirmMismatch',
    'common.typeToConfirm',
    'vault.wrongPassword',
  ]) {
    for (const lang of ['tr', 'en']) {
      setLocale(lang);
      const v = t(key, { appRoot: 'x', name: 'x', given: 'y', expected: 'x' });
      assert.notEqual(v, key, `${lang}/${key} çevrilmemiş`);
      assert.ok(v.length > 5, `${lang}/${key} çok kısa`);
    }
  }
  setLocale('en');
});
