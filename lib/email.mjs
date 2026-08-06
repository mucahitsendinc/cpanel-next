import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';
import { generatePassword } from './mysql.mjs';

/**
 * E-posta hesapları — saf UAPI.
 *
 * cPanel'in bu alandaki API'si eksiksiz: listeleme, açma, silme, şifre ve
 * kota. Bağlantı ayarları (SMTP/IMAP sunucu, port, güvenlik) da API'den
 * geliyor — elle "mail.domain.com, 465, SSL" yazmak yerine sunucunun
 * söylediğini gösteriyoruz, çünkü host bunları değiştirmiş olabilir.
 */

/** `sonsuz` yerine null: kota sınırsızsa arayüz bunu ayrı göstermeli. */
const UNLIMITED = new Set(['unlimited', 'Unlimited', '0', 0, '']);

export async function listAccounts(client, { domain = null } = {}) {
  const rows = asArray(
    await client.uapi('Email', 'list_pops_with_disk', domain ? { domain } : {})
  );

  return rows
    .map((r) => {
      const email = String(pick(r, ['email', 'user'], ''));
      return {
        email,
        login: String(pick(r, ['login'], email)),
        domain: String(pick(r, ['domain'], email.split('@')[1] ?? '')),
        used: toBytes(pick(r, ['_diskused', 'diskused', 'diskusedbytes'], 0)),
        quota: quotaOf(pick(r, ['_diskquota', 'diskquota', 'humandiskquota'], null)),
        suspended: Boolean(Number(pick(r, ['suspended_login', 'suspended'], 0))),
      };
    })
    .filter((a) => a.email && a.email.includes('@'));
}

/** Hesabın posta domainleri — yeni adres açarken seçtiriyoruz. */
export async function listDomains(client) {
  const rows = asArray(await client.uapi('Email', 'list_mail_domains', {}));
  return rows
    .map((r) => String(typeof r === 'string' ? r : pick(r, ['domain'], '')))
    .filter(Boolean);
}

/**
 * Yeni e-posta hesabı.
 *
 * Şifre verilmezse üretiliyor ve BİR KEZ gösteriliyor — veritabanı tarafındaki
 * kuralla aynı, aynı gerekçeyle: cPanel de biz de sonradan okuyamıyoruz.
 *
 * `quota` MiB cinsinden; 0 sınırsız demek (cPanel'in kendi kuralı).
 */
export async function createAccount(client, { user, domain, password = null, quota = 0 }) {
  const local = String(user ?? '').trim().toLowerCase();
  if (!local || !domain) throw new UserError(t('mail.emailRequired'));
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(local)) {
    throw new UserError(t('mail.invalidLocal', { name: local }), t('mail.invalidLocalHint'));
  }

  const pass = password || generatePassword();
  await client.uapiPost('Email', 'add_pop', {
    email: local,
    domain,
    password: pass,
    quota: String(quota ?? 0),
  });

  return { email: `${local}@${domain}`, password: password ? null : pass, quota: Number(quota ?? 0) };
}

export async function setPassword(client, email, password = null) {
  const [local, domain] = splitEmail(email);
  const pass = password || generatePassword();
  await client.uapiPost('Email', 'passwd_pop', { email: local, domain, password: pass });
  return { email, password: pass };
}

export async function setQuota(client, email, quota) {
  const [local, domain] = splitEmail(email);
  await client.uapiPost('Email', 'edit_pop_quota', { email: local, domain, quota: String(quota) });
}

export async function deleteAccount(client, email) {
  const [local, domain] = splitEmail(email);
  await client.uapiPost('Email', 'delete_pop', { email: local, domain });
}

/**
 * Posta istemcisi ayarları — SMTP/IMAP/POP3.
 *
 * Sunucudan SORULUYOR, varsayılmıyor: hostlar portları ve sunucu adını
 * değiştirebiliyor ve yanlış bir "mail.domain.com:465" kullanıcıyı saatlerce
 * uğraştırıyor.
 */
export async function clientSettings(client, email) {
  const raw = await client.uapi('Email', 'get_client_settings', { account: email });
  const src = raw?.ssl ?? raw?.SSL ?? raw ?? {};
  const plain = raw?.plain ?? raw?.Plain ?? {};

  const port = (obj, keys) => {
    const v = pick(obj, keys, null);
    return v === null ? null : Number(v) || null;
  };

  return {
    account: email,
    secure: {
      host: pick(src, ['mail_domain', 'inbox_host', 'smtp_host'], null),
      imap: port(src, ['imap_port']),
      pop3: port(src, ['pop3_port']),
      smtp: port(src, ['smtp_port']),
    },
    plain: {
      host: pick(plain, ['mail_domain', 'inbox_host', 'smtp_host'], null),
      imap: port(plain, ['imap_port']),
      pop3: port(plain, ['pop3_port']),
      smtp: port(plain, ['smtp_port']),
    },
    username: pick(src, ['inbox_username', 'user'], email),
  };
}

/* ------------------------------------------------------------ saf yardımcılar */

export function splitEmail(email) {
  const s = String(email ?? '');
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) {
    throw new UserError(t('mail.invalidEmail', { email: s }));
  }
  return [s.slice(0, at), s.slice(at + 1)];
}

/** Kota gösterimi: `unlimited`/0 → null, diğerleri MiB sayısı. */
export function quotaOf(value) {
  if (value === null || value === undefined) return null;
  if (UNLIMITED.has(value)) return null;
  const n = Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toBytes(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pick(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return fallback;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  if (typeof v === 'object') return Object.values(v);
  return [v];
}
