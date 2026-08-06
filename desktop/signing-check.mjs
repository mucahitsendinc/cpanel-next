import { execFileSync } from 'node:child_process';

/**
 * İmzalama ön denetimi.
 *
 * Neden var: `electron-builder` eksik bir kurulumda SESSİZCE devam ediyor.
 * Uygun sertifika bulamazsa eline geçen ilk kimliği deniyor, üç kez tekrar
 * ediyor ve sonunda imzasız ya da yanlış imzalı bir uygulama üretiyor —
 * hata mesajı build günlüğünün ortasında kayboluyor. Sorunu derlemeden ÖNCE
 * ve tek ekranda söylemek gerekiyor.
 */

const NEEDED = 'Developer ID Application';
const ENV = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

if (process.platform !== 'darwin') {
  console.log('macOS değil — imzalama denetimi atlandı.');
  process.exit(0);
}

let identities = '';
try {
  identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
} catch {
  fail('Anahtar Zinciri okunamadı (security find-identity başarısız).');
}

const rows = identities
  .split('\n')
  .map((l) => l.match(/"([^"]+)"/)?.[1])
  .filter(Boolean);

console.log('Bulunan sertifikalar:');
for (const r of rows) console.log(`  · ${r}`);

const developerId = rows.filter((r) => r.startsWith(NEEDED));
const problems = [];

if (!developerId.length) {
  problems.push(
    `"${NEEDED}" sertifikası YOK.\n` +
      '    Elindeki "Apple Development" yalnızca kendi cihazında geliştirme,\n' +
      '    "Apple Distribution" ise App Store içindir. İndirilen bir .dmg için\n' +
      '    Developer ID gerekiyor.\n' +
      '    developer.apple.com → Certificates → + → Developer ID Application'
  );
} else if (developerId.length > 1) {
  // Birden çok varsa electron-builder hangisini seçeceğini bilemez.
  problems.push(
    `Birden çok Developer ID sertifikası var; hangisinin kullanılacağını\n` +
      '    CSC_NAME ile belirtin:\n' +
      developerId.map((d) => `      CSC_NAME="${d}"`).join('\n')
  );
}

const missingEnv = ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  problems.push(
    `Notarization için eksik ortam değişkenleri: ${missingEnv.join(', ')}\n` +
      '    APPLE_ID                    Apple hesabınızın e-postası\n' +
      '    APPLE_APP_SPECIFIC_PASSWORD appleid.apple.com → Uygulamaya Özel Şifre\n' +
      '    APPLE_TEAM_ID               developer.apple.com → Membership → Team ID'
  );
}

if (!problems.length) {
  console.log(`\n✓ Hazır: ${developerId[0]}`);
  console.log('  npm run build:mac');
  process.exit(0);
}

console.log('');
for (const p of problems) console.log(`✗ ${p}\n`);
console.log('Bu adımlar tamamlanmadan üretilen .dmg, indiren kişide');
console.log('"bozuk / doğrulanamadı" uyarısı verir.');
process.exit(1);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
