import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { wrapJob, WORKER_VERSION } from '../lib/shell/worker.mjs';

/**
 * İş sarmalayıcısını GERÇEK kabukta koşturup durum dosyasını okur.
 *
 * Bu dosyadaki her testin sorusu aynı: "istemci işin bittiğini görebiliyor
 * mu?" Görmezse `pollResult` 25 dakikalık zaman aşımına kadar döner — yani
 * kullanıcı için uygulama donmuş demektir.
 */
function runJob(body, { tolerant = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-job-'));
  fs.mkdirSync(path.join(home, '.cpanel-next-worker', 'results'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cpanel-next-worker', 'cancel'), { recursive: true });

  const id = 'test1';
  const script = path.join(home, 'job.sh');
  fs.writeFileSync(script, wrapJob(id, body, home, { tolerant }));

  const proc = spawnSync('sh', [script], { encoding: 'utf8' });

  const statusFile = path.join(home, '.cpanel-next-worker', 'results', `${id}.json`);
  const status = fs.existsSync(statusFile)
    ? JSON.parse(fs.readFileSync(statusFile, 'utf8'))
    : null;

  fs.rmSync(home, { recursive: true, force: true });
  return { status, stdout: proc.stdout ?? '' };
}

test('normal biten iş durumu yazıyor', () => {
  const { status, stdout } = runJob('echo merhaba');
  assert.equal(status?.done, true);
  assert.equal(status?.ok, true);
  assert.match(stdout, /merhaba/);
});

test('gövde exit çağırsa BİLE durum yazılıyor', () => {
  /*
   * ⚠ BU TESTİN VARLIK SEBEBİ GERÇEK BİR HATA.
   *
   * Bitiş durumu eskiden `${body}`'den sonraki satırdaydı. Gövde `exit`
   * çağırınca betik orada bitiyor, o satır hiç koşmuyor ve durum dosyası
   * yazılmıyordu. İstemci işin bittiğini asla göremeyip 25 DAKİKA boyunca
   * yokluyordu — kullanıcı için donmuş bir uygulama.
   *
   * Terminal bunu sıradan hâle getirdi (kullanıcı `exit` yazabiliyor) ama
   * hata her zaman vardı.
   */
  const { status, stdout } = runJob('echo once; exit 42');
  assert.notEqual(status, null, 'durum dosyası yazılmalı — yoksa iş askıda kalır');
  assert.equal(status.done, true);
  assert.equal(status.ok, false, 'sıfırdan farklı çıkış başarısızlık olarak bildirilmeli');
  assert.match(stdout, /once/);
});

test('cn_fail kendi hata mesajını koruyor', () => {
  // trap, cn_fail'in yazdığı gerçek hatanın üstüne yazmamalı.
  const { status } = runJob('cn_fail "vendor bulunamadi"');
  assert.equal(status.done, true);
  assert.equal(status.ok, false);
  assert.equal(status.error, 'vendor bulunamadi');
});

test('hoşgörülü kipte başarısız komut iş hatası SAYILMIYOR', () => {
  /*
   * Terminal için: kullanıcının komutunun sıfırdan farklı dönmesi normal.
   * `ls /yok` her seferinde kırmızı bir hata kutusu göstermemeli; gerçek
   * çıkış kodu çıktıdaki işaretlerde taşınıyor (bkz. shell/session.mjs).
   */
  const { status } = runJob('ls /kesinlikle-olmayan-yol', { tolerant: true });
  assert.equal(status.done, true);
  assert.equal(status.ok, true);
});

test('hoşgörülü kipte exit de iş hatası sayılmıyor ama durum yazılıyor', () => {
  const { status } = runJob('echo bitti; exit 3', { tolerant: true });
  assert.equal(status.done, true);
  assert.equal(status.ok, true);
});

test('hoşgörülü kip cn_fail’i bastırmıyor', () => {
  // Hoşgörü kullanıcının komutu için; altyapımızın kendi hatası hâlâ hata.
  const { status } = runJob('cn_fail "dizin yok"', { tolerant: true });
  assert.equal(status.ok, false);
  assert.equal(status.error, 'dizin yok');
});

test('sürüm damgası betiklerle birlikte artıyor', () => {
  /*
   * Sunucudaki eski worker yalnızca sürüm damgası değişince kendini
   * emekliye ayırıyor. Betik değişip damga sabit kalırsa yeni davranış hiç
   * devreye girmez — geliştirme sırasında bir kez tam olarak bu oldu.
   */
  assert.equal(typeof WORKER_VERSION, 'string');
  assert.ok(Number(WORKER_VERSION) >= 5, 'trap düzeltmesi 5. sürümle geldi');
});
