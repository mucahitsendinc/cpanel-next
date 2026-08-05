import { resolveConfig } from './config.mjs';
import { CpanelClient } from './cpanel.mjs';
import { escalateToSession, ensureToken } from './auth.mjs';
import { probe } from './probe.mjs';
import { UserError, log } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * Okuma amaçlı komutların (status, apps, doctor, rollback) ortak kurulumu.
 * deploy kendi bağlamını kuruyor çünkü orada sıralama daha ayrıntılı.
 */
export async function buildContext({ flags, cwd, needProbe = true }) {
  const cfg = resolveConfig(flags, cwd);
  for (const warning of cfg.warnings) log.warn(warning);

  if (!cfg.host || !cfg.user) {
    throw new UserError(t('common.noProfile'), t('common.runLogin'));
  }

  const ctx = { flags, cwd, cfg, cleanup: [], capabilities: {} };

  // Token kasadaysa burada açılır — ana şifre bir kez sorulur.
  const token = await ensureToken(cfg, flags);
  cfg.token = token;

  ctx.client = new CpanelClient({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    token,
    insecure: flags.insecure,
    verbose: flags.verbose,
  });

  if (!token) {
    await escalateToSession(ctx, t('doctor.tokenMissing'));
    ctx.client = ctx.sessionClient;
  }

  if (needProbe) {
    ctx.probeResult = await probe(ctx.client, { refresh: flags.force, verbose: flags.verbose });
    /*
     * `--driver` tespit sonucunu ezer.
     *
     * Tespit yetenek sorarak çalışıyor ama iki rejimin birden açık olduğu
     * kutular var (bu test kutusunda PassengerApps de CloudLinux Selector de
     * cevap veriyor). Kullanıcının hangisini istediğini söyleyebilmesi gerek.
     */
    ctx.driver = await loadDriver(flags.driver || ctx.probeResult.regime);
  }

  return ctx;
}

export async function loadDriver(regime) {
  if (regime === 'cloudlinux') return import('./drivers/cloudlinux.mjs');
  if (regime === 'passenger') return import('./drivers/passenger.mjs');
  return null;
}

export function regimeLabel(regime) {
  return t(`regime.${regime === 'cloudlinux' || regime === 'passenger' ? regime : 'unknown'}`);
}

export async function runCleanup(ctx) {
  for (const fn of ctx.cleanup ?? []) await fn().catch(() => {});
}
