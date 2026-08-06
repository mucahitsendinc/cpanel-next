/**
 * cPanel'in kendi ekranlarına derin bağlantılar — tamamen saf.
 *
 * NEDEN BÖYLE: API token'ından tarayıcıya taşınabilir bir cPanel OTURUMU
 * üretilemiyor. `Tokens::create_full_access` bir token verir, ama cPanel'in
 * web arayüzü token ile değil `cpsess` çerezi ile çalışır ve o çerezi
 * kullanıcının tarayıcısına yazmanın bir yolu yok (bizim sunucumuz
 * 127.0.0.1'de, cPanel başka bir köken). WHM'de `create_user_session` var —
 * ama WHM root ister ve bu araç kapsamı dışında.
 *
 * Bu yüzden bağlantılar cPanel'in KENDİ giriş sayfasına gidiyor ve hedefi
 * `goto_uri` ile taşıyor. Kullanıcı zaten girişliyse doğrudan hedefe düşer;
 * değilse şifresini cPanel'e girer — bize değil. Kestirme değil, doğrusu bu.
 */

/** cPanel oturum kökü. Tema bilinmiyorsa jupiter varsayılıyor (v108+ tek tema). */
export const DEFAULT_THEME = 'jupiter';

/**
 * @param {{host:string, port?:number, user?:string|null}} account
 * @param {string|null} target  cPanel içindeki hedef yol (örn. /frontend/…)
 */
export function deepLink({ host, port = 2083, user = null }, target = null) {
  const params = new URLSearchParams();
  // Kullanıcı adı doldurulmuş gelsin: bu ekranı gören kişi zaten o hesabın
  // sahibi ve kullanıcı adı bir sır değil (araç zaten ekranda gösteriyor).
  if (user) params.set('user', user);
  if (target) params.set('goto_uri', target);
  const query = params.toString();
  return `https://${host}:${port}/login/${query ? `?${query}` : ''}`;
}

export function cpanelHome(account) {
  return deepLink(account, null);
}

export function phpMyAdmin(account, { database = null } = {}) {
  return deepLink(
    account,
    database
      ? `/3rdparty/phpMyAdmin/index.php?db=${encodeURIComponent(database)}`
      : '/3rdparty/phpMyAdmin/index.php'
  );
}

/**
 * Dosya Yöneticisi.
 *
 * `dir` MUTLAK yol bekliyor (`/home/kullanici/uygulama`), ev dizinine göreli
 * değil. Göreli verildiğinde cPanel sessizce ev dizinini açıyor — yani hata
 * görünmüyor, yalnızca yanlış klasör açılıyor.
 */
export function fileManager(account, { dir = null, theme = DEFAULT_THEME } = {}) {
  const base = `/frontend/${theme || DEFAULT_THEME}/filemanager/index.html`;
  const abs = dir ? absolutePath(account.user, dir) : null;
  return deepLink(account, abs ? `${base}?dir=${encodeURIComponent(abs)}` : base);
}

/** Kullanıcının token'ları — "bu aracın token'ını sil" derken gösterdiğimiz yer. */
export function apiTokens(account, { theme = DEFAULT_THEME } = {}) {
  return deepLink(account, `/frontend/${theme || DEFAULT_THEME}/security/api_tokens/index.html`);
}

/** MultiPHP: bir domainin PHP sürümü. Laravel tarafında işimize yarayacak. */
export function multiPhp(account, { theme = DEFAULT_THEME } = {}) {
  return deepLink(account, `/frontend/${theme || DEFAULT_THEME}/multiphp_manager/index.html`);
}

export function absolutePath(user, dir) {
  const clean = String(dir ?? '').replace(/\/+$/, '');
  if (clean.startsWith('/')) return clean;
  return `/home/${user}/${clean.replace(/^\/+/, '')}`;
}
