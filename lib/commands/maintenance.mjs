import { buildContext, runCleanup } from '../context.mjs';
import { listDomains, resolveDomain } from '../domain.mjs';
import { enableMaintenance, disableMaintenance, isMaintenanceOn } from '../maintenance.mjs';
import { intro, outro, select, spinner, note, log, color, UserError } from '../ui.mjs';
import { t } from '../i18n/index.mjs';

/**
 * Bakım sayfasını elle aç/kapat.
 *
 * Deploy yarıda kalırsa bakım modu AÇIK bırakılıyor (ziyaretçiye ham hata
 * göstermemek için). Bu komut onu kapatmanın yolu.
 */
export async function run({ flags, positionals, cwd }) {
  const action = positionals[0];
  if (!['on', 'off', 'status'].includes(action ?? 'status')) {
    throw new UserError(t('maintenance.usage'));
  }

  const ctx = await buildContext({ flags, cwd, needProbe: false });
  try {
    intro(t('maintenance.title'));

    const domains = await listDomains(ctx.client);
    const wanted =
      flags.domain ??
      ctx.cfg.project?.domain ??
      (await select({
        message: t('maintenance.which'),
        options: domains
          .filter((d) => d.type !== 'parked')
          .map((d) => ({ value: d.domain, label: d.domain })),
      }));

    const target = await resolveDomain(ctx.client, wanted, domains);
    if (!target.docroot) throw new UserError(t('maintenance.noDocroot', { domain: wanted }));

    const s = spinner();
    if ((action ?? 'status') === 'status') {
      s.start(t('maintenance.checking'));
      const on = await isMaintenanceOn(ctx.client, target.docroot);
      s.stop(on ? t('maintenance.isOn') : t('maintenance.isOff'));
    } else if (action === 'on') {
      s.start(t('maintenance.turningOn'));
      await enableMaintenance(ctx.client, target.docroot, { domain: target.domain });
      s.stop(t('maintenance.isOn'));
    } else {
      s.start(t('maintenance.turningOff'));
      await disableMaintenance(ctx.client, target.docroot);
      s.stop(t('maintenance.isOff'));
    }

    note(
      [
        `${color.dim(t('maintenance.labelDomain'))}  ${target.domain}`,
        `${color.dim(t('maintenance.labelDocroot'))}  ${target.docroot}`,
      ].join('\n'),
      t('maintenance.title')
    );
    outro('');
  } finally {
    await runCleanup(ctx);
  }
}
