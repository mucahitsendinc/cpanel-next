import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildScript,
  parseResult,
  prettyCwd,
  shellQuote,
  createSession,
  applyResult,
  EXIT_MARK,
} from '../lib/shell/session.mjs';

/**
 * Betiği GERÇEK bir kabukta koşturur.
 *
 * Bu dosyadaki testlerin çoğu saf ayrıştırma testi değil: asıl soru
 * "kabuk bunu nasıl yorumluyor" ve buna yalnızca kabuk cevap verebilir.
 */
function runInShell(command, cwd) {
  const script = buildScript(command, { cwd, home: shellQuote(os.homedir()) });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cn-sh-')), 'job.sh');
  fs.writeFileSync(file, script);
  let raw = '';
  try {
    raw = execFileSync('sh', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // Kullanıcının komutu başarısız olabilir; çıktı yine de bizim.
    raw = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return parseResult(raw);
}

/* ------------------------------------------------------------------- cd */

test('cd bir sonraki komuta taşınıyor', () => {
  /*
   * Bu bütün özelliğin varlık sebebi: worker her işi ayrı bir `sh` ile
   * koşuyor, yani `cd` normalde kaybolurdu.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-cd-'));
  fs.mkdirSync(path.join(dir, 'public'));

  const first = runInShell('cd public', dir);
  assert.equal(first.exitCode, 0);
  assert.equal(fs.realpathSync(first.cwd), fs.realpathSync(path.join(dir, 'public')));

  // İkinci komut, birincinin bıraktığı yerden başlıyor.
  const second = runInShell('pwd', first.cwd);
  assert.equal(fs.realpathSync(second.output.trim()), fs.realpathSync(path.join(dir, 'public')));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('cd .. ve cd - de doğru izleniyor', () => {
  /*
   * `cd`'yi AYRIŞTIRMIYORUZ, kabuğa soruyoruz — bu yüzden `..`, `-` ve
   * sembolik bağlar bedavaya doğru çalışıyor.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-cd2-'));
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });

  const down = runInShell('cd a/b', dir);
  const up = runInShell('cd ..', down.cwd);
  assert.equal(fs.realpathSync(up.cwd), fs.realpathSync(path.join(dir, 'a')));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('komut içindeki dizin değişikliği de yakalanıyor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-cd3-'));
  fs.mkdirSync(path.join(dir, 'x'));
  const r = runInShell('cd x && echo icerideyim', dir);
  assert.equal(r.output.trim(), 'icerideyim');
  assert.equal(fs.realpathSync(r.cwd), fs.realpathSync(path.join(dir, 'x')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('silinmiş dizin komutu düşürmüyor', () => {
  // Kullanıcı bir dizindeyken onu başka yerden silerse, komut hiç koşmamak
  // yerine ev dizininde koşuyor.
  const r = runInShell('echo hayattayim', '/olmayan/bir/dizin');
  assert.equal(r.output.trim(), 'hayattayim');
  assert.equal(r.exitCode, 0);
});

/* ------------------------------------------------------------- çıkış kodu */

test('başarısız komutun çıkış kodu doğru', () => {
  const r = runInShell('exit 42', os.homedir());
  assert.equal(r.exitCode, 42);
});

test('çıkış kodu KOMUTUN kendisine ait', () => {
  /*
   * `$?` araya giren herhangi bir komutun kodunu gösterir. İşaret satırı
   * komuttan hemen sonra gelmezse, kullanıcı hep 0 görürdü.
   */
  const r = runInShell('ls /kesinlikle/olmayan/yol', os.homedir());
  assert.notEqual(r.exitCode, 0);
});

/* ---------------------------------------------------------------- çıktı */

test('iç protokol işaretleri kullanıcıya gösterilmiyor', () => {
  const r = runInShell('echo merhaba', os.homedir());
  assert.equal(r.output.trim(), 'merhaba');
  assert.doesNotMatch(r.output, /__CN_/);
});

test('kullanıcı işareti taklit etse bile son söz bizim', () => {
  // Çıktısında sahte bir işaret yazan komut, gerçek çıkış kodunu bozmamalı.
  const r = runInShell(`printf '${EXIT_MARK}99\\n'; exit 7`, os.homedir());
  assert.equal(r.exitCode, 7);
});

test('çok satırlı çıktı korunuyor', () => {
  const r = runInShell("printf 'bir\\niki\\nuc\\n'", os.homedir());
  assert.deepEqual(r.output.split('\n'), ['bir', 'iki', 'uc']);
});

/* -------------------------------------------------------------- yardımcı */

test('ev dizini ~ ile kısaltılıyor', () => {
  assert.equal(prettyCwd('/home/ali', '/home/ali'), '~');
  assert.equal(prettyCwd('/home/ali/public_html', '/home/ali'), '~/public_html');
  // Ev dizini dışı olduğu gibi kalıyor — kullanıcı nerede olduğunu bilmeli.
  assert.equal(prettyCwd('/tmp/x', '/home/ali'), '/tmp/x');
  // Benzer önek yanlış kısaltılmamalı.
  assert.equal(prettyCwd('/home/ali2/x', '/home/ali'), '/home/ali2/x');
});

test('boşluklu ve tırnaklı dizin adları', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-q-'));
  const odd = path.join(dir, "bo sluk'lu");
  fs.mkdirSync(odd);
  const r = runInShell('pwd', odd);
  assert.equal(fs.realpathSync(r.output.trim()), fs.realpathSync(odd));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oturum durumu yalnızca dizin taşıyor', () => {
  const s = createSession({ home: '/home/ali' });
  assert.equal(s.cwd, '/home/ali');
  applyResult(s, { cwd: '/home/ali/public_html' });
  assert.equal(s.cwd, '/home/ali/public_html');
  // cwd gelmezse eskisi korunuyor.
  applyResult(s, { cwd: null });
  assert.equal(s.cwd, '/home/ali/public_html');
});

test('exit yazılsa bile dizin ve çıkış kodu korunuyor', () => {
  /*
   * Bu testin varlık sebebi: ilk yazımda işaretler komuttan SONRAKİ satırlarda
   * yazılıyordu ve `exit` betiği orada bitirdiği için ikisi de kayboluyordu —
   * terminal, kullanıcı `exit` yazdığı anda nerede olduğunu unutuyordu.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-exit-'));
  const r = runInShell('exit 42', dir);
  assert.equal(r.exitCode, 42, 'çıkış kodu okunmalı');
  assert.equal(fs.realpathSync(r.cwd), fs.realpathSync(dir), 'dizin korunmalı');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sinyalle ölen komutta bile dizin geri geliyor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-sig-'));
  const r = runInShell('kill -TERM $$', dir);
  assert.equal(r.cwd !== null, true, 'dizin bildirilmeli');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('$PHP terminal oturumunda tanımlı', () => {
  /*
   * ⚠ CANLIDA GÖRÜLEN HATA.
   *
   *   ~ $ "$PHP" artisan optimize:clear
   *   .../running/xxx.sh: line 44: : command not found
   *
   * Kısayol düğmeleri `"$PHP" artisan …` yazıyor ama `PHP` değişkeni yalnızca
   * LARAVEL YAYIN betiğinde tanımlıydı. Terminalde boş kaldığı için komut
   * `"" artisan …` hâline geliyordu ve kabuk boş komut adını çalıştırmaya
   * çalışıyordu.
   */
  const r = runInShell('test -n "$PHP" && echo dolu || echo BOS', os.tmpdir());
  assert.equal(r.output.trim(), 'dolu', '$PHP boş kalmamalı');
});

test('$COMPOSER da tanımlı', () => {
  // Aynı gerekçe: kullanıcı sunucuda `"$COMPOSER" install` yazabilmeli.
  const script = buildScript('echo x', { cwd: os.tmpdir(), home: shellQuote(os.tmpdir()) });
  assert.match(script, /COMPOSER=/);
  assert.match(script, /export PHP COMPOSER/);
});

test('php tespiti kapatılabiliyor', () => {
  // Yayın hattı kendi PHP tespitini yapıyor; iki kez aramak gereksiz.
  const script = buildScript('echo x', { cwd: '/tmp', home: "'/tmp'", php: false });
  assert.doesNotMatch(script, /PHP=""/);
});
