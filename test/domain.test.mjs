import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDomain, normalize , toHomeRelative } from '../lib/domain.mjs';
import { setLocale } from '../lib/i18n/index.mjs';

setLocale('en');

/*
 * Domain çözümlemesi, "hangi klasörün üzerine yazılacağını" belirleyen ilk
 * adım. Yanlış bir docroot varsayımı sessiz veri kaybı üretir; bu yüzden
 * addon domain vakası burada özellikle test ediliyor.
 */

const DOMAINS = [
  { domain: 'example.com', type: 'main', docroot: '/home/u/public_html' },
  // Addon domainin docroot'u `/home/u/<domain>` DEĞİL — varsaymak hata.
  { domain: 'addon.com', type: 'addon', docroot: '/home/u/public_html/addon' },
  { domain: 'shop.example.com', type: 'sub', docroot: '/home/u/shop.example.com' },
  { domain: 'old.example.com', type: 'parked', docroot: null },
];

const client = {}; // cached verildiğinde istemciye hiç dokunulmuyor

test('ana domain çözümlenir', async () => {
  const r = await resolveDomain(client, 'example.com', DOMAINS);
  assert.equal(r.kind, 'existing');
  assert.equal(r.type, 'main');
  assert.equal(r.docroot, '/home/u/public_html');
});

test('addon domainin docroot’u API’den gelir, varsayılmaz', async () => {
  const r = await resolveDomain(client, 'addon.com', DOMAINS);
  assert.equal(r.kind, 'existing');
  assert.equal(r.docroot, '/home/u/public_html/addon');
  assert.notEqual(r.docroot, '/home/u/addon.com');
});

test('mevcut subdomain çözümlenir', async () => {
  const r = await resolveDomain(client, 'shop.example.com', DOMAINS);
  assert.equal(r.kind, 'existing');
  assert.equal(r.type, 'sub');
});

test('park edilmiş domain yayına uygun değil', async () => {
  const r = await resolveDomain(client, 'old.example.com', DOMAINS);
  assert.equal(r.kind, 'parked');
  assert.match(r.reason, /parked/i);
});

test('üst bölge varsa yeni subdomain önerilir', async () => {
  const r = await resolveDomain(client, 'yeni.example.com', DOMAINS);
  assert.equal(r.kind, 'new-subdomain');
  assert.equal(r.subLabel, 'yeni');
  assert.equal(r.rootDomain, 'example.com');
  assert.equal(r.docroot, 'yeni.example.com');
});

test('çok seviyeli subdomain için en yakın kök seçilir', async () => {
  const r = await resolveDomain(client, 'a.shop.example.com', DOMAINS);
  assert.equal(r.kind, 'new-subdomain');
  assert.equal(r.rootDomain, 'shop.example.com');
  assert.equal(r.subLabel, 'a');
});

test('park edilmiş domain üst bölge olarak kullanılmaz', async () => {
  const r = await resolveDomain(client, 'x.old.example.com', DOMAINS);
  // old.example.com park edilmiş; bir üst geçerli bölge example.com olmalı.
  assert.equal(r.kind, 'new-subdomain');
  assert.equal(r.rootDomain, 'example.com');
  assert.equal(r.subLabel, 'x.old');
});

test('hesapta olmayan domain bulunamadı döner', async () => {
  const r = await resolveDomain(client, 'baska-site.com', DOMAINS);
  assert.equal(r.kind, 'not-found');
});

test('boş domain reddedilir', async () => {
  await assert.rejects(() => resolveDomain(client, '', DOMAINS));
  await assert.rejects(() => resolveDomain(client, '   ', DOMAINS));
});

test('kullanıcı girdisi normalleştirilir', () => {
  assert.equal(normalize('https://Example.COM/yol'), 'example.com');
  assert.equal(normalize('  www.example.com  '), 'example.com');
  assert.equal(normalize('example.com.'), 'example.com');
});

test('www ile yazılan domain de eşleşir', async () => {
  const r = await resolveDomain(client, 'www.example.com', DOMAINS);
  assert.equal(r.kind, 'existing');
});

/* ------------------------------------------------- belge kökü normalleştirme */

/*
 * ⚠ cPanel `documentroot` alanını MUTLAK yol döndürüyor. Aracın geri kalanı
 * ev dizinine göreli bekliyor ve bu uyuşmazlık canlıda iki arızaya yol açtı:
 * Laravel yayını `/home/u/home/u/site.com` adresine yazmaya çalıştı, ve
 * `assertAppRoot`'un belge kökü çakışma denetimi hiç eşleşmedi — yani kaynak
 * kodu yayına açık bir dizine koymayı engelleyen kontrol sessizce kapalıydı.
 */

test('mutlak belge kökü ev dizinine göreli hâle geliyor', () => {
  assert.equal(toHomeRelative('/home/bimtest/tests.example.com', 'bimtest'), 'tests.example.com');
  assert.equal(toHomeRelative('/home/bimtest/public_html', 'bimtest'), 'public_html');
});

test('sondaki eğik çizgi kırpılıyor', () => {
  assert.equal(toHomeRelative('/home/u/site.com/', 'u'), 'site.com');
});

test('ev dizininin kendisi boş dizeye iniyor', () => {
  assert.equal(toHomeRelative('/home/u', 'u'), '');
});

test('zaten göreli olan yol bozulmuyor', () => {
  assert.equal(toHomeRelative('public_html/shop', 'u'), 'public_html/shop');
});

test('başka bir kullanıcının yolu yanlışlıkla sökülmüyor', () => {
  // `/home/baska/site.com` bizim ev dizinimiz değil; önek eşleşmesi
  // kullanıcı adını da içermeli, yoksa yol yanlış çözülür.
  assert.equal(toHomeRelative('/home/baska/site.com', 'u'), 'home/baska/site.com');
});

test('benzer isimli ev dizini karıştırılmıyor', () => {
  // `/home/bimtest2/...` yolu `/home/bimtest` ile başlıyor ama başka bir hesap.
  assert.equal(toHomeRelative('/home/bimtest2/site.com', 'bimtest'), 'home/bimtest2/site.com');
});

test('boş değer null dönüyor', () => {
  assert.equal(toHomeRelative('', 'u'), null);
  assert.equal(toHomeRelative(null, 'u'), null);
});
