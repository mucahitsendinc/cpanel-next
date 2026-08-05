import os from 'node:os';
import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';
import { readJson, saveFile, rel } from './remote.mjs';
import { REMOTE } from './paths.mjs';

/**
 * Bu araç, dost bir yüzü olan `rm -rf`.
 *
 * Hedef klasörün içeriği silinip yerine paket açılıyor. Yanlış klasör
 * seçilirse yayında olan bir site gider. Aşağıdaki katmanlar bunu yapısal
 * olarak zorlaştırmak için.
 */

/**
 * Geçerli app-root adı.
 *
 * Sessizce TEMİZLEMİYORUZ, REDDEDİYORUZ. `../../etc` gibi bir girdiden
 * karakterleri ayıklamak onu `....etc` yapar — yani başka bir hataya çevirir,
 * düzeltmez. Geçersiz girdi hata vermelidir.
 */
export const APP_ROOT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

/** Hesabın altyapısına ait, asla uygulama klasörü olamayacak adlar. */
export const PROTECTED_NAMES = new Set([
  'public_html',
  'www',
  'mail',
  'etc',
  'logs',
  'ssl',
  'tmp',
  'cgi-bin',
  'access-logs',
  'nodevenv',
  'virtualenv',
  'perl5',
  'backups',
  '.cl.selector',
  '.cpanel',
  '.ssh',
  '.trash',
  '.htpasswds',
]);

/**
 * app-root adını denetler.
 *
 * `docroots`: hesaptaki tüm domainlerin belge kökleri. Bunlardan birine eşit
 * bir app-root, Next kaynağını doğrudan yayına açılan bir dizine koymak
 * demektir — kaynak kodu ve `.env` internete açılır.
 */
export function assertAppRoot(appRoot, { docroots = [], force = false } = {}) {
  const name = String(appRoot || '').trim();

  if (!name) throw new UserError(t('guards.emptyAppRoot'));

  /*
   * Denetim SIRASI bilinçli: her ret kendi gerçek sebebini vermeli.
   *
   * `APP_ROOT_RE` tek başına üçünü de elerdi (ilk karakter harf/rakam olmak
   * zorunda), ama o zaman `../../etc` için "geçersiz ad", `.ssh` için de aynı
   * genel mesaj çıkardı. Kullanıcı neyi yanlış yaptığını anlamalı.
   */

  // 1) Yol kaçışı — eğik çizgi ve ".." asla geçmez.
  if (/[/\\]/.test(name) || name.split(/[/\\]/).includes('..') || name === '..') {
    throw new UserError(t('guards.invalidAppRoot', { name }), t('guards.invalidAppRootHint'));
  }

  // 2) Gizli dizinler hesabın kendi yapılandırmasına ait.
  if (name.startsWith('.')) {
    throw new UserError(t('guards.dotStart', { name }), t('guards.dotStartHint'));
  }

  // 3) Geriye kalan biçim kuralları.
  if (!APP_ROOT_RE.test(name)) {
    throw new UserError(t('guards.invalidAppRoot', { name }), t('guards.invalidAppRootHint'));
  }

  if (PROTECTED_NAMES.has(name.toLowerCase())) {
    if (!force) {
      throw new UserError(t('guards.protected', { name }), t('guards.protectedHint'));
    }
    throw new UserError(t('guards.protectedForce', { name }), t('guards.protectedForceHint'));
  }

  const clash = docroots.find((d) => rel(d) === rel(name));
  if (clash && !force) {
    throw new UserError(
      t('guards.docrootClash', { name, docroot: clash }),
      t('guards.docrootClashHint', { suggestion: `${name}app` })
    );
  }

  return name;
}

/* ------------------------------------------------------------- sahiplik */

/**
 * Sahiplik işareti — asıl savunma.
 *
 * Bu aracın oluşturduğu her uygulama klasörüne bir işaret dosyası konur.
 * GÜNCELLEME dalı bu işareti ZORUNLU kılar. Böylece kullanıcının elle kurduğu
 * ya da başka bir aracın yönettiği bir klasörü (ör. bir müşteri paneli) bu
 * araç asla silemez: orada işaret yoktur.
 */
export function buildOwnerMarker({ appRoot, domain, projectDir, version }) {
  return {
    tool: 'cpanel-next',
    v: 1,
    version,
    appRoot,
    domain,
    project: projectDir,
    machine: `${os.userInfo().username}@${os.hostname()}`,
    createdAt: new Date().toISOString(),
  };
}

export async function readOwnerMarker(client, appRoot) {
  return readJson(client, rel(appRoot), REMOTE.ownerFile);
}

export async function writeOwnerMarker(client, appRoot, marker) {
  return saveFile(client, rel(appRoot), REMOTE.ownerFile, `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * Var olan bir klasöre yazmadan önce sahipliği doğrular.
 *
 * `--adopt` bunu geçebilir, ama çağıran taraf ayrıca kullanıcıya app-root adını
 * ELLE YAZDIRIR. İki adım birden bilerek yapılmadıkça bir müşteri klasörü
 * silinemez.
 */
export async function assertOwnership(client, appRoot, { adopt = false, dirExists = true } = {}) {
  if (!dirExists) return { owned: true, marker: null, reason: t('guards.newFolder') };

  const marker = await readOwnerMarker(client, appRoot);
  if (marker?.tool === 'cpanel-next') {
    return { owned: true, marker };
  }

  if (adopt) {
    return { owned: true, marker: null, adopted: true };
  }

  throw new UserError(t('guards.notOwned', { appRoot }), t('guards.notOwnedHint'));
}

/**
 * Yıkıcı işlem mi? Yeni klasöre kurulum yıkıcı değildir; var olanın üzerine
 * yazmak, sahiplenmek ve --force yıkıcıdır.
 */
export function isDestructive({ dirExists, adopt, force }) {
  return Boolean(dirExists || adopt || force);
}
