import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toHomeRelative } from '../lib/domain.mjs';
import * as remote from '../lib/remote.mjs';

/*
 * ⚠ CANLIDA GÖRÜLEN HATA.
 *
 *   Fileman::list_files: The directory "/home/bimtest/home/bimtest" does not exist
 *
 * Sebep: arayüz mutlak yollarla çalışıyor (kullanıcı nerede olduğunu görmeli)
 * ama `remote.rel()` mutlak yolu göreliye ÇEVİRMİYOR — yalnızca eğik
 * çizgileri kırpıyor. `/home/bimtest` → `home/bimtest`, cPanel de bunu ev
 * dizinine göreli sayıp ev dizinini iki kez ekliyor.
 */

test('remote.rel mutlak yolu göreliye çevirmiyor — çeviren toHomeRelative', () => {
  // Hatanın kaynağı: iki fonksiyonun farkı.
  assert.equal(remote.rel('/home/bimtest'), 'home/bimtest', 'rel yalnızca kırpıyor');
  assert.equal(toHomeRelative('/home/bimtest', 'bimtest'), '', 'ev dizini = kök');
});

test('ev dizini ve altı doğru çevriliyor', () => {
  const u = 'bimtest';
  assert.equal(toHomeRelative('/home/bimtest', u), '');
  assert.equal(toHomeRelative('/home/bimtest/public_html', u), 'public_html');
  assert.equal(toHomeRelative('/home/bimtest/a/b/c', u), 'a/b/c');
  assert.equal(toHomeRelative('/home/bimtest/public_html/', u), 'public_html');
});

test('benzer kullanıcı adı yanlış kırpılmıyor', () => {
  // `/home/bimtest2` içindeki bir yol `bimtest`in eviymiş gibi görünmemeli.
  assert.equal(toHomeRelative('/home/bimtest2/x', 'bimtest'), 'home/bimtest2/x');
});

test('zaten göreli olan yol bozulmuyor', () => {
  assert.equal(toHomeRelative('public_html', 'bimtest'), 'public_html');
  assert.equal(toHomeRelative('public_html/alt', 'bimtest'), 'public_html/alt');
});

test('api.mjs uzak yolları homeRel ile çeviriyor, rel ile DEĞİL', () => {
  /*
   * Bu dosya kaynağı okuyor çünkü hata tek bir uçta değildi: tarama,
   * aktarım, silme ve düzenleyici — dördü de arayüzden mutlak yol alıyor ve
   * hepsi aynı yanlış dönüşümü yapıyordu. Biri düzeltilip diğeri unutulursa
   * hata sessizce geri gelir.
   */
  const src = fs.readFileSync('lib/ui-server/api.mjs', 'utf8');

  // Arayüzden gelen uzak yol alanları
  for (const alan of ['body.remoteDir', 'body.path', "searchParams.get('path')"]) {
    const i = src.indexOf(alan);
    assert.notEqual(i, -1, `${alan} kaynakta yok`);
  }

  // `remote.rel(` ile SARILAN bir remoteDir/body.path kalmamalı.
  assert.doesNotMatch(src, /remote\.rel\(String\(body\.remoteDir/, 'remoteDir hâlâ remote.rel ile');
  assert.doesNotMatch(src, /remote\.rel\(String\(body\.path/, 'body.path hâlâ remote.rel ile');
  assert.doesNotMatch(src, /remote\.rel\(url\.searchParams\.get\('path'\)/, 'path hâlâ remote.rel ile');
});
