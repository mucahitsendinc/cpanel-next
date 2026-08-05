import { buildContext, runCleanup } from '../context.mjs';
import { t } from '../i18n/index.mjs';
import * as remote from '../remote.mjs';
import { REMOTE } from '../paths.mjs';
import { readOwnerMarker } from '../guards.mjs';
import { intro, outro, note, select, spinner, table, color, log } from '../ui.mjs';

/**
 * Son çalıştırmaların sonucunu gösterir.
 *
 * İki kaynak: uygulama klasöründeki deploy geçmişi, ve (CloudLinux yolunda)
 * `~/.cpanel-next-run/` altında kalmış durum dosyaları. İkincisi, CLI yarıda
 * kesilmişse işin sunucuda tamamlanıp tamamlanmadığını gösterir — cron
 * köprüsünün bütün amacı bu.
 */
export async function run({ flags, cwd }) {
  const ctx = await buildContext({ flags, cwd, needProbe: false });
  try {
    intro(t('logs.title'));

    const appRoot = flags['app-root'] ?? ctx.cfg.project?.appRoot ?? null;

    /* ---- yarım kalmış / biten sunucu işleri ---------------------------- */
    const s = spinner();
    s.start(t('logs.reading'));
    const runFiles = (await remote.list(ctx.client, REMOTE.runDir).catch(() => []))
      .filter((e) => e.type === 'file' && /^status_.*\.json$/.test(String(e.name)))
      .sort((a, b) => b.mtime - a.mtime);
    s.stop(t('logs.count', { count: runFiles.length }));

    if (runFiles.length) {
      const picked =
        runFiles.length === 1
          ? runFiles[0].name
          : await select({
              message: t('logs.which'),
              options: runFiles.slice(0, 10).map((f) => ({
                value: f.name,
                label: f.name.replace(/^status_|\.json$/g, ''),
                hint: f.mtime ? new Date(f.mtime * 1000).toLocaleString('tr-TR') : '',
              })),
            });

      const status = await remote.readJson(ctx.client, REMOTE.runDir, picked).catch(() => null);
      if (status) {
        const head = status.done
          ? status.ok
            ? color.green(t('logs.completed'))
            : color.red(t('logs.failed', { error: status.error ?? '' }))
          : color.yellow(t('logs.running', { progress: status.progress ?? 0, step: status.step ?? '' }));
        note(head, picked);
        if (status.output) {
          console.log('');
          console.log(color.dim(t('logs.outputHeader')));
          console.log(String(status.output).slice(-4000));
          console.log('');
        }
      }
    } else {
      log.info(t('logs.none'));
    }

    /* ---- deploy geçmişi ------------------------------------------------- */
    if (appRoot) {
      const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
      const history = await remote
        .readJson(ctx.client, appRoot, REMOTE.historyFile)
        .catch(() => null);

      if (marker) {
        note(
          [
            `${color.dim(t('logs.labelFolder'))}    ~/${appRoot}`,
            `${color.dim(t('logs.labelDomain'))}    ${marker.domain ?? '-'}`,
            `${color.dim(t('logs.labelProject'))}     ${marker.project ?? '-'}`,
            `${color.dim(t('logs.labelMachine'))}    ${marker.machine ?? '-'}`,
            `${color.dim(t('logs.labelVersion'))}     ${marker.version ?? '-'}`,
            `${color.dim(t('logs.labelCreated'))} ${marker.createdAt ?? '-'}`,
          ].join('\n'),
          t('logs.markerTitle')
        );
      }

      if (Array.isArray(history) && history.length) {
        console.log('');
        console.log(
          table(
            t('logs.historyHeaders'),
            history
              .slice(-15)
              .reverse()
              .map((h) => [
                h.date ?? '-',
                h.version ?? '-',
                h.ok === false ? color.red(t('logs.historyFail')) : color.green(t('logs.historyOk')),
              ])
          )
        );
        console.log('');
      }
    } else {
      log.info(t('logs.needApp'));
    }

    outro('');
  } finally {
    await runCleanup(ctx);
  }
}
