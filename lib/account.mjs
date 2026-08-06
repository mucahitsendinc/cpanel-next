import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * Hesabın kendi cPanel şifresi.
 *
 * `Users::change_password` ESKİ ŞİFREYİ İSTİYOR (`oldpass` zorunlu). Bu iyi:
 * kasası açık bir arayüzün, kullanıcının cPanel şifresini onun onayı olmadan
 * değiştirebilmesi doğru olmazdı.
 */

/**
 * @param {object} client
 * @param {{oldPassword:string, newPassword:string, enableDigest?:boolean}} opts
 */
export async function changePassword(client, { oldPassword, newPassword, enableDigest = false }) {
  if (!oldPassword || !newPassword) throw new UserError(t('account.bothPasswords'));
  if (oldPassword === newPassword) throw new UserError(t('account.samePassword'));

  await client.uapiPost('Users', 'change_password', {
    oldpass: oldPassword,
    newpass: newPassword,
    // Digest kimlik doğrulama yalnızca Windows Web Disk için gerekiyor ve
    // açılması şifreyi ayrıca bir hash olarak saklıyor. Varsayılan kapalı.
    enabledigest: enableDigest ? 1 : 0,
    /*
     * ⚠ `enablemysql` GÖNDERİLMİYOR.
     *
     * Bu bayrak MySQL kullanıcılarının şifresini de cPanel şifresiyle
     * eşitliyor — yani `.env` dosyalarındaki `DB_PASSWORD` bir anda geçersiz
     * hâle geliyor ve yayındaki her uygulama veritabanına bağlanamıyor.
     * Sessizce yapılacak bir şey değil.
     */
  });

  return { changed: true };
}

/**
 * Sunucunun istediği şifre gücü.
 *
 * Kendi kuralımızı DAYATMIYORUZ (bu araçta ana şifre için "123" bile
 * serbest), ama cPanel'inki sunucu tarafında zorunlu ve karşılanmazsa
 * anlaşılmaz bir hata dönüyor. Önceden sorup kullanıcıya söylüyoruz.
 */
export async function requiredStrength(client, app = 'passwd') {
  try {
    const data = await client.uapi('PasswdStrength', 'get_required_strength', { app });
    const value = Number(data?.strength ?? data);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
