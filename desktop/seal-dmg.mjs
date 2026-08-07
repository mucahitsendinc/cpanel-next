import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `.dmg` KABUĞUNU imzalar, notarize eder ve mührü dosyaya işler.
 *
 * Neden ayrı bir adım: `electron-builder` `notarize: true` ile UYGULAMAYI
 * notarize ediyor, ama disk imajının KENDİSİNİ imzalamıyor. Ölçüldü:
 *
 *   spctl -a -t open --context context:primary-signature  …0.7.1-arm64.dmg
 *   → rejected · source=no usable signature
 *
 * İçindeki uygulama notarize olduğu için kopyalandığında çalışıyor, ama
 * indirilen dosyanın kendisi karantinaya alınıyor ve Gatekeeper imzasız bir
 * imajda uyarı çıkarıyor. Apple'ın önerdiği dağıtım biçimi, mührün
 * DAĞITILAN dosyaya işlenmesi.
 *
 * ⚠ MÜHÜR ÇEVRİMDIŞI ÇALIŞMAK İÇİN. Notarize kaydı Apple'ın sunucusunda
 * duruyor; `stapler` onu dosyaya gömüyor. Gömülmezse indiren kişinin
 * makinesi Apple'a ulaşamadığında (ağ yok, kurumsal güvenlik duvarı)
 * uygulama açılmıyor.
 */

const ENV = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const IDENTITY = 'Developer ID Application';

if (process.platform !== 'darwin') {
  console.log('macOS değil — dmg mühürleme atlandı.');
  process.exit(0);
}

const distDir = path.join(import.meta.dirname, 'dist');
const images = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).filter((f) => f.endsWith('.dmg'))
  : [];

if (!images.length) {
  console.error('dist/ içinde .dmg yok. Önce "npm run dist:mac" çalıştırın.');
  process.exit(1);
}

const missing = ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Eksik ortam değişkeni: ${missing.join(', ')}`);
  process.exit(1);
}

const identity = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
  encoding: 'utf8',
})
  .split('\n')
  .map((l) => l.match(/"([^"]+)"/)?.[1])
  .find((n) => n?.startsWith(IDENTITY));

if (!identity) {
  console.error(`Anahtar Zincirinde "${IDENTITY}" sertifikası yok.`);
  process.exit(1);
}

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** Dosya zaten imzalı, notarize ve mühürlü mü? */
function alreadySealed(dmg) {
  const stapled = spawnSync('xcrun', ['stapler', 'validate', dmg], { encoding: 'utf8' });
  if (stapled.status !== 0) return false;
  const gate = spawnSync(
    'spctl',
    ['-a', '-t', 'open', '--context', 'context:primary-signature', dmg],
    { encoding: 'utf8' }
  );
  return gate.status === 0;
}

for (const name of images) {
  const dmg = path.join(distDir, name);
  console.log(`\n▸ ${name}`);

  /*
   * ⚠ MÜHÜRLÜ DOSYAYA DOKUNMUYORUZ.
   *
   * Yeniden imzalamak var olan mührü GEÇERSİZ kılıyor (`codesign` imzayı
   * değiştiriyor, mühür eski imzaya bağlı) ve dosyanın SHA-256'sını
   * değiştiriyor. Bir kez yaşandı: dağıtım için verilen parmak izi, betik
   * ikinci kez koştuğu için tutmaz hâle geldi ve dosya bir süre mühürsüz
   * kaldı. Betik artık idempotent.
   */
  if (alreadySealed(dmg)) {
    console.log('  zaten imzalı, notarize ve mühürlü — atlanıyor');
    continue;
  }

  /*
   * `--timestamp` ŞART. Zaman damgasız imza, sertifika süresi dolduğunda
   * geçersiz sayılıyor — yani bugün dağıttığınız dosya sertifika yenilenene
   * kadar çalışıp sonra açılmaz hâle geliyor.
   */
  console.log('  imzalanıyor…');
  run('codesign', ['--sign', identity, '--timestamp', '--force', dmg]);

  console.log('  notarize ediliyor (Apple kuyruğu, birkaç dakika sürebilir)…');
  const out = run('xcrun', [
    'notarytool', 'submit', dmg,
    '--apple-id', process.env.APPLE_ID,
    '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id', process.env.APPLE_TEAM_ID,
    '--wait', '--output-format', 'json',
  ]);

  const status = JSON.parse(out).status;
  if (status !== 'Accepted') {
    console.error(`  ✗ notarize sonucu: ${status}`);
    process.exit(1);
  }

  console.log('  mühürleniyor…');
  run('xcrun', ['stapler', 'staple', dmg]);

  /*
   * Doğrulama TAHMİNE bırakılmıyor: dağıtılacak dosyayı Gatekeeper'ın
   * gerçekte nasıl gördüğüne bakıyoruz.
   */
  /*
   * ⚠ `spctl` KARARINI stderr'E YAZIYOR, stdout'a değil.
   *
   * İlk hâli `execFileSync` ile stdout okuyordu; komut başarılı olduğunda
   * stdout BOŞ dönüyor ve doğrulama, dmg gerçekten kabul edilmişken bile
   * başarısız sayılıyordu. `spawnSync` iki akışı da veriyor.
   */
  const probe = spawnSync(
    'spctl',
    ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmg],
    { encoding: 'utf8' }
  );
  const verdict = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;

  const accepted = /: accepted/.test(verdict);
  console.log(`  ${accepted ? '✓' : '✗'} ${verdict.trim().split('\n').join(' · ')}`);
  if (!accepted) process.exit(1);
}

console.log('\nTamam — dmg imzalı, notarize edilmiş ve mühürlü.');
