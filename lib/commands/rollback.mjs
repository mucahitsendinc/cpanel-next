import { buildContext, runCleanup } from '../context.mjs';
import { t } from '../i18n/index.mjs';
import * as remote from '../remote.mjs';
import { REMOTE } from '../paths.mjs';
import { readOwnerMarker } from '../guards.mjs';
import { intro, outro, select, spinner, note, log, color, typeToConfirm, bytes, UserError } from '../ui.mjs';

/**
 * Önceki sürüme döner.
 *
 * Yedekler `node_modules` İÇERMEZ (kota dolmasın diye). Bu yüzden geri alma
 * ~5 sn değil ~1-2 dk sürüyor: bağımlılıklar yeniden kuruluyor. Takas bilinçli
 * ve burada açıkça söyleniyor — 400 MB'lık yedekler kotalı hesaplarda deploy'u
 * değil müşteriyi patlatır.
 */
export async function run({ flags, cwd }) {
  const ctx = await buildContext({ flags, cwd });
  try {
    intro(t('rollback.title'));

    const s = spinner();
    s.start(t('rollback.reading'));
    const entries = await remote.list(ctx.client, REMOTE.backupDir).catch(() => []);
    s.stop(t('rollback.count', { count: entries.length }));

    if (!entries.length) {
      note(t('rollback.none', { dir: REMOTE.backupDir }), t('rollback.noneTitle'));
      outro('');
      return;
    }

    // İsim biçimi: <appRoot>-<YYYYMMDD-HHMMSS>
    const backups = entries
      .filter((e) => e.type === 'dir')
      .map((e) => {
        // Sondaki nokta, damganın hatalı üretildiği sürümlerden kalma
        // yedeklerde bulunuyor; onları da tanıyoruz.
        const m = String(e.name).match(/^(.+)-(\d{8})-?(\d{6})?\.?$/);
        return {
          name: e.name,
          appRoot: m ? m[1] : e.name,
          stamp: m ? `${m[2]}${m[3] ? `-${m[3]}` : ''}` : '',
          size: e.size,
        };
      })
      .sort((a, b) => b.stamp.localeCompare(a.stamp));

    const wantedApp = flags['app-root'] ?? ctx.cfg.project?.appRoot ?? null;
    const wantedDomain = flags.domain ?? ctx.cfg.project?.domain ?? null;

    let candidates = backups;
    if (wantedApp) candidates = backups.filter((b) => b.appRoot === remote.rel(wantedApp));
    if (!candidates.length) {
      log.warn(t('rollback.noneForApp', { name: wantedApp ?? wantedDomain }));
      candidates = backups;
    }

    const picked = await select({
      message: t('rollback.which'),
      options: candidates.slice(0, 20).map((b) => ({
        value: b.name,
        label: `${b.appRoot}  ${color.dim(formatStamp(b.stamp))}`,
        hint: b.size ? bytes(b.size) : '',
      })),
    });

    const backup = candidates.find((b) => b.name === picked);
    const appRoot = backup.appRoot;

    // Sahiplik denetimi burada da geçerli: bu araç yalnızca kendi
    // oluşturduğu klasörlere yazar.
    const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
    if (marker?.tool !== 'cpanel-next' && !flags.adopt) {
      throw new UserError(t('rollback.notOwned', { appRoot }), t('rollback.notOwnedHint'));
    }

    log.warn(t('rollback.warning', { appRoot, backup: `${REMOTE.backupDir}/${backup.name}` }));
    const ok = await typeToConfirm(appRoot);
    if (!ok) throw new UserError(t('common.notConfirmed'));

    const apps = ctx.driver ? await ctx.driver.listApps(ctx) : [];
    const app = apps.find((a) => remote.rel(a.path) === appRoot) ?? { name: appRoot, path: appRoot };

    const r = spinner();
    r.start(t('rollback.working'));

    try {
      if (ctx.driver?.stop) {
        r.message(t('rollback.stopping'));
        await ctx.driver.stop(ctx, app).catch(() => {});
      }

      r.message(t('rollback.cleaning'));
      const cleaned = await remote.cleanDir(ctx.client, appRoot, { keep: [] });
      if (cleaned.failed.length) {
        throw new UserError(t('rollback.cleanFailed', { files: cleaned.failed.slice(0, 5).join(', ') }));
      }

      r.message(t('rollback.restoring'));
      await remote.copy(ctx.client, `${REMOTE.backupDir}/${backup.name}`, appRoot);

      if (!(await remote.exists(ctx.client, `${appRoot}/package.json`))) {
        throw new UserError(t('rollback.missingPackageJson'));
      }

      if (ctx.driver?.applyAll) {
        r.message(t('rollback.installingCron'));
        await ctx.driver.applyAll(ctx, {
          appRoot,
          domain: app.domain ?? wantedDomain,
          startupFile: app.startupFile ?? 'server.js',
          isNew: false,
          existingAppRoot: app.path,
          onProgress: (step) => r.message(step),
        });
      } else {
        r.message(t('rollback.installing'));
        await ctx.driver.installDeps(ctx, app, { onProgress: (l) => r.message(String(l).slice(0, 60)) });
        r.message(t('rollback.starting'));
        await ctx.driver.start(ctx, app).catch(() => {});
        await ctx.driver.restart(ctx, app, {
          url: app.domain ? `https://${app.domain}` : null,
        });
      }

      r.stop(t('rollback.doneSpinner'));
    } catch (err) {
      r.stop(t('rollback.failed'), 1);
      throw err;
    }

    note(
      [
        `${color.dim(t('rollback.labelFolder'))}  ~/${appRoot}`,
        `${color.dim(t('rollback.labelBackup'))}   ~/${REMOTE.backupDir}/${backup.name}`,
        app.domain ? `${color.dim(t('rollback.labelUrl'))}   ${color.cyan(`https://${app.domain}`)}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      t('rollback.doneTitle')
    );
    outro(color.green(t('rollback.done')));
  } finally {
    await runCleanup(ctx);
  }
}

function formatStamp(stamp) {
  const m = String(stamp).match(/^(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?$/);
  if (!m) return stamp;
  return `${m[3]}.${m[2]}.${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`;
}
