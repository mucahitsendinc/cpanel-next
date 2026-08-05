import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAppRoot, inspectOwnership, isDestructive, PROTECTED_NAMES } from '../lib/guards.mjs';
import { setLocale } from '../lib/i18n/index.mjs';

setLocale('en');

/*
 * Bu dosya aracın en tehlikeli yüzeyini kilitler.
 *
 * `assertAppRoot` geçerse hedef klasörün içeriği SİLİNİR. Buradaki her vaka,
 * yanlış geçtiğinde yayında bir sitenin gitmesi demek — bu yüzden testler
 * "çalışıyor mu" değil, "reddetmesi gerekeni reddediyor mu" diye soruyor.
 */

const DOCROOTS = ['public_html', 'shop.example.com', '/home/u/addon.example.com'];

test('geçerli app-root adları kabul edilir', () => {
  for (const name of ['magazanext', 'app1', 'my-app_2.0', 'a', 'A9']) {
    assert.equal(assertAppRoot(name, { docroots: DOCROOTS }), name);
  }
});

test('hesap altyapısına ait adlar reddedilir', () => {
  for (const name of ['public_html', 'mail', 'etc', 'logs', 'ssl', 'nodevenv', 'tmp']) {
    assert.throws(() => assertAppRoot(name, { docroots: [] }), /protected/i, name);
  }
  // Liste kod ile senkron kalsın: biri elle silinirse test düşsün.
  assert.ok(PROTECTED_NAMES.has('public_html'));
  assert.ok(PROTECTED_NAMES.has('nodevenv'));
});

test('yol kaçışı REDDEDİLİR, sessizce temizlenmez', () => {
  // `../../etc` girdisinden karakter ayıklamak onu `....etc` yapar; yani
  // başka bir hataya çevirir, düzeltmez. Hata vermek zorunda.
  for (const bad of ['../../etc', 'a/b', './x', 'a\\b', '..']) {
    assert.throws(() => assertAppRoot(bad, { docroots: [] }), /invalid|protected/i, bad);
  }
});

test('nokta ile başlayan adlar reddedilir', () => {
  for (const bad of ['.ssh', '.cpanel', '.hidden']) {
    assert.throws(() => assertAppRoot(bad, { docroots: [] }), /dot|protected/i, bad);
  }
});

test('boş ve biçimsiz adlar reddedilir', () => {
  for (const bad of ['', '   ', '-leading', '_leading', 'a'.repeat(65)]) {
    assert.throws(() => assertAppRoot(bad, { docroots: [] }), bad || '(boş)');
  }
});

test('bir domainin belge kökü app-root olamaz', () => {
  // Aksi hâlde Next kaynağı ve .env doğrudan internete açılırdı.
  assert.throws(() => assertAppRoot('shop.example.com', { docroots: DOCROOTS }), /document root/i);
  assert.throws(() => assertAppRoot('public_html', { docroots: DOCROOTS }), /protected|document root/i);
});

test('--force korumalı adları AÇMAZ', () => {
  // force yalnızca docroot çakışmasını geçebilir; altyapı adları asla açılmaz.
  assert.throws(() => assertAppRoot('mail', { docroots: [], force: true }), /force/i);
  assert.equal(assertAppRoot('shop.example.com', { docroots: DOCROOTS, force: true }), 'shop.example.com');
});

/* ----------------------------------------------------------- sahiplik */

const fakeClient = (marker) => ({
  user: 'u',
  uapiPost: async () => ({ content: marker ? JSON.stringify(marker) : null }),
});

test('yeni klasör: durum "new"', async () => {
  const r = await inspectOwnership(fakeClient(null), 'newapp', { dirExists: false });
  assert.equal(r.state, 'new');
});

test('bu araçla yayınlanmış klasör tanınır', async () => {
  const r = await inspectOwnership(fakeClient({ tool: 'cpanel-next', v: 1 }), 'mynext', {
    dirExists: true,
  });
  assert.equal(r.state, 'owned');
  assert.equal(r.marker.tool, 'cpanel-next');
});

test('işareti olmayan klasör ENGELLENMEZ, yalnızca bildirilir', async () => {
  // Eskiden burası hata fırlatıyordu ve kullanıcı her güncellemede --adopt
  // yazmak zorunda kalıyordu. Koruma artık yazarak onay + yedekte.
  const r = await inspectOwnership(fakeClient(null), 'elle-kurulmus', { dirExists: true });
  assert.equal(r.state, 'foreign');
});

test('başka bir aracın işareti de engellemez', async () => {
  const r = await inspectOwnership(fakeClient({ tool: 'some-other-tool' }), 'x', { dirExists: true });
  assert.equal(r.state, 'foreign');
});

test('BAŞKA domaine bağlı klasör ayrıca işaretlenir', async () => {
  // Asıl tehlikeli durum: adını doğru yazmış olsanız bile büyük ihtimalle
  // yanlış klasörü seçtiniz.
  const apps = [{ path: 'panelnext', domain: 'panel.baska.com' }];
  const r = await inspectOwnership(fakeClient(null), 'panelnext', {
    dirExists: true,
    apps,
    domain: 'benim.com',
  });
  assert.equal(r.state, 'other-domain');
  assert.equal(r.app.domain, 'panel.baska.com');
});

test('aynı domaine bağlı klasör olağan sayılır', async () => {
  const apps = [{ path: 'mynext', domain: 'benim.com' }];
  const r = await inspectOwnership(fakeClient(null), 'mynext', {
    dirExists: true,
    apps,
    domain: 'benim.com',
  });
  assert.equal(r.state, 'foreign');
});

test('yıkıcılık tanımı', () => {
  assert.equal(isDestructive({ dirExists: false, adopt: false, force: false }), false);
  assert.equal(isDestructive({ dirExists: true }), true);
  assert.equal(isDestructive({ dirExists: false, adopt: true }), true);
  assert.equal(isDestructive({ dirExists: false, force: true }), true);
});
