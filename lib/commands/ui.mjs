import { spawn } from 'node:child_process';
import { loadGlobalConfig } from '../config.mjs';
import { startServer } from '../ui-server/server.mjs';
import { detectProject } from '../detect.mjs';
import { t } from '../i18n/index.mjs';
import { intro, outro, note, spinner, log, color, UserError } from '../ui.mjs';

/**
 * Yerel yönetim arayüzü.
 *
 * Terminal, tarayıcı kapanana kadar bekler ve sonra geri döner. "Kapandı"
 * bilgisi kalp atışından geliyor (bkz. ui-server/state.mjs); sayfa atmayı
 * kesince ~12 sn içinde çıkılır.
 *
 * Sunucu yalnızca 127.0.0.1'e bağlanır ve adres tek kullanımlık bir jeton
 * taşır. Ayrıntılar ve gerekçeler: ui-server/server.mjs
 */
export async function run({ flags, cwd }) {
  intro(t('ui.title'));

  const config = loadGlobalConfig();
  if (!Object.keys(config.profiles ?? {}).length) {
    throw new UserError(t('common.noProfile'), t('common.runLogin'));
  }

  const srv = await startServer({
    port: Number(flags.port) || 0,
    lang: flags.lang ?? null,
    verbose: flags.verbose,
  });

  // Bulunduğumuz dizin bir Next.js projesiyse arayüz onu hazır seçsin —
  // kullanıcı zaten o projeyi yayınlamak için buraya geldi.
  const project = detectProject(cwd);
  if (project.framework === 'nextjs') {
    srv.state.initialProject = { path: cwd, name: cwd.split('/').pop() };
  }

  note(
    [
      `${color.dim(t('ui.address'))}  ${color.cyan(srv.url)}`,
      `${color.dim(t('ui.bound'))}  127.0.0.1:${srv.port}`,
    ].join('\n'),
    t('ui.running')
  );
  log.info(t('ui.security'));

  if (!flags['no-open']) openBrowser(srv.url);

  const s = spinner();
  s.start(t('ui.waiting'));

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    srv.state.exitRequested = true;
  };
  process.on('SIGINT', onSigint);

  await srv.waitUntilClosed();
  process.off('SIGINT', onSigint);

  s.stop(interrupted ? t('ui.stopped') : t('ui.browserClosed'));
  await srv.close();

  outro('');
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
