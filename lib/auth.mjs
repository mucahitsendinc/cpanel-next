import { login, closeSession } from './browser/session.mjs';
import { CpanelClient } from './cpanel.mjs';
import { UserError, password as promptPassword, text, log } from './ui.mjs';
import { t } from './i18n/index.mjs';
import { defaultTokenName, saveProfile } from './config.mjs';

/** Şifreyi stdin'den okur (`--password-stdin`) — CI için, ekrana hiç düşmez. */
export async function readPasswordFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/**
 * Şifreyi elde eder. Sıra: --password-stdin → CPANEL_NEXT_PASSWORD → sor.
 *
 * Şifre HİÇBİR ZAMAN diske yazılmaz. Bu fonksiyonun döndürdüğü değer yalnızca
 * bu çalıştırma boyunca bellekte yaşar.
 */
export async function obtainPassword({ flags = {}, cfg = {}, promptMessage } = {}) {
  if (flags['password-stdin']) return readPasswordFromStdin();
  if (cfg.passwordFromEnv) return cfg.passwordFromEnv;
  return promptPassword({
    message: promptMessage || t('auth.passwordPrompt'),
    validate: (v) => (v ? undefined : t('auth.passwordRequired')),
  });
}

/**
 * Ana şifreyi elde eder.
 *
 * Otomasyon için `CPANEL_NEXT_MASTER_PASSWORD` okunur; aksi hâlde sorulur.
 * KARMAŞIKLIK ŞARTI YOK — kullanıcı "123" diyebilir. Zorunlu kurallar
 * pratikte şifreyi bir kâğıda yazdırmaktan başka işe yaramıyor; tehdit
 * modeli kullanıcının kendi kararı.
 */
export async function obtainMasterPassword({ create = false } = {}) {
  if (process.env.CPANEL_NEXT_MASTER_PASSWORD) return process.env.CPANEL_NEXT_MASTER_PASSWORD;

  if (!create) {
    return promptPassword({
      message: t('auth.masterPrompt'),
      validate: (v) => (v ? undefined : t('auth.masterRequired')),
    });
  }

  log.info(t('auth.masterCreateInfo'));

  const first = await promptPassword({
    message: t('auth.masterNew'),
    validate: (v) => (v ? undefined : t('auth.masterNewRequired')),
  });
  const again = await promptPassword({
    message: t('auth.masterRepeat'),
    validate: (v) => (v === first ? undefined : t('auth.masterMismatch')),
  });
  return again;
}

/**
 * Kullanılabilir bir token döndürür; kasadaysa ana şifreyle açar.
 *
 * Her çalıştırmada sorulması bilinçli: kullanıcı "unutursa kullanamasın"
 * dedi, yani koruma kalıcı olmalı. Türetilmiş anahtarı diske önbelleklemek
 * korumayı ortadan kaldırırdı.
 */
export async function ensureToken(cfg, flags = {}) {
  if (cfg.token) return cfg.token;
  if (!cfg.tokenEnc) return null;

  if (!cfg.vault) {
    throw new UserError(t('auth.tokenEncryptedNoVault'), t('auth.tokenEncryptedNoVaultHint'));
  }

  const { unlockVault, openToken } = await import('./vault.mjs');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const master = await obtainMasterPassword();
    try {
      const key = unlockVault(cfg.vault, master);
      return openToken(key, cfg.tokenEnc);
    } catch (err) {
      if (err?.code !== 'BAD_MASTER_PASSWORD') throw err;
      // Ortamdan gelen şifre yanlışsa tekrar denemek sonsuz döngü olur.
      if (process.env.CPANEL_NEXT_MASTER_PASSWORD) throw err;
      if (attempt === 2) throw err;
      log.warn(t('auth.masterWrongRetry'));
    }
  }
  return null;
}

/**
 * Oturum açar; iki adımlı doğrulama isterse kodu sorup tekrar dener.
 *
 * Yanlış şifreyi tarayıcıyla tekrar denemiyoruz (`BAD_CREDENTIALS`) — hem
 * anlamsız hem de hostun brute-force korumasına takılıp hesabı kilitletir.
 */
export async function openSession({ host, port, user, pass, insecure, verbose, assumeYes }) {
  let totp = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await login({
        host,
        port,
        user,
        password: pass,
        totp,
        insecure,
        verbose,
        allowBrowser: true,
        onBrowserNeeded: async () => {
          const { ensureChromium } = await import('./browser/ensure.mjs');
          await ensureChromium({ assumeYes, reason: t('browser.sessionReason') });
        },
      });
    } catch (err) {
      if (err?.code === 'TFA_REQUIRED' && !totp) {
        totp = await text({
          message: t('auth.tfaPrompt'),
          validate: (v) => (/^\d{6}$/.test(String(v).trim()) ? undefined : t('auth.tfaInvalid')),
        });
        continue;
      }
      throw err;
    }
  }
  throw new UserError(t('auth.sessionFailed'));
}

/**
 * Aracın kendi API token'ını üretir.
 *
 * Kullanıcının cPanel arayüzünde "Manage API Tokens" sayfasını bulup elle
 * token oluşturmasına gerek kalmıyor. Token iptal edilebilir bir sırdır ve
 * şifrenin aksine diske yazılabilir.
 *
 * ⚠ cPanel token'ları KAPSAMLANDIRILAMAZ — fonksiyonun adı birebir
 * `create_full_access`. Bunu kullanıcıdan saklamıyoruz, `login` çıktısında
 * açıkça yazıyoruz.
 */
export async function provisionToken({ sessionClient, verbose = false }) {
  const base = defaultTokenName();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-${Date.now().toString(36).slice(-4)}`;
    try {
      const data = await sessionClient.uapiPost('Tokens', 'create_full_access', { name });
      const token = data?.token ?? data?.api_token ?? data;
      if (typeof token !== 'string' || token.length < 16) {
        throw new UserError(t('auth.tokenMissingInResponse'));
      }
      if (verbose) console.error(`  › token created: ${name}`);
      return { token, name };
    } catch (err) {
      if (err?.code === 'FEATURE_DISABLED') {
        const e = new UserError(t('auth.tokenFeatureDisabled'), t('auth.tokenFeatureDisabledHint'));
        e.code = 'FEATURE_DISABLED';
        throw e;
      }
      // Aynı isimde token varsa cPanel reddediyor; sonraki turda son ek ekliyoruz.
      if (/already|exists|in use/i.test(err.message) && attempt < 2) continue;
      throw err;
    }
  }
  throw new UserError(t('auth.tokenFailed'));
}

/**
 * Token yolu (T1) mümkün değilse oturum kipine (T2) yükseltir.
 *
 * Çağıran kod aynı `CpanelClient` arayüzünü kullanmaya devam eder; yalnızca
 * kimlik kipi değişir.
 */
export async function escalateToSession(ctx, reason = '') {
  if (ctx.sessionClient) return ctx.sessionClient;

  log.info(t('auth.escalating', { reason: reason ? ` (${reason})` : '' }));
  const pass = await obtainPassword({
    flags: ctx.flags,
    cfg: ctx.cfg,
    promptMessage: t('auth.passwordFor', { user: ctx.cfg.user, host: ctx.cfg.host }),
  });

  const session = await openSession({
    host: ctx.cfg.host,
    port: ctx.cfg.port,
    user: ctx.cfg.user,
    pass,
    insecure: ctx.flags.insecure,
    verbose: ctx.flags.verbose,
    assumeYes: ctx.flags.yes,
  });

  ctx.session = session;
  ctx.sessionClient = ctx.client.withSession(session);
  ctx.cleanup.push(() => closeSession(session));
  return ctx.sessionClient;
}

/**
 * Profili kaydeder; token'ı ana şifreyle şifreleyerek.
 *
 * Kasa yoksa kurulur (kullanıcı yeni bir ana şifre belirler). Varsa mevcut
 * ana şifre sorulur — böylece tek bir ana şifre bütün profilleri açıyor,
 * kullanıcı sunucu başına ayrı şifre ezberlemek zorunda kalmıyor.
 */
export async function persistProfile({ host, port, user, token, tokenName }) {
  const profile = { host, port, user, createdAt: new Date().toISOString() };

  if (!token) return saveProfile(host, profile);

  const { getVaultMeta } = await import('./config.mjs');
  const { createVault, unlockVault, sealToken } = await import('./vault.mjs');

  const existing = getVaultMeta();
  let key;
  let vaultMeta = null;

  if (existing) {
    for (let attempt = 0; ; attempt += 1) {
      const master = await obtainMasterPassword();
      try {
        key = unlockVault(existing, master);
        break;
      } catch (err) {
        if (err?.code !== 'BAD_MASTER_PASSWORD') throw err;
        if (attempt >= 2 || process.env.CPANEL_NEXT_MASTER_PASSWORD) throw err;
        log.warn(t('auth.masterWrongRetry'));
      }
    }
  } else {
    const master = await obtainMasterPassword({ create: true });
    const vault = createVault(master);
    key = vault.key;
    vaultMeta = vault.meta;
  }

  profile.tokenEnc = sealToken(key, token);
  profile.tokenName = tokenName;
  // Eski biçimden gelenlerde şifresiz token kalmasın.
  profile.token = undefined;

  return saveProfile(host, profile, { vaultMeta });
}

export { CpanelClient };
