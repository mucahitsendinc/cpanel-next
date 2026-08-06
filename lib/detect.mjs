import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n/index.mjs';
import { inspectLaravel } from './laravel.mjs';

/**
 * Yerel projeyi tarar ve yayınlanabilir olup olmadığına karar verir.
 *
 * "Blocker" = bu hâliyle yayınlanırsa sunucuda KESİN patlar; durduruyoruz.
 * "Warning" = patlayabilir ama kullanıcının bilgisiyle devam edilebilir.
 *
 * Buradaki her blocker gerçek bir arıza senaryosundan geliyor, temkinden değil.
 */
export function detectProject(cwd) {
  const result = {
    dir: cwd,
    framework: 'unknown',
    router: null,
    srcDir: false,
    standalone: false,
    packageManager: 'npm',
    nextVersion: null,
    hasServerJs: false,
    startupFile: 'server.js',
    laravelVersion: null,
    assetBuilder: null,
    hasEnvExample: false,
    isEsm: false,
    deployable: false,
    blockers: [],
    warnings: [],
  };

  const pkgPath = path.join(cwd, 'package.json');
  const composerPath = path.join(cwd, 'composer.json');

  const hasComposer = fs.existsSync(composerPath) && fs.existsSync(path.join(cwd, 'artisan'));
  const hasPkg = fs.existsSync(pkgPath);

  if (!hasPkg && !hasComposer) {
    result.blockers.push(t('detect.noPackageJson'));
    return result;
  }

  /*
   * Laravel.
   *
   * `package.json` OLABİLİR (Vite/Mix ile ön yüz derlemesi) ama belirleyici
   * olan `artisan` + `composer.json` ikilisi. Bu yüzden Next.js kontrolünden
   * ÖNCE karar veriliyor: `artisan` varsa proje Laravel'dir, `package.json`
   * yalnızca varlık derlemesi içindir.
   */
  if (hasComposer) {
    return detectLaravel(cwd, result);
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    result.blockers.push(t('detect.packageJsonUnreadable', { error: err.message }));
    return result;
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  if (!deps.next) {
    result.blockers.push(t('detect.noNextDep'));
    return result;
  }

  result.framework = 'nextjs';
  result.nextVersion = cleanVersion(deps.next);
  result.isEsm = pkg.type === 'module';
  result.packageManager = detectPackageManager(cwd);

  // Router tespiti
  const hasSrc = fs.existsSync(path.join(cwd, 'src'));
  result.srcDir = hasSrc;
  const appDir = fs.existsSync(path.join(cwd, 'app')) || fs.existsSync(path.join(cwd, 'src', 'app'));
  const pagesDir = fs.existsSync(path.join(cwd, 'pages')) || fs.existsSync(path.join(cwd, 'src', 'pages'));
  result.router = appDir && pagesDir ? 'mixed' : appDir ? 'app' : pagesDir ? 'pages' : null;

  // Build betiği
  const buildScript = pkg.scripts?.build;
  if (!buildScript) {
    result.blockers.push(t('detect.noBuildScript'));
  } else if (!/\bnext\s+build\b/.test(buildScript)) {
    result.warnings.push(t('detect.buildScriptOdd', { script: buildScript }));
  }

  /* ---- standalone: özel server ile BİRLİKTE KULLANILAMAZ ---------------- */
  const nextConfig = readNextConfig(cwd);
  if (nextConfig && /output\s*:\s*['"`]standalone['"`]/.test(nextConfig.source)) {
    result.standalone = true;
    result.blockers.push(t('detect.standalone'));
  }

  /* ---- Next 13.4.x: Passenger'da yapısal olarak bozuk ------------------- */
  if (result.nextVersion && /^13\.4\./.test(result.nextVersion)) {
    result.blockers.push(t('detect.next134', { version: result.nextVersion }));
  }

  /* ---- Passenger ESM yükleyemez ---------------------------------------- */
  // Phusion Passenger başlangıç dosyasını require() ile yükler; "type": "module"
  // olan bir projede .js dosyası ESM sayılır ve ERR_REQUIRE_ESM alınır.
  result.startupFile = result.isEsm ? 'server.cjs' : 'server.js';
  result.hasServerJs = fs.existsSync(path.join(cwd, result.startupFile));
  if (result.isEsm) {
    result.warnings.push(t('detect.esmWarning'));
  }

  /* ---- Uyarılar --------------------------------------------------------- */
  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
  if (!lockfiles.some((f) => fs.existsSync(path.join(cwd, f)))) {
    result.warnings.push(t('detect.noLockfile'));
  }

  const localMajor = Number(process.versions.node.split('.')[0]);
  if (localMajor < 18) {
    result.warnings.push(t('detect.oldNode', { version: process.versions.node }));
  }

  const natives = ['sharp', 'better-sqlite3', 'bcrypt', 'canvas', 'node-gyp'].filter((n) => deps[n]);
  if (natives.length) {
    result.warnings.push(t('detect.nativeDeps', { list: natives.join(', ') }));
  }

  const major = Number(String(result.nextVersion || '').split('.')[0]);
  if (major >= 15 && !deps.sharp) {
    result.warnings.push(t('detect.sharpOptional'));
  }

  if (nextConfig && /basePath\s*:/.test(nextConfig.source)) {
    result.warnings.push(t('detect.basePath'));
  }

  result.deployable = result.blockers.length === 0;
  return result;
}

/**
 * Laravel projesi.
 *
 * Next.js'ten farklı olarak burada bir "başlangıç dosyası" yok: PHP'yi
 * Passenger değil, sunucunun kendi PHP işleyicisi çalıştırıyor. Yayınlama
 * hattı da tamamen ayrı (bkz. lib/laravel-core.mjs).
 */
function detectLaravel(cwd, result) {
  const info = inspectLaravel(cwd);

  result.framework = 'laravel';
  result.laravelVersion = info.version;
  result.hasEnvExample = info.hasEnvExample;
  result.assetBuilder = info.assetBuilder;
  result.startupFile = null;
  result.packageManager = detectPackageManager(cwd);

  /*
   * `composer.lock` ZORUNLU.
   *
   * Onsuz `vendor` klasörünün hangi sürümlere karşılık geldiği bilinemez —
   * yani "lock değişmediyse gönderme" kararı verilemez ve sunucuda kurulum
   * yapılacaksa sürümler yereldekinden kayabilir. Next tarafında tam olarak
   * bu kayma, çerçevenin içinde patlayan bir hataya yol açmıştı.
   */
  if (!info.hasLock) {
    result.blockers.push(t('detect.noComposerLock'));
  }

  if (!fs.existsSync(path.join(cwd, 'public', 'index.php'))) {
    result.blockers.push(t('detect.noPublicIndex'));
  }

  if (!fs.existsSync(path.join(cwd, 'vendor', 'autoload.php'))) {
    // Engel değil: `vendor` sunucuda kurulacaksa gerekmiyor. Ama varsayılan
    // kip yerel `vendor`'ı gönderdiği için kullanıcı bunu bilmeli.
    result.warnings.push(t('detect.noVendor'));
  }

  if (!info.hasEnvExample && !fs.existsSync(path.join(cwd, '.env'))) {
    result.warnings.push(t('detect.noEnvExample'));
  }

  if (info.assetBuilder && !fs.existsSync(path.join(cwd, 'public', 'build'))) {
    result.warnings.push(t('detect.noAssetBuild', { builder: info.assetBuilder }));
  }

  result.deployable = result.blockers.length === 0;
  return result;
}

function readNextConfig(cwd) {
  for (const name of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']) {
    const file = path.join(cwd, name);
    if (fs.existsSync(file)) {
      try {
        return { name, source: fs.readFileSync(file, 'utf8') };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function detectPackageManager(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function cleanVersion(range) {
  const m = String(range || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (m) return m[0];
  const loose = String(range || '').match(/(\d+)(?:\.(\d+))?/);
  return loose ? loose[0] : null;
}

/** Passenger başlangıç dosyası şablonu. CJS — ESM projelerde .cjs olarak yazılır. */
export const SERVER_TEMPLATE = `/**
 * Passenger başlangıç dosyası (cpanel-next tarafından oluşturuldu).
 *
 * Passenger bu dosyayı require() ile yükler ve uygulamanın listen() çağırmasını
 * bekler. Verilen port DEĞERİ ÖNEMSİZDİR: Passenger listen()'i yamalayıp
 * uygulamayı kendi Unix soketine bağlar. Ancak listen() TAM OLARAK BİR KEZ
 * çağrılmalıdır, yoksa Passenger zaman aşımına düşer.
 */
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');

const port = parseInt(process.env.PORT, 10) || 3000;
const app = next({ dev: false, dir: __dirname });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    createServer((req, res) => handle(req, res, parse(req.url, true))).listen(port);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
`;
