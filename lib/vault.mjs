import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * Yerel kasa.
 *
 * cPanel API token'ı bu makinede duruyor ve hesabın erişebildiği her şeye
 * erişiyor (cPanel token'ları kapsamlandırılamıyor). Dosya izni 0600 tek
 * başına yeterli değil: yedekler, senkronizasyon klasörleri ve makineye
 * erişen başka bir süreç düz metni okuyabilir.
 *
 * Bu yüzden token, kullanıcının belirlediği bir ana şifreden türetilen
 * anahtarla şifrelenir. Ana şifre HİÇBİR YERDE saklanmaz — unutulursa kasa
 * açılamaz. Bu kasıtlı: saklanan bir şifre koruma sağlamaz.
 *
 * Şifre karmaşıklığı DAYATILMIYOR. Kullanıcı "123" da diyebilir; bu onun
 * kararı ve tehdit modeli. Zorunlu karmaşıklık kuralları pratikte şifreyi bir
 * yapışkan nota yazdırmaktan başka işe yaramıyor.
 */

const KDF = {
  name: 'scrypt',
  N: 16384, // ~50 ms — etkileşimli kullanımda hissedilmez, kaba kuvvete pahalı
  r: 8,
  p: 1,
  keyLen: 32,
};

const CHECK_PLAINTEXT = 'cpanel-next-vault-v1';

function deriveKey(password, saltHex) {
  return scryptSync(String(password), Buffer.from(saltHex, 'hex'), KDF.keyLen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex'),
  };
}

function decrypt(key, box) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(box.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'hex')), decipher.final()]).toString(
    'utf8'
  );
}

/** Yeni kasa oluşturur. Dönen `meta` config'e yazılır. */
export function createVault(masterPassword) {
  const salt = randomBytes(16).toString('hex');
  const key = deriveKey(masterPassword, salt);
  return {
    meta: { kdf: KDF.name, salt, N: KDF.N, r: KDF.r, p: KDF.p, check: encrypt(key, CHECK_PLAINTEXT) },
    key,
  };
}

/**
 * Ana şifreyi doğrular ve anahtarı döndürür.
 *
 * Doğrulama, bilinen bir düz metni çözerek yapılıyor: yanlış şifrede
 * GCM etiketi zaten tutmaz, ama açık bir kontrol daha anlaşılır bir hata
 * mesajı vermeyi sağlıyor.
 */
export function unlockVault(meta, masterPassword) {
  if (!meta?.salt || !meta?.check) {
    throw new UserError(t('vault.corrupt'), t('vault.corruptHint'));
  }

  const key = deriveKey(masterPassword, meta.salt);
  let plain;
  try {
    plain = decrypt(key, meta.check);
  } catch {
    throw wrongPassword();
  }

  const a = Buffer.from(plain);
  const b = Buffer.from(CHECK_PLAINTEXT);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw wrongPassword();

  return key;
}

function wrongPassword() {
  const err = new UserError(t('vault.wrongPassword'), t('vault.wrongPasswordHint'));
  err.code = 'BAD_MASTER_PASSWORD';
  return err;
}

export function sealToken(key, token) {
  return encrypt(key, token);
}

export function openToken(key, box) {
  try {
    return decrypt(key, box);
  } catch {
    throw wrongPassword();
  }
}

export { KDF };
