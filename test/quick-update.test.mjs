import test from 'node:test';
import assert from 'node:assert/strict';
import { quickUpdateBlocker } from '../lib/quick-update.mjs';

/*
 * Hızlı güncelleme yanlış zamanda koşarsa sessizce bozuk bir sunucu bırakır:
 * yerelde silinmiş dosyalar orada yaşamaya devam eder ya da eksik bir
 * bağımlılıkla site düşer. Reddetme koşulları bu yüzden testli.
 */

test('manifest yoksa reddediliyor', () => {
  /*
   * Manifest, en son NE GÖNDERDİĞİMİZİN kaydı. Yoksa sunucuda ne olduğunu
   * bilmiyoruz; delta göndermek, orada artık yerelde bulunmayan dosyaları
   * sonsuza kadar bırakmak demek.
   */
  assert.equal(quickUpdateBlocker({ manifest: null, marker: null, framework: 'next' }), 'noManifest');
});

test('manifest varsa geçiyor', () => {
  assert.equal(
    quickUpdateBlocker({ manifest: { 'a.js': 'x' }, marker: {}, framework: 'next' }),
    null
  );
});

test('composer.lock değiştiyse reddediliyor', () => {
  // Bağımlılık kurulumu tam yayının işi; hızlı güncelleme composer install
  // koşturmuyor ve eksik bir bağımlılıkla siteyi düşürmemeli.
  const b = quickUpdateBlocker({
    manifest: { 'a.php': 'x' },
    marker: { composerLock: 'ESKI' },
    localLock: 'YENI',
    framework: 'laravel',
  });
  assert.equal(b, 'lockChanged');
});

test('composer.lock aynıysa geçiyor', () => {
  assert.equal(
    quickUpdateBlocker({
      manifest: { 'a.php': 'x' },
      marker: { composerLock: 'AYNI' },
      localLock: 'AYNI',
      framework: 'laravel',
    }),
    null
  );
});

test('kilit bilgisi eksikse engel çıkarılmıyor', () => {
  // Eski bir işaret dosyasında composerLock olmayabilir. Bilmediğimiz bir
  // şey yüzünden özelliği kapatmak, kullanıcıyı sebepsiz tam yayına iter.
  assert.equal(
    quickUpdateBlocker({ manifest: { 'a.php': 'x' }, marker: {}, localLock: 'YENI', framework: 'laravel' }),
    null
  );
});

test('Next projesinde composer.lock bakılmıyor', () => {
  assert.equal(
    quickUpdateBlocker({
      manifest: { 'a.js': 'x' },
      marker: { composerLock: 'ESKI' },
      localLock: 'YENI',
      framework: 'next',
    }),
    null
  );
});
