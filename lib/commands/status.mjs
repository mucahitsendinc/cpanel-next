import { buildContext, runCleanup, regimeLabel } from '../context.mjs';
import { t } from '../i18n/index.mjs';
import { listDomains, resolveDomain, TYPE_LABEL } from '../domain.mjs';
import { detectProject } from '../detect.mjs';
import { readOwnerMarker } from '../guards.mjs';
import { intro, outro, table, note, spinner, color, log } from '../ui.mjs';

export async function run({ flags, cwd }) {
  const ctx = await buildContext({ flags, cwd });
  try {
    intro(t('status.title'));

    const s = spinner();
    s.start(t('status.reading'));
    const domains = await listDomains(ctx.client);
    const apps = ctx.driver ? await ctx.driver.listApps(ctx) : [];
    s.stop(t('status.summary', { domains: domains.length, apps: apps.length }));

    const wanted = flags.domain ?? ctx.cfg.project?.domain ?? null;

    note(
      [
        `${color.dim(t('status.labelServer'))}   ${ctx.cfg.host}:${ctx.cfg.port}`,
        `${color.dim(t('status.labelAccount'))}    ${ctx.cfg.user}`,
        `${color.dim(t('status.labelRegime'))}    ${regimeLabel(ctx.probeResult.regime)}`,
        `${color.dim(t('status.labelAuth'))}   ${ctx.cfg.token ? t('status.authToken') : t('status.authSession')}`,
      ].join('\n'),
      t('status.connectionTitle')
    );

    console.log('');
    console.log(
      table(
        t('status.headers'),
        domains.map((d) => {
          const app = apps.find((a) => a.domain === d.domain);
          return [
            wanted && d.domain === wanted ? color.cyan(d.domain) : d.domain,
            TYPE_LABEL[d.type] ?? d.type,
            d.docroot ?? color.dim('-'),
            app ? `${app.name} ${color.dim(`(~/${app.path})`)}` : color.dim('—'),
          ];
        })
      )
    );
    console.log('');

    if (wanted) {
      const resolved = await resolveDomain(ctx.client, wanted, domains);
      if (resolved.kind === 'not-found') {
        log.warn(t('status.notFound', { domain: wanted }));
      } else if (resolved.kind === 'new-subdomain') {
        log.info(t('status.canCreateSub', { domain: wanted, root: resolved.rootDomain }));
      } else if (resolved.kind === 'parked') {
        log.warn(resolved.reason);
      }
    }

    // Yerel projeyi de göster: kullanıcı zaten bir proje dizinindeyse
    // "buradan ne yayınlanır" sorusunun cevabı burada olsun.
    const project = detectProject(cwd);
    if (project.framework === 'nextjs') {
      const lines = [
        `${color.dim(t('status.labelDir'))}     ${cwd}`,
        `${color.dim(t('status.labelFramework'))}   ${project.nextVersion ?? '?'} · ${project.router ?? '?'} router`,
        `${color.dim(t('status.labelStartup'))} ${project.startupFile}${project.hasServerJs ? '' : color.yellow(t('status.startupMissing'))}`,
        `${color.dim(t('status.labelState'))}     ${project.deployable ? color.green(t('status.deployable')) : color.red(t('status.notDeployable'))}`,
      ];
      for (const b of project.blockers) lines.push(color.red(`  ✗ ${b}`));
      note(lines.join('\n'), t('status.projectTitle'));
    }

    if (apps.length) {
      const owned = [];
      for (const app of apps) {
        const marker = await readOwnerMarker(ctx.client, app.path).catch(() => null);
        if (marker?.tool === 'cpanel-next') owned.push(`${app.name} → ${marker.project ?? '?'}`);
      }
      if (owned.length) note(owned.join('\n'), t('status.deployedTitle'));
    }

    outro('');
  } finally {
    await runCleanup(ctx);
  }
}
