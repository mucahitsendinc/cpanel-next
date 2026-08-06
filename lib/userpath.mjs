import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Kullanıcının GERÇEK `PATH`'ini bulur.
 *
 * ⚠ macOS'ta Finder'dan açılan bir uygulama kabuk PATH'ini ALMIYOR. Terminal
 * `~/.zshrc` gibi dosyaları okuyup PATH'i kuruyor; Dock'tan başlatılan bir
 * süreç ise `launchd`'den geliyor ve orada genelde `/usr/bin:/bin:/usr/sbin:
 * /sbin` bile tam olmuyor.
 *
 * Sonucu canlıda görüldü: masaüstü uygulaması Laravel varlıklarını derlemeye
 * çalışıp `spawn npm ENOENT` verdi — `npm` `/usr/local/bin`de duruyordu ama
 * uygulamanın PATH'inde o dizin yoktu. Aynı komut terminalden sorunsuz
 * çalışıyordu, ve fark tam olarak buydu.
 *
 * Çözüm: kullanıcının giriş kabuğuna PATH'ini SORMAK. `fix-path` gibi
 * paketlerin yaptığı da bu; bir bağımlılık eklemek yerine on satırla
 * yapılabiliyor.
 */

/** Kabuk cevap vermezse denenecek yaygın konumlar. */
const FALLBACKS = [
  '/opt/homebrew/bin', // Apple Silicon Homebrew
  '/usr/local/bin', // Intel Homebrew ve resmî Node kurulumu
  '/opt/local/bin', // MacPorts
  `${os.homedir()}/.volta/bin`,
  `${os.homedir()}/.bun/bin`,
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

/**
 * Giriş kabuğundan PATH okur.
 *
 * `-ilc`: interaktif + giriş kabuğu, yani `.zshrc` ve `.zprofile` okunuyor —
 * nvm/volta gibi sürüm yöneticileri PATH'i orada kuruyor ve başka yolla
 * bulunamıyorlar.
 *
 * ⚠ ZAMAN AŞIMI ŞART. Kullanıcının kabuk yapılandırması yavaş olabilir ya da
 * girdi bekleyebilir; uygulamanın açılışını buna bağlamak onu hiç açılmaz hâle
 * getirir. Cevap gelmezse yedek listeyle devam ediyoruz.
 */
export function shellPath({ timeout = 3000 } = {}) {
  const shell = process.env.SHELL;
  if (!shell || !fs.existsSync(shell)) return null;
  try {
    const out = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * İki PATH'i birleştirir: sıra korunur, yinelenenler ve var olmayan dizinler
 * atılır.
 *
 * Saf fonksiyon — `exists` enjekte edilebiliyor ki test dosya sistemine
 * bağlı kalmasın.
 */
export function mergePath(...parts) {
  const exists = typeof parts[parts.length - 1] === 'function' ? parts.pop() : fs.existsSync;
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    for (const dir of String(part ?? '').split(path.delimiter)) {
      const clean = dir.trim().replace(/\/+$/, '');
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      if (exists(clean)) out.push(clean);
    }
  }
  return out.join(path.delimiter);
}

/**
 * `process.env.PATH`'i kullanıcının gerçek PATH'iyle genişletir.
 *
 * Mevcut PATH ÖNCE geliyor: uygulamayı terminalden başlatan biri kendi
 * ortamını görmeye devam etsin.
 *
 * @returns {{path: string, fromShell: boolean}}
 */
export function ensureUserPath() {
  const fromShell = shellPath();
  const merged = mergePath(process.env.PATH, fromShell, FALLBACKS.join(path.delimiter));
  process.env.PATH = merged;
  return { path: merged, fromShell: Boolean(fromShell) };
}

export { FALLBACKS };
