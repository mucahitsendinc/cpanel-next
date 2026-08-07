import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CONFIG_FILE, HOME_DIR, PROJECT_CONFIG_NAME, ensureHomeDir } from './paths.mjs';
import { t } from './i18n/index.mjs';
import { UserError } from './ui.mjs';
import { unlockVault, createVault, sealToken, openToken } from './vault.mjs';

const SECRET_KEY_RE = /token|secret|password|passwd|apikey|api_key/i;

/* ---------------------------------------------------------------- global */

/**
 * Global yapılandırmayı okur ve izinlerini denetler.
 *
 * Dosyada iptal edilebilir bir cPanel API token'ı duruyor — şifre değil, ama
 * yine de hesabın tamamına erişim. Gevşek izin bulursak sessizce düzeltip
 * kullanıcıyı uyarıyoruz; "uyarı bastık, kullanıcı halleder" yetmez.
 */
export function loadGlobalConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { version: 1, profiles: {}, defaultProfile: null };
  }

  const warnings = [];
  try {
    const stat = fs.statSync(CONFIG_FILE);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      fs.chmodSync(CONFIG_FILE, 0o600);
      warnings.push(
        t('config.loosePerms', { file: CONFIG_FILE, mode: (stat.mode & 0o777).toString(8) })
      );
    }
  } catch {
    /* stat başarısızsa okuma zaten patlayacak */
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    throw new Error(t('config.readFailed', { file: CONFIG_FILE, error: err.message }));
  }

  return {
    version: parsed.version ?? 1,
    profiles: parsed.profiles ?? {},
    defaultProfile: parsed.defaultProfile ?? null,
    vault: parsed.vault ?? null,
    preferences: parsed.preferences ?? {},
    warnings,
  };
}

export function saveGlobalConfig(config) {
  ensureHomeDir();
  const body = JSON.stringify(
    {
      version: 2,
      defaultProfile: config.defaultProfile ?? null,
      vault: config.vault ?? null,
      preferences: config.preferences ?? {},
      profiles: config.profiles ?? {},
    },
    null,
    2
  );
  fs.writeFileSync(CONFIG_FILE, `${body}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* Windows */
  }
  return CONFIG_FILE;
}

/**
 * Bir profili kaydeder. `password` alanı gelirse KASTEN düşürülür —
 * şifre bu araçta hiçbir zaman diske inmez.
 */
export function saveProfile(name, profile, { vaultMeta = null } = {}) {
  const config = loadGlobalConfig();
  // Şifre alanları KASTEN düşürülür — bu araçta şifre hiçbir zaman diske inmez.
  const { password, pass, ...safe } = profile;
  config.profiles[name] = { ...(config.profiles[name] || {}), ...safe };
  if (!config.defaultProfile) config.defaultProfile = name;
  if (vaultMeta) config.vault = vaultMeta;
  saveGlobalConfig(config);
  return config.profiles[name];
}

/**
 * ANA ŞİFREYİ DEĞİŞTİRİR.
 *
 * Bunu yapmanın hiçbir yolu yoktu: kasa kuruluyordu, unutulursa açılmıyordu,
 * ama değiştirilemiyordu. Şifresini bir yerde sızdırdığını düşünen birinin
 * tek çaresi bütün hesapları silip yeniden eklemekti.
 *
 * Şifre kasanın ANAHTARINI türetiyor; değiştirmek, saklanan her sırrı yeni
 * anahtarla yeniden mühürlemek demek — token'lar ve (varsa) cPanel şifreleri.
 *
 * ⚠ TEK YAZMA. Sırlar önce bellekte yeniden mühürleniyor, dosya en sonda bir
 * kez yazılıyor. Ortada bir hata olsaydı yarısı eski yarısı yeni anahtarla
 * şifrelenmiş bir kasa kalırdı ve o kasa bir daha hiç açılamazdı.
 *
 * @returns {Buffer} yeni kasa anahtarı — çağıran bellekteki kopyayı tazelesin
 */
export function changeMasterPassword(oldPassword, newPassword) {
  const config = loadGlobalConfig();
  const profiles = config.profiles ?? {};
  const names = Object.keys(profiles);

  const sealed = names.filter((n) => profiles[n].tokenEnc || profiles[n].passwordEnc);
  if (!config.vault) throw new UserError(t('vault.noVault'), t('vault.noVaultHint'));

  // Eski şifre YANLIŞSA burada durur: `unlockVault` bilinen bir düz metni
  // çözemediğinde fırlatıyor.
  const oldKey = unlockVault(config.vault, oldPassword);
  const { meta, key } = createVault(newPassword);

  const next = {};
  for (const name of names) {
    const p = { ...profiles[name] };
    if (p.tokenEnc) p.tokenEnc = sealToken(key, openToken(oldKey, p.tokenEnc));
    if (p.passwordEnc) p.passwordEnc = sealToken(key, openToken(oldKey, p.passwordEnc));
    next[name] = p;
  }

  saveGlobalConfig({ ...config, profiles: next, vault: meta });
  return { key, resealed: sealed.length };
}

export function getVaultMeta() {
  return loadGlobalConfig().vault ?? null;
}

/* --------------------------------------------------------------- tercihler */

/**
 * Kullanıcı tercihleri.
 *
 * `ui`: varsayılan arayüz — 'web' | 'terminal'. Tanımsızsa ilk çalıştırmada
 * bir kez sorulur ve kaydedilir; sonrasında `--web` / `--terminal` ile o
 * çalıştırmaya özel geçilebilir.
 */
export function getPreferences() {
  return loadGlobalConfig().preferences ?? {};
}

export function savePreference(key, value) {
  const config = loadGlobalConfig();
  config.preferences = { ...(config.preferences ?? {}), [key]: value };
  saveGlobalConfig(config);
  return config.preferences;
}

export function removeProfile(name) {
  const config = loadGlobalConfig();
  if (!config.profiles[name]) return false;
  delete config.profiles[name];
  if (config.defaultProfile === name) {
    config.defaultProfile = Object.keys(config.profiles)[0] ?? null;
  }
  saveGlobalConfig(config);
  return true;
}

/* --------------------------------------------------------------- project */

/**
 * Proje kökündeki `.cpanel-next.json`'ı arar (cwd'den yukarı doğru, git köküne kadar).
 *
 * Bu dosya commit edilmek üzere tasarlandı. İçinde sır bulursak ÇALIŞMAYI
 * REDDEDİYORUZ: git'e girmiş bir cPanel token'ı, hesabın tamamının ele
 * geçirilmesi demek. Uyarı basıp devam etmek, sızıntıyı normalleştirmek olur.
 */
export function loadProjectConfig(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (true) {
    const candidate = path.join(dir, PROJECT_CONFIG_NAME);
    if (fs.existsSync(candidate)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      } catch (err) {
        throw new Error(t('config.projectReadFailed', { file: candidate, error: err.message }));
      }
      assertNoSecrets(parsed, candidate);
      return { ...parsed, __file: candidate, __dir: dir };
    }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return null;
}

function assertNoSecrets(obj, file, trail = []) {
  for (const [key, value] of Object.entries(obj || {})) {
    const here = [...trail, key];
    if (SECRET_KEY_RE.test(key)) {
      throw new Error(t('config.secretInProject', { file, path: here.join('.') }));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assertNoSecrets(value, file, here);
    }
  }
}

export function saveProjectConfig(dir, data) {
  const file = path.join(dir, PROJECT_CONFIG_NAME);

  /*
   * ⚠ İÇ ALANLAR (`__file`, `__dir`) DOSYAYA YAZILMIYOR.
   *
   * `loadProjectConfig` okuduğu nesneye bu ikisini ekliyor. "Oku, bir alan
   * değiştir, geri yaz" — en doğal kullanım — onları da dosyaya taşıyordu ve
   * içlerinde MAKİNEYE ÖZGÜ MUTLAK YOLLAR var (`/Users/<ad>/...`).
   *
   * Bu dosya commit edilmek üzere tasarlandı: bir geliştiricinin ev dizini
   * depoya girer, ekipteki diğer makinelerde anlamsız olur ve gereksiz bir
   * bilgi sızıntısı olurdu.
   */
  const clean = Object.fromEntries(Object.entries(data ?? {}).filter(([k]) => !k.startsWith('__')));

  assertNoSecrets(clean, file);
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, ...clean }, null, 2)}\n`);
  return file;
}

/* -------------------------------------------------------------- resolved */

/**
 * Çözümleme sırası (önce gelen kazanır):
 *   1. CLI bayrakları
 *   2. CPANEL_NEXT_* ortam değişkenleri
 *   3. Proje dosyası (.cpanel-next.json) — sırsız alanlar
 *   4. Global profil (~/.cpanel-next/config.json)
 *
 * Her değerin nereden geldiği `sources` içinde tutulur; `--verbose` ve
 * `--dry-run` bunu basar, böylece "hangi token'la bağlanıyorum" sorusu
 * tahmin işi olmaktan çıkar.
 */
export function resolveConfig(flags = {}, cwd = process.cwd()) {
  const project = loadProjectConfig(cwd);
  const global = loadGlobalConfig();

  const sources = {};
  const pick = (name, flagValue, envName, projectKey) => {
    if (flagValue !== undefined && flagValue !== null && flagValue !== '') {
      sources[name] = 'flag';
      return flagValue;
    }
    const env = process.env[envName];
    if (env) {
      sources[name] = `env:${envName}`;
      return env;
    }
    if (project && project[projectKey] !== undefined && project[projectKey] !== '') {
      sources[name] = `project:${PROJECT_CONFIG_NAME}`;
      return project[projectKey];
    }
    return undefined;
  };

  let host = pick('host', flags.host, 'CPANEL_NEXT_HOST', 'host');

  const profileName = flags.profile || process.env.CPANEL_NEXT_PROFILE || host || global.defaultProfile;
  const profile = profileName ? global.profiles?.[profileName] : undefined;

  if (!host && profile?.host) {
    host = profile.host;
    sources.host = `profile:${profileName}`;
  }

  let user = pick('user', flags.user, 'CPANEL_NEXT_USER', 'user');
  if (!user && profile?.user) {
    user = profile.user;
    sources.user = `profile:${profileName}`;
  }

  // Token üç yerden gelebilir. Kasadaki şifreli hâl burada ÇÖZÜLMEZ — çözmek
  // ana şifre sormayı gerektiriyor ve bu fonksiyon eşzamanlı. `auth.ensureToken`
  // gerektiğinde açar.
  let token = flags.token || process.env.CPANEL_NEXT_TOKEN;
  let tokenEnc = null;
  if (token) {
    sources.token = flags.token ? 'flag' : 'env:CPANEL_NEXT_TOKEN';
  } else if (profile?.tokenEnc) {
    tokenEnc = profile.tokenEnc;
    sources.token = `profile:${profileName} (${t('vault.inVault')})`;
  } else if (profile?.token) {
    // v1 profilleri: şifresiz saklanmış token. Okumaya devam ediyoruz ki
    // yükseltme sırasında kimse dışarıda kalmasın; `login` bunu kasaya taşır.
    token = profile.token;
    sources.token = `profile:${profileName} (${t('vault.plaintext')})`;
  }

  const port = Number(
    pick('port', flags.port, 'CPANEL_NEXT_PORT', 'port') ?? profile?.port ?? 2083
  );

  return {
    host,
    user,
    token,
    tokenEnc,
    vault: global.vault ?? null,
    port,
    profileName,
    project,
    projectDir: project?.__dir ?? cwd,
    sources,
    warnings: global.warnings ?? [],
    /** Şifre asla saklanmaz; yalnızca bu çalıştırma için ortamdan gelebilir. */
    passwordFromEnv: process.env.CPANEL_NEXT_PASSWORD || null,
  };
}

/** Token'ı loglarken kullanılacak maske. Tam token asla ekrana basılmaz. */
export function maskSecret(value) {
  const s = String(value ?? '');
  if (!s) return t('common.none');
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-3)} (${s.length} hane)`;
}

/** Token adında makineyi işaretle ki cPanel arayüzünde hangisi olduğu belli olsun. */
export function defaultTokenName() {
  const hostname = os.hostname().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'machine';
  return `cpanel-next-${hostname}`;
}

export { HOME_DIR, CONFIG_FILE };
