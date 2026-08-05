import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from '../config.mjs';
import { CpanelClient } from '../cpanel.mjs';
import { ensureToken } from '../auth.mjs';
import { probe } from '../probe.mjs';
import { loadDriver, regimeLabel } from '../context.mjs';
import { detectProject, SERVER_TEMPLATE } from '../detect.mjs';
import { listDomains, resolveDomain } from '../domain.mjs';
import { planZip, DEFAULT_EXCLUDES } from '../packager.mjs';
import { readOwnerMarker } from '../guards.mjs';
import { runDeploy, withSessionFallback } from '../deploy-core.mjs';
import { cancelJob } from '../shell/worker.mjs';
import * as remote from '../remote.mjs';
import { t } from '../i18n/index.mjs';
import { intro, outro, note, spinner, log, color, bytes, confirm, UserError } from '../ui.mjs';

/**
 * Tek tuşla güncelleme.
 *
 * `deploy` ile aynı hattı kullanıyor ama HİÇBİR ŞEY SORMUYOR: hedef zaten
 * `.cpanel-next.json` içinde kayıtlı.
 *
 * YAZARAK ONAY neden yok: o onay yanlış HEDEF SEÇİMİNİ yakalamak için var.
 * Burada seçim yapılmıyor — daha önce bu projeden bu klasöre yayın yapılmış
 * ve bu iki yerden birden doğrulanıyor:
 *   · proje kökündeki .cpanel-next.json
 *   · sunucudaki sahiplik işareti (aynı proje yolunu göstermeli)
 * İkisi uyuşmazsa güncelleme reddediliyor ve `deploy` yoluna yönlendiriliyor.
 */
export async function run({ flags, cwd }) {
  intro(t('update.title'));

  const cfg = resolveConfig(flags, cwd);
  if (!cfg.project?.appRoot || !cfg.project?.domain) {
    throw new UserError(t('update.notLinked'), t('update.notLinkedHint'));
  }
  if (!cfg.host || !cfg.user) throw new UserError(t('common.noProfile'), t('common.runLogin'));

  const project = detectProject(cwd);
  if (!project.deployable) {
    for (const b of project.blockers) log.error(b);
    throw new UserError(t('deploy.notDeployable'));
  }

  cfg.token = await ensureToken(cfg, flags);
  const ctx = {
    flags,
    cwd,
    cfg,
    cleanup: [],
    capabilities: {},
    client: new CpanelClient({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      token: cfg.token,
      insecure: flags.insecure,
      verbose: flags.verbose,
    }),
  };

  const appRoot = remote.rel(cfg.project.appRoot);

  const s0 = spinner();
  s0.start(t('update.checking'));
  ctx.probeResult = await withSessionFallback(ctx, () => probe(ctx.client, { verbose: flags.verbose }));
  ctx.driver = await loadDriver(ctx.probeResult.regime);
  if (!ctx.driver) {
    s0.stop(t('deploy.noDriver'), 1);
    throw new UserError(t('deploy.noDriver'), t('deploy.noDriverHint'));
  }

  const domains = await withSessionFallback(ctx, () => listDomains(ctx.client));
  const target = await resolveDomain(ctx.client, cfg.project.domain, domains);
  if (target.kind === 'not-found' || target.kind === 'parked') {
    s0.stop(t('update.domainGone', { domain: cfg.project.domain }), 1);
    throw new UserError(t('update.domainGone', { domain: cfg.project.domain }), t('update.notLinkedHint'));
  }

  const dirExists = await remote.exists(ctx.client, appRoot);
  if (!dirExists) {
    s0.stop(t('update.folderGone', { appRoot }), 1);
    throw new UserError(t('update.folderGone', { appRoot }), t('update.notLinkedHint'));
  }

  /* --- iki taraflı doğrulama: bu klasör GERÇEKTEN bu projenin mi --- */
  const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
  const linked = marker?.tool === 'cpanel-next' && sameDir(marker.project, cwd);
  s0.stop(`${regimeLabel(ctx.probeResult.regime)} · ~/${appRoot}`);

  if (!linked) {
    log.warn(
      marker?.project
        ? t('update.otherProject', { project: marker.project })
        : t('update.noMarker', { appRoot })
    );
    if (!flags.yes) {
      const ok = await confirm({ message: t('update.confirmAnyway') });
      if (!ok) throw new UserError(t('common.cancelled'));
    }
  }

  const apps = await ctx.driver.listApps(ctx);
  const existingApp = apps.find((a) => remote.rel(a.path) === appRoot) ?? null;

  const startupPath = path.join(cwd, project.startupFile);
  if (!fs.existsSync(startupPath)) fs.writeFileSync(startupPath, SERVER_TEMPLATE);

  const excludes = [...DEFAULT_EXCLUDES, ...(cfg.project.exclude ?? [])];
  const plan = planZip(cwd, { excludes, allowEnv: [] });

  note(
    [
      `${color.dim(t('deploy.sUrl'))}   ${color.cyan(`https://${target.domain}`)}`,
      `${color.dim(t('deploy.sApp'))}   ~/${appRoot}`,
      `${color.dim(t('deploy.sPackage'))}   ${plan.included.length} · ${bytes(plan.bytes)}`,
    ].join('\n'),
    t('update.title')
  );

  const s = spinner();
  s.start(t('deploy.applying'));

  let jobId = null;
  const onSigint = () => {
    if (!jobId) return;
    s.message(t('worker.cancelling'));
    cancelJob(ctx, jobId).catch(() => {});
  };
  process.on('SIGINT', onSigint);

  const notices = [];
  let result;
  try {
    result = await runDeploy(
      ctx,
      {
        cwd,
        project,
        target,
        appRoot,
        appName: cfg.project.appName || appRoot,
        existingApp,
        dirExists,
        excludes,
        preserve: cfg.project.preserve ?? ['.env.local', '.env.production.local'],
        noBuild: flags['no-build'],
        transport: flags.transport,
        nodeVersion: flags['node-version'] ?? cfg.project.nodeVersion,
        cleanModules: flags['clean-modules'],
        hooks: cfg.project.hooks ?? {},
        includedFiles: plan.included,
      },
      (e) => {
        if (e.type === 'job') jobId = e.jobId;
        else if (e.type === 'progress') {
          s.message(t('deploy.uploadingProgress', { sent: bytes(e.sent), total: bytes(e.total) }));
        } else if (e.type === 'remote') s.message(`${e.text}${e.pct ? ` (${e.pct}%)` : ''}`);
        else if (e.type === 'step') {
          s.message(
            e.key === 'deploy.packed'
              ? t('deploy.packed', { files: e.params.files, size: bytes(e.params.size) })
              : e.text
          );
        } else if (e.type === 'info' || e.type === 'warn') notices.push({ level: e.type, text: e.text });
      }
    );
    s.stop(t('deploy.published'));
  } catch (err) {
    s.stop(err?.cancelled ? t('worker.cancelled', { label: t('update.title') }) : t('deploy.remoteFailed'), 1);
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
    for (const fn of ctx.cleanup) await fn().catch(() => {});
  }

  for (const n of notices) (n.level === 'warn' ? log.warn : log.info)(n.text);
  outro(`${color.green(t('deploy.live'))}  ${color.cyan(result.url)}`);
}

function sameDir(a, b) {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}
