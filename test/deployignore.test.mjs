import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseDeployIgnore, loadDeployIgnore, resolveExcludes, IGNORE_FILE } from '../lib/deployignore.mjs';
import { buildExcludeMatcher, DEFAULT_EXCLUDES } from '../lib/packager.mjs';

function tempDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-ign-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/* ------------------------------------------------------------ ayrıştırma */

test('yorum ve boş satırlar atlanıyor', () => {
  const { patterns } = parseDeployIgnore('# yorum\n\n  \ndocs/**\n');
  assert.deepEqual(patterns, ['docs/**']);
});

test('sondaki eğik çizgi dizin desenine çevriliyor', () => {
  // Kullanıcı .gitignore alışkanlığıyla `docs/` yazıyor; eşleştirici
  // dizinleri `docs/**` biçiminde anlıyor.
  assert.deepEqual(parseDeployIgnore('docs/').patterns, ['docs/**']);
});

test('baştaki eğik çizgi kaldırılıyor', () => {
  // Yollarımız proje köküne göreli, `/docs` ile `docs` aynı şey.
  assert.deepEqual(parseDeployIgnore('/docs/').patterns, ['docs/**']);
});

test('ters desen atlanıyor ve UYARI üretiyor', () => {
  /*
   * Eşleştiricide `!` karşılığı yok. Sessizce yok saymak, kullanıcının
   * "bunu yine de gönder" dediği dosyanın gitmemesi demek olurdu.
   */
  const { patterns, warnings } = parseDeployIgnore('*.md\n!README.md\n');
  assert.deepEqual(patterns, ['*.md']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /README\.md/);
});

/* -------------------------------------------------- eşleştiriciyle uyum */

test('desenler eşleştiricide GERÇEKTEN çalışıyor', () => {
  /*
   * Ayrıştırmanın doğru olması yetmez — üretilen desenin mevcut
   * `buildExcludeMatcher` tarafından anlaşılması gerekiyor. İki taraf
   * ayrışırsa kullanıcı hiçbir şeyin elenmediğini fark etmez.
   */
  const { patterns } = parseDeployIgnore('docs/\n*.md\nnotlar.txt\n');
  const match = buildExcludeMatcher(patterns);

  assert.ok(match('docs/rehber.md'), 'docs/ altındaki her şey elenmeli');
  assert.ok(match('docs/alt/derin.txt'), 'alt dizinler de');
  assert.ok(match('README.md'), '*.md kökte');
  assert.ok(match('src/BENIOKU.md'), '*.md alt dizinde');
  assert.ok(match('notlar.txt'), 'düz ad');

  assert.equal(match('src/app.js'), null, 'ilgisiz dosya elenmemeli');
  assert.equal(match('docsx/app.js'), null, 'benzer önek yanlış eşleşmemeli');
});

/* ------------------------------------------------------------- birleşim */

test('üç kaynak da ekleniyor', () => {
  const dir = tempDir({ [IGNORE_FILE]: 'docs/\n' });
  const r = resolveExcludes(dir, { projectExclude: ['gizli/**'] });

  assert.ok(r.excludes.includes('docs/**'), '.deployignore');
  assert.ok(r.excludes.includes('gizli/**'), '.cpanel-next.json exclude');
  assert.ok(r.excludes.includes('node_modules/**'), 'aracın kendi listesi');
  assert.equal(r.fromIgnore, 1);
  assert.equal(r.fromConfig, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('dosya yoksa varsayılanlar bozulmuyor', () => {
  const dir = tempDir();
  const r = resolveExcludes(dir);
  assert.deepEqual(r.excludes, DEFAULT_EXCLUDES);
  assert.deepEqual(r.warnings, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('taban liste değiştirilebiliyor (Laravel kendi listesiyle geliyor)', () => {
  const dir = tempDir({ [IGNORE_FILE]: '*.md\n' });
  const r = resolveExcludes(dir, { base: ['vendor/**'] });
  assert.deepEqual(r.excludes, ['vendor/**', '*.md']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bozuk exclude değerleri eleniyor', () => {
  const dir = tempDir();
  const r = resolveExcludes(dir, { projectExclude: ['iyi/**', '', '   ', null, 42, {}] });
  assert.deepEqual(r.excludes.slice(DEFAULT_EXCLUDES.length), ['iyi/**']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('okunamayan dosya çökertmiyor', () => {
  assert.deepEqual(loadDeployIgnore('/olmayan/dizin'), { patterns: [], warnings: [] });
});
