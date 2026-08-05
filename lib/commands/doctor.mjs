import fs from 'node:fs';
import { resolveConfig, maskSecret } from '../config.mjs';
import { CpanelClient } from '../cpanel.mjs';
import { probe } from '../probe.mjs';
import { ensureToken } from '../auth.mjs';
import { detectProject } from '../detect.mjs';
import { isChromiumInstalled, BROWSERS_DIR } from '../browser/ensure.mjs';
import { CONFIG_FILE } from '../paths.mjs';
import { regimeLabel } from '../context.mjs';
import { t } from '../i18n/index.mjs';
import { intro, outro, note, color, log } from '../ui.mjs';

/**
 * Tanılama.
 *
 * Amaç: bir şey çalışmadığında "neyin çalıştığını" tek ekranda göstermek.
 * Hiçbir yazma işlemi yapmaz.
 */
export async function run({ flags, cwd }) {
  intro(t('doctor.title'));
  const rows = [];

  /* ---- yerel ortam ------------------------------------------------------ */
  const nodeOk = isNodeSupported(process.versions.node);
  rows.push(check(nodeOk, `Node.js ${process.versions.node}`, nodeOk ? '' : t('doctor.nodeNeeds')));
  rows.push(check(true, t('doctor.platform', { platform: process.platform, arch: process.arch })));

  const chromium = await isChromiumInstalled();
  rows.push(
    check(
      true,
      chromium ? t('doctor.chromiumInstalled') : t('doctor.chromiumMissing'),
      chromium ? BROWSERS_DIR : t('doctor.chromiumHint')
    )
  );

  /* ---- yapılandırma ----------------------------------------------------- */
  const cfg = resolveConfig(flags, cwd);
  for (const w of cfg.warnings) log.warn(w);

  const hasConfig = fs.existsSync(CONFIG_FILE);
  let perms = '';
  if (hasConfig) {
    try {
      perms = (fs.statSync(CONFIG_FILE).mode & 0o777).toString(8);
    } catch {
      /* yok say */
    }
  }
  rows.push(
    check(
      hasConfig,
      hasConfig ? t('doctor.configAt', { file: CONFIG_FILE, mode: perms }) : t('doctor.configMissing'),
      hasConfig ? '' : t('doctor.configMissingHint')
    )
  );
  rows.push(
    check(Boolean(cfg.host), t('doctor.server', { host: cfg.host ?? '-', port: cfg.port }), cfg.sources.host ?? '')
  );
  rows.push(check(Boolean(cfg.user), t('doctor.account', { user: cfg.user ?? '-' }), cfg.sources.user ?? ''));
  rows.push(
    check(
      Boolean(cfg.token || cfg.tokenEnc),
      cfg.token || cfg.tokenEnc
        ? t('doctor.token', { value: cfg.token ? maskSecret(cfg.token) : t('vault.inVault') })
        : t('doctor.tokenMissing'),
      cfg.token || cfg.tokenEnc ? (cfg.sources.token ?? '') : t('doctor.tokenMissingHint')
    )
  );

  note(rows.join('\n'), t('doctor.envTitle'));

  /* ---- sunucu ----------------------------------------------------------- */
  if (cfg.host && cfg.user && (cfg.token || cfg.tokenEnc)) {
    const serverRows = [];
    // Kasadaki token'ı burada açıyoruz; aksi hâlde aşağıdaki istemci
    // token'sız kurulur ve bütün sunucu denetimleri boşuna patlar.
    cfg.token = await ensureToken(cfg, flags);
    const client = new CpanelClient({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      token: cfg.token,
      insecure: flags.insecure,
      verbose: flags.verbose,
    });

    try {
      const info = await client.whoami();
      serverRows.push(check(true, t('doctor.uapiOk')));
      if (info?.maximum_passenger_apps !== undefined) {
        serverRows.push(check(true, t('doctor.quota', { value: info.maximum_passenger_apps })));
      }
    } catch (err) {
      serverRows.push(check(false, t('doctor.uapiFail'), err.message));
      note(serverRows.join('\n'), t('doctor.serverTitle'));
      outro(color.red(t('doctor.connectFailed')));
      return;
    }

    // API2 en kırılgan nokta: token'ların API2'de çalışıp çalışmadığı cPanel
    // dokümanlarında belgeli değil. Kullanıcı bunu önden bilsin.
    try {
      await client.api2('Cron', 'listcron', {});
      serverRows.push(check(true, t('doctor.api2Ok')));
    } catch (err) {
      serverRows.push(
        check(false, t('doctor.api2Fail'), t('doctor.api2FailHint', { error: err.message.slice(0, 60) }))
      );
    }

    try {
      const p = await probe(client, { refresh: true, verbose: flags.verbose });
      serverRows.push(check(p.regime !== 'unknown', t('doctor.regime', { label: regimeLabel(p.regime) })));
      serverRows.push(check(p.hasPassengerApps, t('doctor.passengerModule')));
      if (p.hasWebApp) serverRows.push(check(true, t('doctor.webappModule')));
      serverRows.push(check(true, t('doctor.appCount', { count: p.apps.length })));
      for (const line of p.evidence) serverRows.push(color.dim(`     ${line}`));
    } catch (err) {
      serverRows.push(check(false, t('doctor.probeFail'), err.message));
    }

    try {
      const ftp = await client.uapi('Ftp', 'get_ftp_daemon_info', {}).catch(() => null);
      serverRows.push(
        check(Boolean(ftp?.type), t('doctor.ftp', { state: ftp?.type ?? t('doctor.ftpOff') }), ftp?.type ? '' : t('doctor.ftpHint'))
      );
    } catch {
      /* önemsiz */
    }

    note(serverRows.join('\n'), t('doctor.serverTitle'));
  } else {
    log.info(t('doctor.loginFirst'));
  }

  /* ---- yerel proje ------------------------------------------------------ */
  const project = detectProject(cwd);
  const projectRows = [
    check(project.framework !== 'unknown', t('doctor.framework', { name: project.framework })),
  ];
  if (project.framework === 'nextjs') {
    projectRows.push(
      check(true, t('doctor.nextInfo', { version: project.nextVersion, router: project.router }))
    );
    projectRows.push(
      check(
        project.hasServerJs,
        `${project.startupFile}`,
        project.hasServerJs ? '' : t('doctor.startupWillCreate')
      )
    );
  }
  for (const b of project.blockers) projectRows.push(check(false, b));
  for (const w of project.warnings) projectRows.push(color.yellow(`  !  ${w}`));
  projectRows.push(
    check(project.deployable, project.deployable ? t('doctor.deployable') : t('doctor.notDeployable'))
  );

  note(projectRows.join('\n'), t('doctor.projectTitle', { dir: cwd }));

  outro('');
}

function isNodeSupported(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 18 || (major === 18 && minor >= 17);
}

function check(ok, label, hint = '') {
  const mark = ok ? color.green('  ✓') : color.red('  ✗');
  return `${mark} ${label}${hint ? color.dim(`  — ${hint}`) : ''}`;
}
