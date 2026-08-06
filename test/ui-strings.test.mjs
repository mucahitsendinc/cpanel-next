import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Web arayüzünün sözlüğü `app.html` içinde yaşıyor ve `lib/i18n`'den ayrı —
 * yani i18n testlerinin koruması buraya UZANMIYOR. Eksik bir anahtar tarayıcıda
 * hata vermez, düğmenin üstüne anahtar adını yazar ("writeEnv"). Sessiz bozulma
 * olduğu için testle bağlanması gerekiyor.
 */

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const HTML = fs.readFileSync(path.join(ROOT, 'lib/ui-server/app.html'), 'utf8');
const SCRIPT = HTML.slice(HTML.indexOf('<script>') + 8, HTML.lastIndexOf('</script>'));

/** `S` nesnesinin bir dilindeki anahtarları, ayrıştırmadan, düz metinden okur. */
function keysOf(lang) {
  const start = SCRIPT.indexOf(`  ${lang}:{`);
  assert.notEqual(start, -1, `${lang} sözlüğü bulunamadı`);
  const end = lang === 'tr' ? SCRIPT.indexOf('  en:{') : SCRIPT.indexOf('\n};', start);
  const body = SCRIPT.slice(start, end);
  return new Set([...body.matchAll(/(?:^|[{,\s])([a-zA-Z][a-zA-Z0-9]*)\s*:\s*['"]/g)].map((m) => m[1]));
}

test('tr ve en sözlükleri aynı anahtarlara sahip', () => {
  const tr = keysOf('tr');
  const en = keysOf('en');
  assert.deepEqual([...tr].filter((k) => !en.has(k)), [], 'İngilizcede eksik');
  assert.deepEqual([...en].filter((k) => !tr.has(k)), [], 'Türkçede eksik');
  assert.ok(tr.size > 100, `beklenenden az anahtar: ${tr.size}`);
});

test("kodda kullanılan HER s('anahtar') sözlükte var", () => {
  const tr = keysOf('tr');
  const used = new Set([...SCRIPT.matchAll(/\bs\((['"])([a-zA-Z0-9]+)\1\)/g)].map((m) => m[2]));
  const missing = [...used].filter((k) => !tr.has(k));
  assert.deepEqual(missing, []);
});

test('veritabanı sekmesi kayıtlı ve yönlendirilmiş', () => {
  // Sekmeyi listeye ekleyip görünüm eşlemesine eklemeyi unutmak, sekmeye
  // tıklandığında sayfayı tamamen boş bırakıyor.
  assert.match(SCRIPT, /'overview', 'deploy', 'database'/);
  assert.match(SCRIPT, /database: viewDatabase/);
});

test('phpMyAdmin bağlantısı yeni sekmede ve referrer sızdırmadan açılır', () => {
  assert.match(SCRIPT, /pmaFor/);
  assert.match(SCRIPT, /target: '_blank', rel: 'noreferrer'/);
});

/*
 * Ölü düğme denetimi.
 *
 * `askDelete` aylarca çağrıldı ama HİÇ TANIMLANMAMIŞTI: uygulama kartındaki
 * "Sil" düğmesi tıklanınca konsola ReferenceError düşüyor, ekranda hiçbir şey
 * olmuyordu. Tarayıcıda çalışan kodun derleyicisi yok; bu boşluğu kapatan tek
 * şey böyle bir test.
 */
test('çağrılan her yardımcı fonksiyon tanımlı', () => {
  const declared = new Set([
    // Tarayıcı ve dil yerleşikleri
    'fetch', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'alert',
    'confirm', 'prompt', 'encodeURIComponent', 'decodeURIComponent', 'parseInt',
    'parseFloat', 'isNaN', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON',
    'Date', 'Math', 'URL', 'URLSearchParams', 'Error', 'Promise', 'Set', 'Map',
    'RegExp', 'Symbol', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
    'function', 'super', 'require', 'async', 'await', 'EventSource', 'else', 'do', 'new',
  ]);

  // Bildirimler: fonksiyon adları, const/let/var ve fonksiyon parametreleri.
  for (const m of SCRIPT.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of SCRIPT.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of SCRIPT.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim().split(/[=\s]/)[0].replace(/[{}[\].]/g, '');
      if (name) declared.add(name);
    }
  }
  for (const m of SCRIPT.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim().split(/[=\s]/)[0].replace(/[{}[\].]/g, '');
      if (name) declared.add(name);
    }
  }
  for (const m of SCRIPT.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
  // Nesne kısayolu: `{ overview: viewOverview }` gibi değerler de bildirim değil
  // ama zaten yukarıda function/const olarak yakalanıyor.

  /*
   * Yorumlar ve METİNLER çıkarılıyor. Kod Türkçe yorumlanmış ve arayüz
   * sözlüğü Türkçe cümlelerle dolu: "Build'i atla (mevcut .next gönderilsin)"
   * düz metinde bir fonksiyon çağrısına birebir benziyor.
   */
  const code = SCRIPT
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/\/[^\n]*/g, ' ');

  const missing = new Set();
  for (const m of code.matchAll(/(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!declared.has(name)) missing.add(name);
  }

  assert.deepEqual([...missing], [], 'tanımsız çağrı');
});
