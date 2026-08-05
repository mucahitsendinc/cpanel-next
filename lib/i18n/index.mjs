import tr from './locales/tr.mjs';
import en from './locales/en.mjs';

/**
 * Basit i18n.
 *
 * Sözlük yerine bir kütüphane kullanmıyoruz: bu araç için gereken tek şey
 * "anahtar → metin" ve `{isim}` yer tutucuları. ICU çoğullaması, tarih
 * biçimlendirme ya da tembel yükleme gerekmiyor; onları getirmek bağımlılık
 * eklemek olurdu.
 *
 * Eksik anahtar SESSİZCE GEÇİLMEZ: anahtarın kendisi basılır. Böylece eksik
 * çeviri gözden kaçmaz ama kullanıcı da boş bir ekranla kalmaz.
 */

const LOCALES = { tr, en };
export const AVAILABLE = Object.keys(LOCALES);
const FALLBACK = 'en';

let current = FALLBACK;
let dict = LOCALES[FALLBACK];

/**
 * Dil seçimi. Sıra: açık ayar → CPANEL_NEXT_LANG → sistem yereli → en.
 *
 * Sistem yerelini `LC_ALL`/`LC_MESSAGES`/`LANG`'dan okuyoruz; Intl'in
 * çözdüğü yerel Node'da her zaman ortam değişkenini yansıtmıyor.
 */
export function detectLocale(explicit = null) {
  const candidates = [
    explicit,
    process.env.CPANEL_NEXT_LANG,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    const code = String(raw).toLowerCase().split(/[._-]/)[0];
    if (LOCALES[code]) return code;
  }

  try {
    const code = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().split('-')[0];
    if (LOCALES[code]) return code;
  } catch {
    /* Intl yoksa varsayılana düş */
  }

  return FALLBACK;
}

export function setLocale(lang) {
  const code = LOCALES[lang] ? lang : FALLBACK;
  current = code;
  dict = LOCALES[code];
  return code;
}

export function getLocale() {
  return current;
}

/**
 * Metni getirir.
 *
 * `t('deploy.title')` · `t('deploy.files', { count: 12 })`
 *
 * Değer bir fonksiyonsa parametrelerle çağrılır — çoğul ve koşullu metinler
 * için sözlükte küçük bir fonksiyon yazmak, şablon diline gerek bırakmıyor.
 */
export function t(key, params = {}) {
  const value = lookup(dict, key) ?? lookup(LOCALES[FALLBACK], key);

  if (value === undefined || value === null) return key;
  if (typeof value === 'function') return value(params);
  // Diziler olduğu gibi döner — tablo başlıkları böyle tanımlanıyor.
  // `String(value)` demek onları virgüllü tek bir metne çevirirdi.
  if (Array.isArray(value)) return value.map((item) => interpolate(String(item), params));
  return interpolate(String(value), params);
}

function lookup(source, key) {
  let node = source;
  for (const part of String(key).split('.')) {
    if (node === undefined || node === null) return undefined;
    node = node[part];
  }
  return node;
}

function interpolate(text, params) {
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] === undefined ? match : String(params[name])
  );
}

// Süreç başlarken bir kez çözülür; komutlar --lang ile değiştirebilir.
setLocale(detectLocale());
