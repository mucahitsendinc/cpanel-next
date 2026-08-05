import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * Yerel derleme + paketleme.
 *
 * Build DAİMA yerelde koşar. CloudLinux'un LVE bellek sınırı varsayılan
 * 1 GB'dır ve CloudLinux'un kendi dokümanı `npm build`in OOM verdiğini yazar;
 * paylaşımlı hesapta Next derlemek güvenilir değil. Sunucuya hazır `.next`
 * gider, orada yalnızca bağımlılıklar kurulur.
 */

/**
 * Gönderilecek `package.json`'ı lockfile'daki KESİN sürümlere sabitler.
 *
 * ⚠ Canlı bir hesapta bulunan en sinsi arıza buydu.
 *
 * `"next": "^16.1.1"` yazan bir projede build yerelde 16.1.1 ile koşuyor ve
 * `.next` o sürümün iç yapısına göre üretiliyor. Sunucuda `npm install` ise
 * `^` yüzünden 16.3.0 çekiyor. 16.1.1 için derlenmiş çıktıyı 16.3.0
 * çalıştırınca uygulama, ÇERÇEVENİN İÇİNDE `undefined.map` ile çöküyor —
 * yığın izi `at ignore-listed frames` diyor, yani kullanıcı kendi kodunda
 * hiçbir ipucu göremiyor. Ölçülen: build next 16.1.1 / react 19.2.3,
 * sunucuda kurulan 16.3.0 / 19.2.8.
 *
 * `package-lock.json` sunucuya gidiyor ama CloudLinux'un `install-modules`
 * komutu ona uymuyor. Bu yüzden sürümü, npm'in yok sayamayacağı tek yere
 * yazıyoruz: `package.json`'ın kendisine. Yalnızca GÖNDERİLEN kopya değişiyor,
 * kullanıcının dosyasına dokunulmuyor.
 *
 * Bu aynı zamanda `output: 'standalone'` ile "çalışıyor" görünmesinin
 * açıklaması: standalone, build sırasındaki node_modules'ü pakete gömdüğü için
 * sunucuda `npm install` hiç koşmuyor, dolayısıyla kayma da olmuyor.
 */
export function pinToLockfile(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  const lockPath = path.join(cwd, 'package-lock.json');
  if (!fs.existsSync(pkgPath) || !fs.existsSync(lockPath)) return null;

  let pkg;
  let lock;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null; // bozuk JSON: sabitleme yapma ama deploy'u da durdurma
  }

  const locked = lock.packages ?? {};
  const pinned = [];

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      const version = locked[`node_modules/${name}`]?.version;
      if (!version) continue;

      const current = String(deps[name]);
      /*
       * Yalnızca sürüm ARALIKLARINA dokunuyoruz. `file:`, `link:`, `git+…`,
       * `npm:takma-ad@…` ve `workspace:` tanımlarının üzerine kesin sürüm
       * yazmak bağımlılığı tamamen başka bir pakete çevirir — onlara elimizi
       * sürmüyoruz.
       */
      if (!/^[\^~>=<v\s]*\d/.test(current) && current !== '*' && current !== 'latest') continue;
      if (current === version) continue;

      deps[name] = version;
      pinned.push(`${name} ${current} → ${version}`);
    }
  }

  if (!pinned.length) return null;
  return { content: `${JSON.stringify(pkg, null, 2)}\n`, pinned };
}

export const DEFAULT_EXCLUDES = [
  // asla gönderilmez
  'node_modules/**',
  '.git/**',
  '.next/cache/**',
  '.next/dev/**',
  // editör ve araç meta klasörleri — sunucuda hiçbir işe yaramazlar ve
  // bazıları yerel not/yapılandırma barındırır
  '.vscode/**',
  '.idea/**',
  '.cursor/**',
  '.claude/**',
  '.turbo/**',
  '.vercel/**',
  '.github/**',
  'coverage/**',
  'test/**',
  'tests/**',
  '__tests__/**',
  // yerel durum
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '*.old',
  '*.bak',
  '*.swp',
  '*.zip',
  '*.rar',
  '*.tar',
  '*.tar.gz',
  // veritabanı/yedek dosyaları — yanlışlıkla müşteri verisi göndermeyelim
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.sql',
  '*.sql.gz',
  'backups/**',
  'backup/**',
  // aracın kendi dosyaları
  '.cpanel-next.json',
  '.cpanel-next-owner.json',
];

/**
 * Dotenv ailesinden bir dosya mı?
 *
 * `.env`, `.env.local`, `.env.bak-20260803`, `.env.production.save` … hepsi.
 * Yedek dosya adı serbest metindir; desen kovalamak kapanmayan bir listedir.
 */
function isDotenv(relPath) {
  return path.posix.basename(relPath).startsWith('.env');
}

export function buildExcludeMatcher(patterns) {
  const compiled = patterns.map((p) => ({ raw: p, test: compile(p) }));
  return (rel) => compiled.find((c) => c.test(rel))?.raw ?? null;

  function compile(pattern) {
    const norm = pattern.replace(/\\/g, '/').trim();
    if (norm.endsWith('/**')) {
      const base = norm.slice(0, -3);
      return (rel) => rel === base || rel.startsWith(`${base}/`);
    }
    const re = globToRegExp(norm);
    if (!norm.includes('/')) return (rel) => re.test(path.posix.basename(rel));
    return (rel) => re.test(rel);
  }
}

function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += /[\\^$+.()|[\]{}]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/* ------------------------------------------------------------------ build */

export async function buildProject(cwd, { packageManager = 'npm', onOutput } = {}) {
  const buildIdPath = path.join(cwd, '.next', 'BUILD_ID');
  const before = fs.existsSync(buildIdPath) ? fs.statSync(buildIdPath).mtimeMs : 0;
  const startedAt = Date.now();

  const cmd = packageManager === 'npm' ? 'npm' : packageManager;
  const args = packageManager === 'npm' ? ['run', 'build'] : ['run', 'build'];

  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: onOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32',
    });
    child.stdout?.on('data', (d) => onOutput?.(d.toString()));
    child.stderr?.on('data', (d) => onOutput?.(d.toString()));
    child.on('error', (err) =>
      reject(new UserError(t('packager.buildStartFailed', { error: err.message }), t('packager.buildStartHint', { cmd })))
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new UserError(t('packager.buildFailed', { code })))
    );
  });

  // Build gerçekten koştu mu? Betik "build" adını taşıyıp hiçbir şey yapmıyor
  // olabilir; o zaman eski .next'i yayınlamış oluruz ve bunu fark etmeyiz.
  if (!fs.existsSync(buildIdPath)) {
    throw new UserError(t('packager.noBuildId'), t('packager.noBuildIdHint'));
  }
  const after = fs.statSync(buildIdPath).mtimeMs;
  if (after <= before && after < startedAt) {
    throw new UserError(t('packager.staleBuildId'), t('packager.staleBuildIdHint'));
  }
  return { buildId: fs.readFileSync(buildIdPath, 'utf8').trim() };
}

/* ------------------------------------------------------------------- zip */

/**
 * Projeyi zip'ler.
 *
 * DOTENV İÇİN İZİN LİSTESİ — desen avlamak DEĞİL. Dotenv ailesinden olup
 * `allowEnv` içinde ADI GEÇMEYEN her dosya elenir. Bunun sebebi somut: aynı
 * hattın önceki sürümünde `.env` tam eşleşmeyle dışlanıyordu ve anahtar
 * rotasyonundan kalan `.env.bak-rotasyon-…` (gerçek .env'in birebir kopyası)
 * desene uymadığı için üç yayınlanmış pakete girdi. İzin listesi sonludur,
 * desen listesi değildir.
 */
export async function makeZip(cwd, {
  excludes = DEFAULT_EXCLUDES,
  allowEnv = [],
  extraFiles = [],
  outDir = null,
} = {}) {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip();
  const matcher = buildExcludeMatcher(excludes);
  const allow = new Set(allowEnv.map((f) => f.replace(/\\/g, '/')));

  const included = [];
  const skippedEnv = [];
  let totalBytes = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(cwd, abs).split(path.sep).join('/');

      if (entry.isFile() && isDotenv(rel) && !allow.has(rel)) {
        skippedEnv.push(rel);
        continue;
      }
      if (matcher(rel)) continue;

      if (entry.isSymbolicLink()) continue; // sembolik bağları takip etme
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        zip.addLocalFile(abs, path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));
        included.push(rel);
        totalBytes += stat.size;
      }
    }
  };

  walk(cwd);

  for (const extra of extraFiles) {
    zip.addFile(extra.path, Buffer.from(extra.content, 'utf8'));
    included.push(extra.path);
    totalBytes += Buffer.byteLength(extra.content);
  }

  const dir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cpanel-next-'));
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, 'pkg.zip');
  zip.writeZip(zipPath);

  const buffer = fs.readFileSync(zipPath);
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  return {
    zipPath,
    dir,
    sha256,
    size: buffer.length,
    fileCount: included.length,
    rawBytes: totalBytes,
    included,
    skippedEnv,
  };
}

/**
 * Verilen dosya listesinden zip üretir.
 *
 * Çok parçalı yükleme yolu kullanıyor: aynı `included` listesi parçalara
 * bölünüp her parça ayrı zip'lenir, sunucuda hepsi AYNI dizine açılır.
 */
export async function makeZipFromList(cwd, files, { extraFiles = [], name = 'pkg.zip', outDir = null } = {}) {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip();

  for (const rel of files) {
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) continue;
    const dirName = path.posix.dirname(rel);
    zip.addLocalFile(abs, dirName === '.' ? '' : dirName);
  }
  for (const extra of extraFiles) {
    zip.addFile(extra.path, Buffer.from(extra.content, 'utf8'));
  }

  const dir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cpanel-next-'));
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, name);
  zip.writeZip(zipPath);

  const buffer = fs.readFileSync(zipPath);
  return {
    zipPath,
    dir,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
    fileCount: files.length + extraFiles.length,
  };
}

/** Paket içeriğinin özetini (--dry-run için) zip yazmadan çıkarır. */
export function planZip(cwd, { excludes = DEFAULT_EXCLUDES, allowEnv = [] } = {}) {
  const matcher = buildExcludeMatcher(excludes);
  const allow = new Set(allowEnv);
  const included = [];
  const excluded = new Map();
  const skippedEnv = [];
  let bytes = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(cwd, abs).split(path.sep).join('/');

      if (entry.isFile() && isDotenv(rel) && !allow.has(rel)) {
        skippedEnv.push(rel);
        continue;
      }
      const hit = matcher(rel);
      if (hit) {
        const prev = excluded.get(hit) || { count: 0, bytes: 0 };
        const size = entry.isFile() ? safeSize(abs) : dirSize(abs);
        excluded.set(hit, { count: prev.count + 1, bytes: prev.bytes + size });
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        included.push(rel);
        bytes += safeSize(abs);
      }
    }
  };

  walk(cwd);
  return { included, excluded, skippedEnv, bytes };
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function dirSize(p) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const abs = path.join(p, e.name);
      if (e.isDirectory()) total += dirSize(abs);
      else if (e.isFile()) total += safeSize(abs);
    }
  } catch {
    /* okunamıyorsa 0 */
  }
  return total;
}
