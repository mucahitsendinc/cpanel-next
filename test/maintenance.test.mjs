import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBlock, renderPage, renderPhp, BEGIN, END, FLAG, PAGE } from '../lib/maintenance.mjs';

/*
 * Bu dosyadaki testlerin tamamı canlı bir hesapta görülen tek bir arızadan
 * çıktı: `ErrorDocument 503` yalnız bizim 503'ümüzü değil PASSENGER'INKİNİ de
 * yakalıyordu. Uygulama açılamadığında ziyaretçi sonsuza kadar "Yenileniyor…"
 * görüyor, gerçek hatayı hiç göremiyordu — yani bozuk bir uygulama, süren bir
 * güncellemeden ayırt edilemiyordu.
 */

const PASSENGER = `# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN
PassengerAppRoot "/home/u/app"
PassengerNodejs "/home/u/nodevenv/app/22/bin/node"
# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END`;

const OLD_BLOCK = `${BEGIN}
ErrorDocument 503 /${PAGE}
${END}`;

const NEW_BLOCK = `${BEGIN}
ErrorDocument 503 /cpanel-next-maintenance.php
${END}`;

test('blok yoksa dosyanın BAŞINA ekleniyor', () => {
  // Passenger bloğu isteği uygulamaya devrediyor; bizimki ondan SONRA gelirse
  // hiç çalışmaz. Sıra tesadüf değil.
  const out = mergeBlock(PASSENGER, NEW_BLOCK);
  assert.ok(out.startsWith(BEGIN), 'blok başta olmalı');
  assert.ok(out.indexOf(BEGIN) < out.indexOf('PassengerAppRoot'));
  assert.ok(out.includes('PassengerAppRoot'), 'mevcut içerik korunmalı');
});

test('eski blok yenisiyle DEĞİŞTİRİLİYOR', () => {
  /*
   * Asıl regresyon: eskiden yalnızca "BEGIN var mı" bakılıyordu ve varsa
   * dokunulmuyordu. Bu, bir kez kurulmuş her docroot'u sonsuza dek eski blokta
   * bırakırdı — düzeltme yayınlansa bile mevcut kurulumlarda hiç uygulanmazdı.
   */
  const current = `${OLD_BLOCK}\n\n${PASSENGER}`;
  const out = mergeBlock(current, NEW_BLOCK);
  assert.ok(out !== null, 'farklı blok değiştirilmeliydi');
  assert.ok(out.includes('cpanel-next-maintenance.php'));
  assert.ok(!out.includes(`ErrorDocument 503 /${PAGE}`), 'eski satır kalmamalı');
  assert.equal(out.match(new RegExp(BEGIN, 'g')).length, 1, 'blok tekrarlanmamalı');
});

test('blok aynıysa dosyaya HİÇ dokunulmuyor', () => {
  const current = `${NEW_BLOCK}\n\n${PASSENGER}`;
  assert.equal(mergeBlock(current, NEW_BLOCK), null);
});

test('dosyanın geri kalanı birebir korunuyor', () => {
  const current = `${OLD_BLOCK}\n\n${PASSENGER}\n# kullanıcının kendi kuralı\nOptions -Indexes\n`;
  const out = mergeBlock(current, NEW_BLOCK);
  assert.ok(out.includes(PASSENGER), 'Passenger bloğu silinmemeli');
  assert.ok(out.includes('Options -Indexes'), 'kullanıcının kuralı silinmemeli');
});

test('yarım blokta yazma reddediliyor', () => {
  // END yoksa nerede bittiğini bilmiyoruz. Tahmin ederek kesmek, araya giren
  // Passenger yapılandırmasını yiyebilirdi.
  const current = `${BEGIN}\nErrorDocument 503 /x.html\n${PASSENGER}`;
  assert.equal(mergeBlock(current.replace(END, ''), NEW_BLOCK), null);
});

test('PHP sayfası bakım ile GERÇEK hatayı ayırıyor', () => {
  const php = renderPhp();
  assert.ok(php.startsWith('<?php'), 'PHP olarak başlamalı');
  assert.ok(php.includes(FLAG), 'bayrak dosyasına bakmalı');
  assert.ok(php.includes('file_exists'), 'bayrağın varlığı belirleyici');
  // Bayrak varken bakım sayfası, yokken hata sayfası.
  assert.ok(php.includes(`readfile`), 'bakım sayfasını okumalı');
  assert.ok(php.includes('Uygulama başlatılamadı'), 'hata sayfası gömülü olmalı');
  assert.ok(php.includes('http_response_code(503)'), '503 korunmalı');
});

test('sonda ucu bayrağa göre 503/200 dönüyor', () => {
  const php = renderPhp();
  assert.match(php, /isset\(\$_GET\['probe'\]\)/);
  assert.match(php, /http_response_code\(\$on \? 503 : 200\)/);
  assert.match(php, /echo \$on \? 'on' : 'off'/);
});

test('hata sayfası kendini YENİLEMİYOR', () => {
  /*
   * Yenilenen bir sayfa "işlem sürüyor" izlenimi veriyor. Bayrak yokken
   * beklemekle düzelecek bir şey yok — sayfa bunu söylemeli, oyalamamalı.
   */
  const fail = renderPhp().split('?>').slice(1).join('?>');
  assert.ok(!fail.includes('setInterval'), 'hata sayfasında yoklama olmamalı');
  assert.ok(!fail.includes('location.reload'), 'hata sayfası yenilenmemeli');
  assert.ok(fail.includes('stderr.log'), 'nereye bakılacağını söylemeli');
  assert.ok(fail.includes('rollback'), 'geri dönüş yolunu göstermeli');
});

test('bakım sayfası PHP varken BAYRAĞI yokluyor', () => {
  /*
   * Kendi adresini yoklamak, uygulama bozukken 503 hiç değişmediği için
   * sonsuza kadar beklemek demekti. Bayrak yoklaması bakım biter bitmez 200
   * dönüyor ve sayfa yenileniyor.
   */
  const page = renderPage({ domain: 'x.com', probe: '/cpanel-next-maintenance.php?probe=1' });
  assert.ok(page.includes('var probe = "/cpanel-next-maintenance.php?probe=1"'));
  assert.ok(page.includes('location.reload'));
});

test('PHP yokken eski davranışa düşüyor', () => {
  const page = renderPage({ domain: 'x.com' });
  assert.ok(page.includes('var probe = null'), 'sonda olmadan kendi adresini yoklamalı');
  assert.ok(page.includes('location.pathname'));
});

test('bakım bloğu LiteSpeed uyumlu kalıyor', () => {
  /*
   * Test kutusu LiteSpeed çalıştırıyor ve Apache 2.4'e özgü `<If "-f ...">`
   * ifade sözdizimi orada desteklenmiyor — konsaydı siteyi 500'e düşürürdü.
   */
  const out = mergeBlock('', NEW_BLOCK);
  assert.ok(!out.includes('<If '), 'Apache <If> ifadesi kullanılmamalı');
});
