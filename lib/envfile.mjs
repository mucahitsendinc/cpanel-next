/**
 * `.env` dosyası okuma/yazma — tamamen saf.
 *
 * Neden var: veritabanı oluşturmak, bağlantı dizesi uygulamaya ULAŞMADIKÇA
 * yarım bir iş. Ortam dosyaları pakete hiç girmiyor (packager izin listesiyle
 * dışarıda tutuyor), yani sunucudaki `.env` dosyasını yazabilmek tek yol.
 *
 * Neden hazır bir kütüphane değil: `dotenv` OKUR ama YAZMAZ. Var olan dosyayı
 * ayrıştırıp yeniden üretmek yorumları ve sıralamayı yok eder — kullanıcının
 * elle yazdığı bir dosyanın üstüne bunu yapamayız. Buradaki `upsertEnv` yalnız
 * DEĞİŞEN satıra dokunur, gerisini bayt bayt korur.
 */

/**
 * Anahtar/değer okur. Yorumlar ve boş satırlar atlanır.
 *
 * `export KEY=value` biçimi de tanınır (kabuk alışkanlığı; sık yazılıyor).
 */
export function parseEnv(content) {
  const out = {};
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const m = matchLine(line);
    if (m) out[m.key] = unquote(m.value);
  }
  return out;
}

/**
 * Anahtarları ekler ya da günceller; dosyanın geri kalanına DOKUNMAZ.
 *
 * Var olan anahtar yerinde güncellenir (sıralama korunur), yeni anahtar sona
 * eklenir. Dosya sonundaki yeni satır garanti edilir — eksikse bir sonraki
 * ekleme öncekiyle aynı satırda birleşiyordu.
 *
 * @param {string} content   mevcut dosya (yoksa '')
 * @param {Record<string,string>} entries
 * @returns {{content: string, added: string[], updated: string[], unchanged: string[]}}
 */
export function upsertEnv(content, entries) {
  const lines = String(content ?? '').split(/\r?\n/);
  const added = [];
  const updated = [];
  const unchanged = [];
  const pending = new Map(Object.entries(entries ?? {}));

  for (let i = 0; i < lines.length; i += 1) {
    const m = matchLine(lines[i]);
    if (!m || !pending.has(m.key)) continue;
    const value = String(pending.get(m.key));
    pending.delete(m.key);
    if (unquote(m.value) === value) {
      unchanged.push(m.key);
      continue;
    }
    lines[i] = `${m.exported ? 'export ' : ''}${m.key}=${quote(value)}`;
    updated.push(m.key);
  }

  // Sondaki boş satırları kırp; birazdan tek bir yeni satırla kapatacağız.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

  if (pending.size) {
    if (lines.length) lines.push('');
    for (const [key, value] of pending) {
      lines.push(`${key}=${quote(String(value))}`);
      added.push(key);
    }
  }

  return { content: lines.length ? `${lines.join('\n')}\n` : '', added, updated, unchanged };
}

/** Anahtarı siler. Dosyada yoksa içerik aynen döner. */
export function removeEnv(content, key) {
  const lines = String(content ?? '').split(/\r?\n/);
  const kept = lines.filter((line) => matchLine(line)?.key !== key);
  const changed = kept.length !== lines.length;
  const body = kept.join('\n').replace(/\n+$/, '');
  return { content: body ? `${body}\n` : '', changed };
}

/**
 * Değeri ekranda gösterirken sırları maskeler.
 *
 * Arayüz sunucudaki `.env` dosyasını listeliyor. Şifre içeren bir değeri düz
 * göstermek, ekran paylaşımında ya da bir ekran görüntüsünde onu sızdırmak
 * demek — bu yüzden görünürlük AÇIK BİR TERCİH olmalı.
 */
export function maskValue(key, value) {
  const secret = /(PASS|SECRET|TOKEN|KEY|SALT|CREDENTIAL|PRIVATE|DSN|DATABASE_URL|CONNECTION)/i.test(key);
  const v = String(value ?? '');
  if (!secret || v.length <= 4) return secret ? '••••' : v;
  return `${v.slice(0, 2)}${'•'.repeat(Math.min(20, v.length - 4))}${v.slice(-2)}`;
}

/* --------------------------------------------------------------- iç kısım */

const LINE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function matchLine(line) {
  if (/^\s*(#|$)/.test(line)) return null;
  const m = LINE.exec(line);
  if (!m) return null;
  return { exported: Boolean(m[1]), key: m[2], value: m[3] };
}

function unquote(raw) {
  const v = String(raw ?? '').trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\([\\"$n])/g, (_, c) => (c === 'n' ? '\n' : c)) : inner;
  }
  // Tırnaksız değerlerde satır sonu yorumu: `KEY=value # not`
  return v.replace(/\s+#.*$/, '');
}

/**
 * Gerektiğinde tırnaklar.
 *
 * `$` de kaçırılıyor: Next.js `dotenv-expand` kullanıyor ve tırnak içindeki
 * `$DB` bir başka değişken sanılıp SESSİZCE boşa çevriliyor. Bağlantı dizesi
 * bozulduğunda hata veritabanından geliyor, buradan değil — bulması zor.
 */
function quote(value) {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value) && value !== '') return value;
  return `"${value.replace(/[\\"$]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')}"`;
}
