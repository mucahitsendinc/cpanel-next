import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  fingerprint,
  diffManifest,
  uploadList,
  hasWork,
  buildManifest,
  readManifest,
  hashFile,
  MANIFEST_VERSION,
} from '../lib/delta.mjs';

/* ------------------------------------------------------------- yardımcılar */

function tempProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-delta-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

/* ------------------------------------------------------------------- fark */

test('değişmeyen dosya gönderilmiyor', () => {
  const prev = { 'a.js': 'aaa', 'b.js': 'bbb' };
  const next = { 'a.js': 'aaa', 'b.js': 'ZZZ' };
  const d = diffManifest(prev, next);

  assert.deepEqual(d.changed, ['b.js']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.equal(d.unchanged, 1);
  assert.deepEqual(uploadList(d), ['b.js']);
});

test('yeni ve silinen dosyalar ayrı ayrı raporlanıyor', () => {
  const d = diffManifest({ 'eski.js': '1', 'kalan.js': '2' }, { 'kalan.js': '2', 'yeni.js': '3' });
  assert.deepEqual(d.added, ['yeni.js']);
  assert.deepEqual(d.removed, ['eski.js']);
  assert.equal(d.unchanged, 1);
});

test('silinecekler YALNIZCA bizim gönderdiklerimizden seçiliyor', () => {
  /*
   * Sunucuda üretilmiş dosyalar (yüklemeler, loglar) hiçbir manifestte yok.
   * Manifestte olmayan bir şeyin silinme listesine girmesi, kullanıcının
   * verisini silmek olurdu.
   */
  const prev = { 'app.js': '1' };
  const next = { 'app.js': '2' };
  const d = diffManifest(prev, next);
  assert.deepEqual(d.removed, []);
  // Sunucudaki `storage/uploads/foto.jpg` iki listede de yok → dokunulmuyor.
  assert.equal(d.removed.includes('storage/uploads/foto.jpg'), false);
});

test('ilk kez: önceki manifest yoksa her şey yeni', () => {
  const d = diffManifest(null, { 'a.js': 'x', 'b.js': 'y' });
  assert.deepEqual(d.added, ['a.js', 'b.js']);
  assert.deepEqual(d.changed, []);
  assert.equal(d.unchanged, 0);
});

test('hiç iş yoksa hasWork false', () => {
  const same = { 'a.js': 'x' };
  assert.equal(hasWork(diffManifest(same, same)), false);
  assert.equal(hasWork(diffManifest(same, { 'a.js': 'z' })), true);
});

/* -------------------------------------------------------------- parmak izi */

test('parmak izi içeriğe bağlı, zaman damgasına değil', () => {
  /*
   * Bu testin varlık sebebi: `next build` ve `vite build` her koşuda bütün
   * çıktıyı yeniden yazıyor, yani mtime değişiyor ama içerik aynı kalıyor.
   * mtime'a bakan bir çözüm her seferinde tam yükleme yapardı.
   */
  const dir = tempProject({ 'app.js': 'merhaba' });
  const abs = path.join(dir, 'app.js');

  const first = fingerprint(dir).files['app.js'];

  // Dosyayı AYNI içerikle yeniden yaz, zaman damgasını da ileri al.
  fs.writeFileSync(abs, 'merhaba');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(abs, future, future);

  assert.equal(fingerprint(dir).files['app.js'], first, 'mtime değişti diye hash değişmemeli');

  fs.writeFileSync(abs, 'merhaba dunya');
  assert.notEqual(fingerprint(dir).files['app.js'], first, 'içerik değişti, hash değişmeli');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('parmak izi yayının hariç tutma kurallarına uyuyor', () => {
  // `node_modules` ve `.git` pakete girmiyor; parmak izine de girmemeli,
  // yoksa her güncellemede "değişti" diye yüz binlerce dosya sayılırdı.
  const dir = tempProject({
    'app.js': 'x',
    'node_modules/paket/index.js': 'y',
    '.git/HEAD': 'ref',
  });
  const fp = fingerprint(dir);
  assert.equal('app.js' in fp.files, true);
  assert.equal(Object.keys(fp.files).some((f) => f.startsWith('node_modules/')), false);
  assert.equal(Object.keys(fp.files).some((f) => f.startsWith('.git/')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.env parmak izine girmiyor', () => {
  // Yayın `.env` göndermiyor; manifestte görünmesi, sunucuda olmayan bir
  // dosyayı "değişmiş" sayıp göndermeye çalışmak demekti.
  const dir = tempProject({ 'app.js': 'x', '.env': 'GIZLI=1' });
  assert.equal('.env' in fingerprint(dir).files, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('okunamayan dosya sayılıyor, çökme yok', () => {
  assert.equal(hashFile('/olmayan/bir/yol/dosya.js'), null);
});

/* ---------------------------------------------------------------- manifest */

test('manifest gidiş-dönüş', () => {
  const files = { 'a.js': 'aaa' };
  const parsed = readManifest(JSON.parse(JSON.stringify(buildManifest(files))));
  assert.deepEqual(parsed, files);
});

test('tanınmayan sürüm reddediliyor', () => {
  /*
   * Bilinmeyen bir biçimi "boş manifest" saymak, sunucudaki her dosyayı yeni
   * sanıp delta'yı sessizce tam yüklemeye çevirirdi — ya da daha kötüsü,
   * silinmesi gerekenleri atlardı. Reddetmek, çağıranı tam yayına düşürüyor.
   */
  assert.equal(readManifest({ v: 99, files: { 'a.js': 'x' } }), null);
  assert.equal(readManifest({ v: MANIFEST_VERSION, files: null }), null);
  assert.equal(readManifest({ v: MANIFEST_VERSION, files: ['a.js'] }), null);
  assert.equal(readManifest(null), null);
  assert.equal(readManifest('bozuk'), null);
});
