import { spawn } from 'node:child_process';
import { loadGlobalConfig } from '../config.mjs';
import { startServer } from '../ui-server/server.mjs';
import { t } from '../i18n/index.mjs';
import { intro, note, log, color, UserError } from '../ui.mjs';

/**
 * Yerel yönetim arayüzünü açar.
 *
 * Sunucu yalnızca 127.0.0.1'e bağlanır ve adres tek kullanımlık bir jeton
 * taşır; jetonsuz istek 403 alır. Ayrıntılar ve gerekçeler: ui-server/server.mjs
 */
export async function run({ flags }) {
  intro(t('ui.title'));

  const config = loadGlobalConfig();
  if (!Object.keys(config.profiles ?? {}).length) {
    throw new UserError(t('common.noProfile'), t('common.runLogin'));
  }

  const { url, port, close } = await startServer({
    port: Number(flags.port) || 0,
    lang: flags.lang ?? null,
    verbose: flags.verbose,
  });

  note(
    [
      `${color.dim(t('ui.address'))}  ${color.cyan(url)}`,
      `${color.dim(t('ui.bound'))}  127.0.0.1:${port}`,
    ].join('\n'),
    t('ui.running')
  );
  log.info(t('ui.security'));
  log.info(t('ui.stop'));

  if (!flags['no-open']) openBrowser(url);

  // Süreç açık kalsın: işler sunucuda yaşıyor, sekme kapansa da sürüyorlar.
  await new Promise((resolve) => {
    const shutdown = async () => {
      await close();
      log.success(t('ui.stopped'));
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* açılamazsa adres zaten ekranda */
  }
}
