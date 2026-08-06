/**
 * Yaşam döngüsü hook'ları — `.cpanel-next.json` içindeki `hooks` alanı.
 *
 * Bu dosyanın tamamı SAF: ağ yok, dosya sistemi yok. Sebebi, hook tanımının
 * kullanıcı tarafından elle yazılan tek serbest metin alanı olması — yani
 * doğrulamanın test edilebilir ve tek bir yerde olması gerekiyor.
 *
 * Eskiden doğrulama hiç yoktu ve `"postInstall": "npm run x"` (dizi yerine
 * düz metin) yazmak sessizce KARAKTER KARAKTER dönen bir döngü üretiyordu:
 * `for (const cmd of hooks.postInstall)` her harf için ayrı bir kabuk komutu
 * demekti. Hata mesajı da yoktu; deploy anlamsız bir yerde patlıyordu.
 */

export const HOOK_STAGES = ['preInstall', 'postInstall', 'postStart'];

/**
 * Ham `hooks` nesnesini güvenli hâle getirir.
 *
 * Tek metin verilmişse tek elemanlı diziye çevrilir (yaygın ve makul bir
 * yazım). Bilinmeyen aşama adları ve kullanılamayacak değerler ATILMAZ —
 * uyarı olarak döner, çünkü sessizce yok saymak kullanıcının komutunun neden
 * çalışmadığını anlamasını imkânsız kılar.
 *
 * @returns {{hooks: Record<string,string[]>, warnings: string[], count: number}}
 */
export function normalizeHooks(raw) {
  const hooks = {};
  const warnings = [];
  let count = 0;

  if (raw === null || raw === undefined) return { hooks, warnings, count };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { hooks, warnings: ['hooks: nesne olmalı / must be an object'], count };
  }

  for (const [stage, value] of Object.entries(raw)) {
    if (!HOOK_STAGES.includes(stage)) {
      warnings.push(`hooks.${stage}: ${HOOK_STAGES.join(' | ')}`);
      continue;
    }
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list)) {
      warnings.push(`hooks.${stage}: dizi olmalı / must be an array`);
      continue;
    }
    const commands = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) {
        warnings.push(`hooks.${stage}: ${JSON.stringify(item)}`);
        continue;
      }
      commands.push(item.trim());
    }
    if (commands.length) {
      hooks[stage] = commands;
      count += commands.length;
    }
  }

  return { hooks, warnings, count };
}

/** Tanımlı hook var mı — uyarı basmadan önce sorulan soru. */
export function hasHooks(hooks) {
  return HOOK_STAGES.some((stage) => (hooks?.[stage] ?? []).length > 0);
}
