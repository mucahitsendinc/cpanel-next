import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EXCLUDES } from './packager.mjs';

/**
 * GÖNDERİLMEYECEKLER — tek kaynak.
 *
 * Üç yerden besleniyor ve üçü de EKLEMELİ:
 *
 *   1. `DEFAULT_EXCLUDES`      — aracın kendi listesi (node_modules, .git…)
 *   2. `.deployignore`         — projenin kendi dosyası, .gitignore söz dizimi
 *   3. `.cpanel-next.json` → `exclude`  — eski alan, korunuyor
 *
 * ⚠ BU MODÜLÜN VARLIK SEBEBİ BİR KUSUR.
 *
 * `exclude` alanı zaten vardı ama YALNIZCA terminal komutu onu okuyordu
 * (`commands/deploy.mjs`). Web arayüzü ve masaüstü uygulaması her çağrıda
 * düz `DEFAULT_EXCLUDES` veriyordu — yani kullanıcı ayarı yazıyor, `deploymanager`
 * ile çalışıyor, uygulamadan yayınlayınca sessizce yok sayılıyordu. Aynı
 * listeyi iki yerde kurmak yerine artık herkes buradan alıyor.
 */

export const IGNORE_FILE = '.deployignore';

/**
 * `.deployignore` metnini desen listesine çevirir.
 *
 * `.gitignore` söz dizimi, iki bilinçli farkla:
 *
 *   · Sondaki `/` (`docs/`) `docs/**`a çevriliyor — mevcut eşleştirici
 *     (`buildExcludeMatcher`) dizinleri böyle anlıyor.
 *   · TERS DESEN (`!kural`) DESTEKLENMİYOR. Eşleştiricide karşılığı yok ve
 *     yarım desteklemek, kullanıcının "bunu gönder" dediği dosyanın sessizce
 *     gitmemesi demek olurdu. Satır atlanıyor ve uyarı üretiliyor.
 *
 * @returns {{patterns: string[], warnings: string[]}}
 */
export function parseDeployIgnore(text) {
  const patterns = [];
  const warnings = [];

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('!')) {
      warnings.push(`${IGNORE_FILE}: "${line}" — ters desen desteklenmiyor, atlandı`);
      continue;
    }

    // Baştaki `/` "kökten itibaren" demek; bizim yollarımız zaten köke göreli.
    let pattern = line.replace(/^\/+/, '');
    if (!pattern) continue;

    if (pattern.endsWith('/')) pattern = `${pattern}**`;

    patterns.push(pattern);
  }

  return { patterns, warnings };
}

/** Proje kökündeki `.deployignore`. Yoksa boş. */
export function loadDeployIgnore(cwd) {
  try {
    return parseDeployIgnore(fs.readFileSync(path.join(cwd, IGNORE_FILE), 'utf8'));
  } catch {
    return { patterns: [], warnings: [] };
  }
}

/**
 * Bir proje için geçerli TAM hariç tutma listesi.
 *
 * `base` verilebiliyor çünkü Laravel kendi listesiyle başlıyor
 * (`LARAVEL_EXCLUDES`), Next varsayılanla.
 *
 * @returns {{excludes: string[], warnings: string[], fromIgnore: number, fromConfig: number}}
 */
export function resolveExcludes(cwd, { base = DEFAULT_EXCLUDES, projectExclude = null } = {}) {
  const ignore = loadDeployIgnore(cwd);

  const fromConfig = Array.isArray(projectExclude)
    ? projectExclude.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
    : [];

  return {
    excludes: [...base, ...ignore.patterns, ...fromConfig],
    warnings: ignore.warnings,
    fromIgnore: ignore.patterns.length,
    fromConfig: fromConfig.length,
  };
}
