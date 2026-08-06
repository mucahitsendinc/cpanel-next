import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `lib/` klasörünü masaüstü uygulamasının içine kopyalar.
 *
 * ⚠ NEDEN SYMLINK DEĞİL. İlk hâli `"cpanel-next": "file:.."` bağımlılığı
 * kullanıyordu ve npm bunu repo KÖKÜNE bir sembolik bağ olarak kuruyordu.
 * Repo kökü `desktop/` klasörünü içerdiği için uygulama KENDİ KENDİNİ
 * paketledi: `.app` içinde ikinci bir Electron kopyası çıktı ve paket
 * 486 MB'a şişti. electron-builder'ın dışlama desenleri sembolik bağın
 * içine işlemedi.
 *
 * Kopyalamak sıkıcı ama öngörülebilir: ne kopyalandığı burada yazıyor.
 *
 * BAĞIMLILIKLAR DA BURADAN EŞİTLENİYOR. Elle iki yerde tutulsalardı zamanla
 * ayrışırlardı; üst paketin `package.json`'ı tek kaynak.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TARGET = path.join(HERE, 'app-lib');

/** Sunucunun çalışması için gerekmeyen, yalnızca yer kaplayan yollar. */
const SKIP = new Set(['node_modules', '.git']);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

fs.rmSync(TARGET, { recursive: true, force: true });
copyDir(path.join(ROOT, 'lib'), TARGET);

const parent = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const own = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));

own.dependencies = { ...(parent.dependencies ?? {}) };
own.optionalDependencies = { ...(parent.optionalDependencies ?? {}) };
own.version = parent.version;

fs.writeFileSync(path.join(HERE, 'package.json'), `${JSON.stringify(own, null, 2)}\n`);

const count = countFiles(TARGET);
console.log(`app-lib: ${count} dosya · sürüm ${parent.version}`);

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}
