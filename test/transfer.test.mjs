import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectLocal, safeLocalTarget, transferPlan, MAX_FILES } from '../lib/transfer.mjs';

function proje(files = {}, dirs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tr-'));
  for (const d of dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const [rel, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), c);
  }
  return dir;
}

/* ------------------------------------------------- indirme hedefi (güvenlik) */

test('sunucudan gelen ad seçilen klasörün dışına yazamıyor', () => {
  /*
   * ⚠ Ad SUNUCUDAN geliyor. `../../.ssh/authorized_keys` adında bir dosya
   * hedef klasörün dışına yazabilseydi bu uç "her yere yaz" aracına
   * dönüşürdü.
   */
  const kok = '/tmp/indirme';
  for (const kotu of ['../kacis.txt', '../../etc/passwd', '/etc/passwd', '..', '.', '']) {
    const hedef = safeLocalTarget(kok, kotu);
    if (hedef === null) continue;
    assert.ok(
      hedef.startsWith(path.resolve(kok) + path.sep),
      `"${kotu}" klasör dışına çıktı: ${hedef}`
    );
  }
});

test('normal ad doğru yere gidiyor', () => {
  assert.equal(safeLocalTarget('/tmp/x', 'rapor.pdf'), path.resolve('/tmp/x/rapor.pdf'));
});

test('yol içeren ad yalnızca dosya adına indirgeniyor', () => {
  // Sunucu `alt/dizin/dosya.txt` derse bile hedef klasöre düz yazılıyor.
  assert.equal(safeLocalTarget('/tmp/x', 'alt/dizin/dosya.txt'), path.resolve('/tmp/x/dosya.txt'));
});

/* ------------------------------------------------------------- toplama */

test('klasör seçimi içeriğiyle açılıyor', () => {
  const dir = proje({ 'app/a.js': '1', 'app/alt/b.js': '2', 'baska.txt': '3' });
  const r = collectLocal(dir, ['app']);
  assert.deepEqual(r.files.sort(), ['app/a.js', 'app/alt/b.js']);
  assert.equal(r.files.includes('baska.txt'), false, 'seçilmeyen gitmemeli');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tek dosya da seçilebiliyor', () => {
  const dir = proje({ 'notlar.txt': 'x', 'app/a.js': '1' });
  const r = collectLocal(dir, ['notlar.txt']);
  assert.deepEqual(r.files, ['notlar.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.env engellenmiyor ama AYRI listeleniyor', () => {
  /*
   * Yayın hattı `.env` göndermiyor ve bu doğru. Dosya tarayıcısı genel
   * amaçlı: kullanıcı bilerek gönderebilmeli — ama sessizce değil.
   */
  const dir = proje({ '.env': 'GIZLI=1', 'app/.env.production': 'X=2', 'app/a.js': '1' });
  const r = collectLocal(dir, ['.env', 'app']);
  assert.ok(r.files.includes('.env'), 'gönderilecekler arasında olmalı');
  assert.deepEqual(r.dotenv.sort(), ['.env', 'app/.env.production']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sembolik bağlar takip edilmiyor', () => {
  // Hedefe kopyalamak beklenmedik dosyalar gönderir; döngü bütün diski
  // paketlemeye çalışır.
  const dir = proje({ 'gercek/a.js': '1' });
  fs.symlinkSync(path.join(dir, 'gercek'), path.join(dir, 'bag'));
  const r = collectLocal(dir, ['bag']);
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.symlinks, ['bag']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.git gibi araç dizinleri atlanıyor', () => {
  const dir = proje({ 'src/a.js': '1', '.git/HEAD': 'ref' });
  const r = collectLocal(dir, ['src', '.git']);
  assert.equal(r.files.some((f) => f.startsWith('.git')), false);
  // Sessizce atlanmıyor: kullanıcı seçtiğini gönderdiğini sanmamalı.
  assert.deepEqual(r.skipped, ['.git']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('seçim adı klasör dışına çıkamıyor', () => {
  // Tarayıcıdan gelen her şey düşman kabul ediliyor.
  const dir = proje({ 'a.js': '1' });
  const r = collectLocal(dir, ['../../../etc/passwd', '..']);
  assert.deepEqual(r.files, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('çok dosyada durup bildiriyor', () => {
  const files = {};
  for (let i = 0; i < MAX_FILES + 10; i += 1) files[`c/${i}.txt`] = 'x';
  const dir = proje(files);
  const r = collectLocal(dir, ['c']);
  assert.equal(r.files.length, MAX_FILES);
  assert.equal(r.truncated, true, 'sessizce kesilmemeli');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* --------------------------------------------------------------- özet */

test('özet gönderilecekleri önceden söylüyor', () => {
  const dir = proje({ 'a.txt': '12345', 'b.txt': '123' });
  const plan = transferPlan(collectLocal(dir, ['a.txt', 'b.txt']), { maxBytes: 100 });
  assert.equal(plan.count, 2);
  assert.equal(plan.bytes, 8);
  assert.equal(plan.tooBig, false);
  assert.equal(transferPlan(collectLocal(dir, ['a.txt']), { maxBytes: 2 }).tooBig, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
