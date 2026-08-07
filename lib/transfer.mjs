import fs from 'node:fs';
import path from 'node:path';
import { isBlockedDotDir } from './packager.mjs';

/**
 * DOSYA AKTARIMI — iki yönlü, seçmeli.
 *
 * Yayın hattından farkı: burada listeyi KULLANICI seçiyor. Bu, yayın
 * hattının bütün güvenliklerinin devre dışı kalması demek —
 * `makeZipFromList` hiçbir filtre uygulamıyor: ne dotenv koruması, ne
 * sembolik bağ atlama, ne nokta-dizin engeli. Hepsi burada yeniden kuruluyor.
 */

/** Bir seferde gönderilebilecek en fazla dosya. */
export const MAX_FILES = 5000;

/**
 * Yerel seçimi göreli dosya yollarına açar.
 *
 * @param {string} dir    seçimin yapıldığı klasör
 * @param {string[]} names seçili dosya/klasör adları (yalnızca ad, yol değil)
 * @returns {{files, dotenv, symlinks, skipped, bytes, truncated}}
 */
export function collectLocal(dir, names) {
  const files = [];
  const dotenv = [];
  const symlinks = [];
  const skipped = [];
  let bytes = 0;
  let truncated = false;

  const walk = (absDir, relPrefix) => {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // okunamayan dizin sessizce atlanıyor; seçimin geri kalanı gitsin
    }

    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(absDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      /*
       * ⚠ SEMBOLİK BAĞLAR TAKİP EDİLMİYOR.
       *
       * `node_modules/.bin` gibi bağlar hedeflerine kopyalanırsa hem
       * beklenmedik dosyalar gider hem de bir döngü bütün diski
       * paketlemeye çalışır.
       */
      if (entry.isSymbolicLink()) { symlinks.push(rel); continue; }

      // Gizli araç dizinleri (.git, .idea…). `.well-known` ve `.next` serbest.
      if (entry.isDirectory() && isBlockedDotDir(entry.name)) continue;

      if (entry.isDirectory()) { walk(abs, rel); continue; }
      if (!entry.isFile()) continue;

      /*
       * `.env` AYRI LİSTEYE — engellenmiyor.
       *
       * Yayın hattı bunları asla göndermiyor ve bu doğru. Ama dosya
       * tarayıcısı genel amaçlı bir araç: kullanıcı bilerek bir `.env`
       * göndermek isteyebilir. Karar onun, ama sessizce olmuyor: onay
       * ekranında ayrıca listeleniyor.
       */
      if (entry.name.startsWith('.env')) dotenv.push(rel);

      files.push(rel);
      try { bytes += fs.statSync(abs).size; } catch { /* boyut önemsiz */ }
      if (files.length >= MAX_FILES) { truncated = true; return; }
    }
  };

  for (const name of names ?? []) {
    // ⚠ Yalnızca AD kabul ediliyor: `../..` ile seçim klasörünün dışına
    // çıkılamaz. Tarayıcıdan gelen her şey düşman kabul ediliyor.
    const safe = path.basename(String(name ?? ''));
    if (!safe || safe === '.' || safe === '..') continue;

    const abs = path.join(dir, safe);
    let stat;
    try { stat = fs.lstatSync(abs); } catch { continue; }

    if (stat.isSymbolicLink()) { symlinks.push(safe); continue; }
    if (stat.isDirectory()) {
      /*
       * Araç dizinleri AÇIKÇA SEÇİLSE BİLE atlanıyor (`.git`, `.idea`…).
       *
       * İç içe olanları atlayıp üsttekini göndermek tutarsız olurdu, ve bir
       * `.git` klasörü sunucuda hem devasa hem de tehlikeli (geçmişteki
       * bütün sırlar orada). Ama SESSİZ değil: atlananlar bildiriliyor,
       * yoksa kullanıcı gönderdiğini sanır.
       */
      if (isBlockedDotDir(safe)) { skipped.push(safe); continue; }
      walk(abs, safe);
      continue;
    }
    if (!stat.isFile()) continue;

    if (safe.startsWith('.env')) dotenv.push(safe);
    files.push(safe);
    bytes += stat.size;
    if (files.length >= MAX_FILES) { truncated = true; break; }
  }

  return { files, dotenv, symlinks, skipped, bytes, truncated };
}

/**
 * İNDİRME HEDEFİ — yol kaçışına kapalı.
 *
 * ⚠ Ad SUNUCUDAN geliyor. `../../.ssh/authorized_keys` adında bir dosya,
 * seçilen klasörün dışına yazabilseydi bu uç bir "her yere yaz" aracına
 * dönüşürdü. `basename` + `resolve` önek denetimi ikisi birden gerekiyor:
 * yalnızca `basename`, sembolik bağ üzerinden çıkışı engellemez; yalnızca
 * önek denetimi, normalleştirilmemiş yolda kandırılabilir.
 *
 * @returns {string|null} tam yol, ya da güvenli değilse null
 */
export function safeLocalTarget(dir, name) {
  const base = path.basename(String(name ?? ''));
  if (!base || base === '.' || base === '..') return null;

  const root = path.resolve(dir);
  const full = path.resolve(root, base);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/**
 * Onay ekranında gösterilecek özet.
 *
 * Sayıyı ve boyutu ÖNCEDEN söylemek, "gönder" düğmesinin ne yapacağını
 * belirsiz bırakmamak için — kullanıcı 5 dosya beklerken 40.000 dosya
 * göndermemeli.
 */
export function transferPlan(collected, { maxBytes = 0 } = {}) {
  return {
    count: collected.files.length,
    bytes: collected.bytes,
    dotenv: collected.dotenv,
    symlinks: collected.symlinks,
    skipped: collected.skipped ?? [],
    truncated: collected.truncated,
    tooBig: maxBytes > 0 && collected.bytes > maxBytes,
  };
}
