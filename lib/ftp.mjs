import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';
import { generatePassword } from './mysql.mjs';
import { rel } from './remote.mjs';

/**
 * FTP hesapları — saf UAPI.
 *
 * ⚠ cPanel FTP'yi v86'dan beri VARSAYILAN KAPALI gönderiyor ("clear-text
 * usernames and passwords" gerekçesiyle). Bu yüzden liste boş dönebilir ya da
 * özellik hiç bulunmayabilir; arayüz bunu bir hata değil, bir durum olarak
 * göstermeli.
 */

/**
 * ⚠ `disallowdot` VARSAYILAN 1.
 *
 * Yani cPanel, adında nokta olan bir FTP kullanıcısını sessizce noktasız hâle
 * getiriyor: `deploy.bot` → `deploybot`. Kullanıcı sonra `deploy.bot` ile
 * bağlanmaya çalışıp neden olmadığını anlamıyor. Açıkça 0 gönderip noktayı
 * koruyoruz.
 */
const KEEP_DOTS = '0';

export async function listAccounts(client) {
  const rows = asArray(await client.uapi('Ftp', 'list_ftp_with_disk', {}));
  return rows
    .map((r) => ({
      user: String(pick(r, ['user', 'login'], '')),
      dir: String(pick(r, ['dir', 'homedir'], '')),
      type: String(pick(r, ['type'], 'main')),
      used: Number(pick(r, ['diskused', '_diskused'], 0)) || 0,
      quota: quotaOf(pick(r, ['diskquota', '_diskquota'], null)),
    }))
    .filter((a) => a.user);
}

/** FTP sunucusunun adresi ve portu — elle tahmin etmiyoruz. */
export async function serverInfo(client, { host = null } = {}) {
  let raw = null;
  try {
    raw = await client.uapi('Ftp', 'get_ftp_daemon_info', {});
  } catch {
    raw = null;
  }
  return {
    // `host` istemcinin bağlandığı cPanel adresi; FTP genelde aynı makinede.
    host: String(pick(raw, ['host', 'server'], host ?? '') || host || ''),
    port: Number(pick(raw, ['port'], 21)) || 21,
    daemon: pick(raw, ['type', 'daemon'], null),
    enabled: Boolean(raw),
  };
}

/**
 * Yeni FTP hesabı.
 *
 * `homedir` ev dizinine GÖRELİ veriliyor. Mutlak yol vermek bazı cPanel
 * sürümlerinde `/home/user/home/user/...` üretiyor.
 */
export async function createAccount(client, { user, password = null, dir, quota = 0 }) {
  const name = String(user ?? '').trim();
  if (!name) throw new UserError(t('ftp.userRequired'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new UserError(t('ftp.invalidUser', { name }), t('ftp.invalidUserHint'));
  }

  const pass = password || generatePassword();
  await client.uapiPost('Ftp', 'add_ftp', {
    user: name,
    pass,
    homedir: rel(dir ?? ''),
    quota: String(quota ?? 0),
    disallowdot: KEEP_DOTS,
  });

  return { user: name, password: password ? null : pass, dir: rel(dir ?? '') };
}

export async function setPassword(client, user, password = null) {
  const pass = password || generatePassword();
  await client.uapiPost('Ftp', 'passwd', { user, pass });
  return { user, password: pass };
}

/**
 * FTP hesabını siler.
 *
 * ⚠ `destroy` VERİLMİYOR. cPanel bu parametreyle hesabın ev dizinini de
 * siliyor ve varsayılan ev dizini uygulamanın kendisi olabiliyor — yani bir
 * FTP hesabını kaldırmak siteyi götürebilir. Dosyaları silmek ayrı ve açık bir
 * işlem olmalı.
 */
export async function deleteAccount(client, user) {
  await client.uapiPost('Ftp', 'delete_ftp', { user });
}

/* ------------------------------------------------------------ saf yardımcılar */

/** cPanel'in FTP kullanıcı adı: `kullanıcı@domain`. Bağlanırken bu gerekiyor. */
export function loginName(user, host) {
  const name = String(user ?? '');
  return name.includes('@') ? name : `${name}@${host}`;
}

export function quotaOf(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).toLowerCase();
  if (s === 'unlimited' || s === '0' || s === '') return null;
  const n = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
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
