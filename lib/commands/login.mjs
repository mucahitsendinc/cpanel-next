import { resolveConfig, maskSecret } from '../config.mjs';
import { CpanelClient } from '../cpanel.mjs';
import { openSession, obtainPassword, provisionToken, persistProfile } from '../auth.mjs';
import { closeSession } from '../browser/session.mjs';
import { CONFIG_FILE } from '../paths.mjs';
import { t as tr } from '../i18n/index.mjs';
import { intro, outro, text, note, spinner, log, color, UserError } from '../ui.mjs';

export async function run({ flags, cwd }) {
  const cfg = resolveConfig(flags, cwd);
  intro(tr('login.title'));

  for (const warning of cfg.warnings) log.warn(warning);

  const host = await askHost(flags, cfg);
  const user = await askUser(flags, cfg);
  const port = Number(flags.port || cfg.port || 2083);

  const pass = await obtainPassword({
    flags,
    cfg,
    promptMessage: tr('auth.passwordFor', { user, host }),
  });

  const s = spinner();
  s.start(tr('login.opening'));

  let session;
  try {
    session = await openSession({
      host,
      port,
      user,
      pass,
      insecure: flags.insecure,
      verbose: flags.verbose,
      assumeYes: flags.yes,
    });
  } catch (err) {
    s.stop(tr('login.openFailed'), 1);
    throw err;
  }
  s.stop(tr('login.opened', { via: session.via === 'http' ? tr('login.viaHttp') : tr('login.viaBrowser') }));

  const sessionClient = new CpanelClient({
    host,
    port,
    user,
    session,
    insecure: flags.insecure,
    verbose: flags.verbose,
  });

  let token = null;
  let tokenName = null;
  let tokenless = false;

  const t = spinner();
  t.start(tr('login.creatingToken'));
  try {
    const result = await provisionToken({ sessionClient, verbose: flags.verbose });
    token = result.token;
    tokenName = result.name;
    t.stop(tr('login.tokenCreated', { name: tokenName }));
  } catch (err) {
    if (err?.code === 'FEATURE_DISABLED') {
      tokenless = true;
      t.stop(tr('login.tokenDisabled'), 1);
      log.info(err.hint);
    } else {
      t.stop(tr('login.tokenFailed'), 1);
      await closeSession(session);
      throw err;
    }
  }

  // Token'ı gerçekten çalışıyor mu diye sınıyoruz. Kaydedip sonra "geçersiz"
  // demek, kullanıcıyı bir sonraki komutta şaşırtmak olur.
  let account = null;
  if (token) {
    const v = spinner();
    v.start(tr('login.verifying'));
    try {
      const tokenClient = new CpanelClient({
        host,
        port,
        user,
        token,
        insecure: flags.insecure,
        verbose: flags.verbose,
      });
      account = await tokenClient.whoami();
      v.stop(tr('login.verified'));
    } catch (err) {
      v.stop(tr('login.verifyFailed'), 1);
      await closeSession(session);
      throw new UserError(tr('login.verifyFailedMessage', { error: err.message }), tr('login.verifyFailedHint'));
    }
  }

  await closeSession(session);
  await persistProfile({ host, port, user, token, tokenName });

  const lines = [
    `${color.dim(tr('login.labelServer'))}   ${host}:${port}`,
    `${color.dim(tr('login.labelAccount'))}    ${user}`,
    token
      ? `${color.dim(tr('login.labelToken'))}    ${maskSecret(token)}  ${color.dim(`(${tokenName})`)}`
      : `${color.dim(tr('login.labelToken'))}    ${color.yellow(tr('login.noTokenValue'))}`,
    `${color.dim(tr('login.labelStore'))}    ${CONFIG_FILE} ${color.dim('(0600)')}`,
  ];
  if (account?.maximum_passenger_apps !== undefined) {
    lines.push(`${color.dim(tr('login.labelQuota'))} ${account.maximum_passenger_apps}`);
  }
  note(lines.join('\n'), tr('login.savedTitle'));

  if (token) {
    log.warn(tr('login.tokenScopeWarning', { name: tokenName }));
  }
  log.info(tr('login.passwordNotStored'));

  outro(tr('login.done', { command: color.cyan('deploymanager') }));
}

async function askHost(flags, cfg) {
  if (flags.host) return normalizeHost(flags.host);
  const value = await text({
    message: tr('login.askHost'),
    placeholder: 'sunucu.example.com',
    initialValue: cfg.host || '',
    validate: (v) => (String(v || '').trim() ? undefined : tr('login.askHostRequired')),
  });
  return normalizeHost(value);
}

async function askUser(flags, cfg) {
  if (flags.user) return flags.user.trim();
  return (
    await text({
      message: tr('login.askUser'),
      initialValue: cfg.user || '',
      validate: (v) => (String(v || '').trim() ? undefined : tr('login.askUserRequired')),
    })
  ).trim();
}

/** `https://x.com:2083/` gibi yapıştırılan değerleri de kabul edelim. */
function normalizeHost(value) {
  return String(value)
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/[:/].*$/, '');
}
