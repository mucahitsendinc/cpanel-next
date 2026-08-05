import { buildContext, runCleanup, regimeLabel } from '../context.mjs';
import { t } from '../i18n/index.mjs';
import { readOwnerMarker } from '../guards.mjs';
import { intro, outro, table, note, spinner, color, log } from '../ui.mjs';

export async function run({ flags, cwd }) {
  const ctx = await buildContext({ flags, cwd });
  try {
    intro(t('apps.title'));

    if (!ctx.driver) {
      log.warn(t('apps.noManager'));
      outro('');
      return;
    }

    const s = spinner();
    s.start(t('apps.reading'));
    const apps = await ctx.driver.listApps(ctx);
    s.stop(t('apps.count', { count: apps.length }));

    if (!apps.length) {
      note(t('apps.empty'), t('apps.emptyTitle', { user: ctx.cfg.user, host: ctx.cfg.host }));
      outro('');
      return;
    }

    // Sahiplik işaretini okumak, hangi uygulamaya bu aracın dokunabileceğini
    // gösterir — listedeki en önemli sütun bu.
    const rows = [];
    for (const app of apps) {
      const marker = await readOwnerMarker(ctx.client, app.path).catch(() => null);
      const owner =
        marker?.tool === 'cpanel-next' ? color.green(t('apps.ownerSelf')) : color.dim(t('apps.ownerExternal'));
      rows.push([
        app.name ?? '-',
        app.domain ?? '-',
        String(app.nodeVersion ?? '-'),
        statusLabel(app),
        `~/${app.path}`,
        owner,
      ]);
    }

    console.log('');
    console.log(
      table(t('apps.headers'), rows)
    );
    console.log('');
    log.info(
      `${ctx.cfg.user}@${ctx.cfg.host} · ${regimeLabel(ctx.probeResult.regime)}` +
        (ctx.probeResult.maxApps
          ? ` · ${t('apps.quota', { current: apps.length, max: ctx.probeResult.maxApps })}`
          : '')
    );
    log.info(
      color.dim(t('apps.ownerNote'))
    );

    outro('');
  } finally {
    await runCleanup(ctx);
  }
}

function statusLabel(app) {
  const raw = app.status ?? (app.enabled ? 'started' : 'stopped');
  if (/start|run|enabled/i.test(String(raw))) return color.green(t('apps.statusRunning'));
  if (/stop|disabled/i.test(String(raw))) return color.yellow(t('apps.statusStopped'));
  return String(raw);
}
