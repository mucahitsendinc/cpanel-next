import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n/index.mjs';

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

  if (hasComposer && !hasPkg) {
    result.framework = 'laravel';
    result.blockers.push(t('detect.laravelNotSupported'));
    return result;
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    result.blockers.push(t('detect.packageJsonUnreadable', { error: err.message }));
    return result;
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  if (hasComposer && deps.next) {
    result.blockers.push(t('detect.mixedProject'));
    return result;
  }

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
