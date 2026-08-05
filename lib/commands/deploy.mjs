import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig, saveProjectConfig } from '../config.mjs';
import { CpanelClient } from '../cpanel.mjs';
import { escalateToSession, ensureToken } from '../auth.mjs';
import { probe } from '../probe.mjs';
import { detectProject, SERVER_TEMPLATE } from '../detect.mjs';
import { listDomains, resolveDomain, normalize, TYPE_LABEL } from '../domain.mjs';
import { planZip, DEFAULT_EXCLUDES } from '../packager.mjs';
import * as remote from '../remote.mjs';
import { assertAppRoot, inspectOwnership, isDestructive } from '../guards.mjs';
import { runDeploy, withSessionFallback } from '../deploy-core.mjs';
import { REMOTE } from '../paths.mjs';
import { t } from '../i18n/index.mjs';
import {
  intro,
  outro,
  note,
  select,
  text,
  confirm,
  spinner,
  log,
  color,
  bytes,
  typeToConfirm,
  UserError,
} from '../ui.mjs';

export async function run({ flags, cwd }) {
  const ctx = { flags, cwd, cleanup: [], capabilities: {} };
  try {
    await deploy(ctx);
  } finally {
    for (const fn of ctx.cleanup) await fn().catch(() => {});
  }
}

async function deploy(ctx) {
  const { flags, cwd } = ctx;
  intro(`${t('deploy.title')}${flags['dry-run'] ? color.yellow(t('deploy.dryRunBadge')) : ''}`);

  /* -- 1. Proje ---------------------------------------------------------- */
  const project = detectProject(cwd);
  ctx.project = project;

  if (project.blockers.length) {
    for (const b of project.blockers) log.error(b);
    throw new UserError(t('deploy.notDeployable'));
  }
  for (const w of project.warnings) log.warn(w);

  log.step(
    t('deploy.projectLine', {
      framework: color.bold(`Next.js ${project.nextVersion ?? ''}`),
      router: project.router ?? '?',
      name: path.basename(cwd),
    })
  );

  /* -- 2. Bağlantı ------------------------------------------------------- */
  const cfg = resolveConfig(flags, cwd);
  ctx.cfg = cfg;
  for (const warning of cfg.warnings) log.warn(warning);

  if (!cfg.host || !cfg.user) {
    throw new UserError(t('common.noProfile'), t('common.runLogin'));
  }

  // Token kasadaysa burada açılır — ana şifre bir kez sorulur.
  cfg.token = await ensureToken(cfg, flags);

  ctx.client = new CpanelClient({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    token: cfg.token,
    insecure: flags.insecure,
    verbose: flags.verbose,
  });

  if (!cfg.token) {
    // Token yoksa (host apitokens'ı kapatmış olabilir) doğrudan oturum kipi.
    await escalateToSession(ctx, t('doctor.tokenMissing'));
    ctx.client = ctx.sessionClient;
  }

  /* -- 3. Sunucu yetenekleri --------------------------------------------- */
  const s1 = spinner();
  s1.start(t('deploy.probing'));
  const probeResult = await withSessionFallback(ctx, () =>
    probe(ctx.client, { refresh: flags.force, verbose: flags.verbose })
  );
  ctx.probeResult = probeResult;
  s1.stop(
    t('deploy.probed', { regime: color.bold(regimeLabel(probeResult.regime)) }) +
      (probeResult.cached ? color.dim(t('deploy.cached')) : '')
  );

  const driver = await loadDriver(probeResult.regime);
  ctx.driver = driver;

  if (!driver) {
    throw new UserError(t('deploy.noDriver'), t('deploy.noDriverHint'));
  }

  /* -- 4. Domain --------------------------------------------------------- */
  const domains = await withSessionFallback(ctx, () => listDomains(ctx.client));
  ctx.domains = domains;

  if (!domains.length) {
    throw new UserError(t('deploy.noDomains', { user: cfg.user, host: cfg.host }));
  }

  const target = await chooseDomain(ctx, domains);
  ctx.target = target;

  /* -- 5. Uygulama ------------------------------------------------------- */
  const apps = await withSessionFallback(ctx, () => driver.listApps(ctx));
  ctx.apps = apps;

  const choice = await chooseApp(ctx, apps, target.domain);
  ctx.choice = choice;

  const appRoot = assertAppRoot(choice.appRoot, {
    docroots: domains.map((d) => d.docroot).filter(Boolean),
    force: flags.force,
  });
  ctx.appRoot = appRoot;
  ctx.appName = choice.appName || appRoot;

  const dirExists = await remote.exists(ctx.client, appRoot);
  ctx.dirExists = dirExists;

  ctx.ownership = await withSessionFallback(ctx, () =>
    inspectOwnership(ctx.client, appRoot, { dirExists, apps, domain: target.domain })
  );

  /* -- 6. server.js ------------------------------------------------------ */
  const startupPath = path.join(cwd, project.startupFile);
  let startupCreated = false;
  if (!fs.existsSync(startupPath)) {
    if (!flags['dry-run']) {
      fs.writeFileSync(startupPath, SERVER_TEMPLATE);
      startupCreated = true;
    }
    log.info(t('deploy.startupCreated', { file: project.startupFile }));
  }

  /* -- 7. Paket planı ---------------------------------------------------- */
  const excludes = [...DEFAULT_EXCLUDES, ...(cfg.project?.exclude ?? [])];
  const plan = planZip(cwd, { excludes, allowEnv: [] });

  /* -- 8. Onay ----------------------------------------------------------- */
  const destructive = isDestructive({ dirExists, adopt: flags.adopt, force: flags.force });
  const url = `https://${target.domain}`;
  const notices = [];

  printSummary(ctx, { plan, destructive, url, startupCreated });

  if (flags['dry-run']) {
    printDryRunSteps(ctx);
    outro(color.yellow(t('deploy.dryRunDone')));
    return;
  }

  if (ctx.ownership?.state === 'other-domain') {
    log.warn(t('deploy.ownerOtherDomainWarn', { domain: ctx.ownership.app?.domain ?? '?' }));
  }

  if (destructive) {
    log.warn(
      t('deploy.destructiveWarn', { appRoot }) +
        (choice.mode === 'update' ? t('deploy.destructiveWarnPreserve') : '')
    );
    // Etkileşimsiz kullanımda (CI, betik) `--confirm <app-root>` yazarak onayın
    // yerine geçer. `--yes` BİLEREK yetmiyor: yıkıcı işlem için klasör adının
    // birebir verilmesi gerekiyor, yani hedef kazara seçilmiş olamaz.
    if (flags.confirm !== undefined) {
      if (flags.confirm !== appRoot) {
        throw new UserError(
          t('deploy.confirmMismatch', { given: flags.confirm, appRoot }),
          t('deploy.confirmMismatchHint')
        );
      }
      log.info(t('deploy.confirmedByFlag', { appRoot }));
    } else {
      const ok = await typeToConfirm(appRoot);
      if (!ok) throw new UserError(t('common.notConfirmed'));
    }
  } else if (!flags.yes) {
    const ok = await confirm({ message: t('deploy.askPublish', { url }) });
    if (!ok) throw new UserError(t('common.cancelled'));
  }

  /* -- 9-15. Yürütme ----------------------------------------------------- */
  // Buradan sonrası arayüzden bağımsız: aynı hattı yerel web arayüzü de
  // kullanıyor (bkz. lib/deploy-core.mjs). Terminale özgü tek şey, olayları
  // spinner'a bağlayan aşağıdaki köprü.
  const s2 = spinner();
  s2.start(t('deploy.applying'));

  let result;
  try {
    result = await runDeploy(
      ctx,
      {
        cwd,
        project,
        target,
        appRoot,
        appName: ctx.appName,
        existingApp: choice.app ?? null,
        dirExists,
        excludes,
        preserve: cfg.project?.preserve ?? ['.env.local', '.env.production.local'],
        noBuild: flags['no-build'],
        transport: flags.transport,
        nodeVersion: flags['node-version'] ?? cfg.project?.nodeVersion,
        cleanModules: flags['clean-modules'],
        includedFiles: plan.included,
      },
      (e) => {
        if (e.type === 'progress') {
          s2.message(t('deploy.uploadingProgress', { sent: bytes(e.sent), total: bytes(e.total) }));
        } else if (e.type === 'remote') {
          s2.message(`${e.text}${e.pct ? ` (${e.pct}%)` : ''}`);
        } else if (e.type === 'step') {
          s2.message(
            e.key === 'deploy.packed'
              ? t('deploy.packed', { files: e.params.files, size: bytes(e.params.size) })
              : e.text
          );
        } else if (e.type === 'info' || e.type === 'warn') {
          // Bilgi satırları spinner'ı bozmasın diye biriktirilip sonda basılır.
          notices.push({ level: e.type, text: e.text });
        }
      }
    );
    s2.stop(t('deploy.published'));
  } catch (err) {
    s2.stop(t('deploy.remoteFailed'), 1);
    throw err;
  }

  for (const n of notices) (n.level === 'warn' ? log.warn : log.info)(n.text);

  /* -- 16. Proje dosyası + sonuç ----------------------------------------- */
  saveProjectConfig(cwd, {
    host: cfg.host,
    user: cfg.user,
    domain: target.domain,
    appName: ctx.appName,
    appRoot,
    startupFile: project.startupFile,
    preserve: cfg.project?.preserve ?? ['.env.local', '.env.production.local'],
  });

  note(
    [
      `${color.dim(t('deploy.labelUrl'))}      ${color.cyan(result.url)}`,
      `${color.dim(t('deploy.labelAccount'))}      ${cfg.user}@${cfg.host}`,
      `${color.dim(t('deploy.labelFolder'))}     ~/${appRoot}`,
      result.backupPath ? `${color.dim(t('deploy.labelBackup'))}      ~/${result.backupPath}` : null,
      `${color.dim(t('deploy.labelRollback'))}  deploymanager rollback --domain ${target.domain}`,
    ]
      .filter(Boolean)
      .join('\n'),
    t('deploy.doneTitle')
  );

  outro(color.green(t('deploy.live')));
}

/* ------------------------------------------------------------- yardımcılar */

async function loadDriver(regime) {
  if (regime === 'cloudlinux') return import('../drivers/cloudlinux.mjs');
  if (regime === 'passenger') return import('../drivers/passenger.mjs');
  return null;
}

function regimeLabel(regime) {
  return t(`regime.${regime === 'cloudlinux' || regime === 'passenger' ? regime : 'unknown'}`);
}

async function chooseDomain(ctx, domains) {
  const { flags, cfg } = ctx;
  const preset = flags.domain ?? cfg.project?.domain;

  if (preset) {
    const resolved = await resolveDomain(ctx.client, preset, domains);
    if (resolved.kind === 'not-found') {
      throw new UserError(
        t('deploy.domainNotFound', { domain: normalize(preset) }),
        t('deploy.domainNotFoundHint', { list: domains.map((d) => d.domain).join('\n  ') })
      );
    }
    if (resolved.kind === 'parked') throw new UserError(resolved.reason);
    return resolved;
  }

  const options = domains
    .filter((d) => d.type !== 'parked')
    .map((d) => ({
      value: d.domain,
      label: d.domain,
      hint: `${TYPE_LABEL[d.type] ?? d.type}${d.docroot ? ` · ${d.docroot}` : ''}`,
    }));

  options.push({ value: '__new__', label: color.dim(t('deploy.newSubdomain')), hint: '' });

  const picked = await select({
    message: t('deploy.askDomain', { account: color.dim(`${ctx.cfg.user}@${ctx.cfg.host}`) }),
    options,
  });

  if (picked !== '__new__') {
    return resolveDomain(ctx.client, picked, domains);
  }

  const roots = domains.filter((d) => d.type === 'main' || d.type === 'addon');
  const root =
    roots.length === 1
      ? roots[0].domain
      : await select({
          message: t('deploy.askRoot'),
          options: roots.map((d) => ({ value: d.domain, label: d.domain, hint: TYPE_LABEL[d.type] })),
        });

  const label = await text({
    message: t('deploy.askLabel', { root: color.dim(root) }),
    placeholder: 'shop',
    validate: (v) => {
      const s = String(v || '').trim().toLowerCase();
      if (!s) return t('deploy.labelRequired');
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) return t('deploy.labelChars');
      if (domains.some((d) => d.domain === `${s}.${root}`)) return t('deploy.labelExists');
      return undefined;
    },
  });

  const full = `${String(label).trim().toLowerCase()}.${root}`;
  return {
    kind: 'new-subdomain',
    domain: full,
    subLabel: String(label).trim().toLowerCase(),
    rootDomain: root,
    docroot: full,
    domains,
  };
}

async function chooseApp(ctx, apps, domain) {
  const { flags, cfg } = ctx;
  const match = apps.find((a) => a.domain === domain);
  const presetRoot = flags['app-root'] ?? cfg.project?.appRoot;

  if (presetRoot) {
    const app = apps.find((a) => remote.rel(a.path) === remote.rel(presetRoot));
    return {
      mode: app ? 'update' : 'create',
      appRoot: remote.rel(presetRoot),
      appName: flags['app-name'] ?? app?.name ?? cfg.project?.appName,
      app: app ?? null,
    };
  }

  if (match) {
    log.info(t('deploy.appExists', { name: match.name, path: match.path }));
    if (flags.yes || (await confirm({ message: t('deploy.askUpdate', { name: match.name }) }))) {
      return { mode: 'update', appRoot: remote.rel(match.path), appName: match.name, app: match };
    }
  }

  const suggestion = suggestAppRoot(domain, apps);
  const appRoot = await text({
    message: t('deploy.askAppRoot'),
    placeholder: suggestion,
    initialValue: suggestion,
    validate: (v) => {
      try {
        assertAppRoot(String(v || '').trim(), {
          docroots: ctx.domains.map((d) => d.docroot).filter(Boolean),
        });
        return undefined;
      } catch (err) {
        return err.message;
      }
    },
  });

  const clean = String(appRoot).trim();
  const app = apps.find((a) => remote.rel(a.path) === clean) ?? null;
  return {
    mode: app ? 'update' : 'create',
    appRoot: clean,
    appName: flags['app-name'] ?? app?.name ?? clean,
    app,
  };
}

function suggestAppRoot(domain, apps) {
  const base = domain.split('.')[0].replace(/[^a-z0-9]/gi, '') || 'app';
  let candidate = `${base}next`;
  let n = 2;
  while (apps.some((a) => remote.rel(a.path) === candidate)) {
    candidate = `${base}next${n}`;
    n += 1;
  }
  return candidate;
}

function ownerLabel(ownership) {
  if (!ownership) return '';
  if (ownership.state === 'new') return color.dim(t('deploy.ownerNew'));
  if (ownership.state === 'owned') return color.green(t('deploy.ownerSelf'));
  if (ownership.state === 'other-domain') {
    return color.red(t('deploy.ownerOtherDomain', { domain: ownership.app?.domain ?? '?' }));
  }
  return color.yellow(t('deploy.ownerForeign'));
}

function printSummary(ctx, { plan, destructive, url, startupCreated }) {
  const { cfg, project, target, appRoot, apps, probeResult, dirExists, flags } = ctx;

  const others = apps.filter((a) => remote.rel(a.path) !== appRoot);
  const lines = alignPairs([
    [t('deploy.sLocalProject'), ctx.cwd],
    [t('deploy.sFramework'), `Next.js ${project.nextVersion ?? ''} · ${project.router ?? '?'} router`],
    [
      t('deploy.sStartup'),
      `${project.startupFile}${startupCreated ? color.yellow(t('deploy.sStartupCreated')) : ''}`,
    ],
    null,
    [t('deploy.sServer'), `${cfg.host}:${cfg.port} · ${regimeLabel(probeResult.regime)}`],
    [t('deploy.sAccount'), cfg.user],
    [
      t('deploy.sDomain'),
      `${target.domain}${target.kind === 'new-subdomain' ? color.yellow(t('deploy.sNewSubdomain')) : ''}`,
    ],
    [t('deploy.sDocroot'), target.docroot ?? t('deploy.sDocrootAuto')],
    [t('deploy.sApp'), `~/${appRoot}${dirExists ? '' : color.yellow(t('deploy.sNew'))}`],
    [t('deploy.sOwner'), ownerLabel(ctx.ownership)],
    null,
    [
      t('deploy.sPackage'),
      t('deploy.sPackageValue', { files: plan.included.length, size: bytes(plan.bytes) }),
    ],
    [t('deploy.sUrl'), color.cyan(url)],
  ]);

  if (plan.skippedEnv.length) {
    lines.push('', color.yellow(t('deploy.sEnvExcluded', { list: plan.skippedEnv.join(', ') })));
  }

  if (others.length) {
    lines.push(
      '',
      color.dim(t('deploy.sOthers')),
      ...others.map((a) => `  ${a.name} · ${a.domain ?? '-'} · ~/${a.path}`)
    );
  }

  note(
    lines.join('\n'),
    destructive ? color.yellow(t('deploy.summaryTitleDestructive')) : t('deploy.summaryTitle')
  );

  if (flags.verbose) {
    const top = [...plan.excluded.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 8)
      .map(
        ([pattern, v]) =>
          `  ${pattern}  ${color.dim(t('deploy.excludedItem', { count: v.count, size: bytes(v.bytes) }))}`
      );
    if (top.length) note(top.join('\n'), t('deploy.excludedTitle'));
  }
}

/**
 * Etiket/değer çiftlerini en uzun etikete göre hizalar.
 *
 * Sabit boşlukla hizalamak yalnızca tek dilde işe yarar: "Belge kökü" ile
 * "Document root" aynı uzunlukta değil ve ekran İngilizcede dağılıyordu.
 */
function alignPairs(rows) {
  const width = Math.max(...rows.filter(Boolean).map(([label]) => label.length));
  return rows.map((row) => {
    if (!row) return '';
    const [label, value] = row;
    return `${color.dim(label)}${' '.repeat(width - label.length + 2)}${value}`;
  });
}

function printDryRunSteps(ctx) {
  const { target, appRoot, choice, driver } = ctx;
  const steps = [];

  if (target.kind === 'new-subdomain') {
    steps.push(
      `SubDomain::addsubdomain  domain=${target.subLabel} rootdomain=${target.rootDomain} dir=${target.docroot}`
    );
  }
  if (!ctx.flags['no-build']) steps.push(t('deploy.stepBuild'));
  steps.push(t('deploy.stepZip'));
  if (ctx.dirExists) {
    steps.push(t('deploy.stepBackup', { appRoot, dir: REMOTE.backupDir }));
    steps.push(t('deploy.stepClean', { appRoot }));
  }
  steps.push(t('deploy.stepExtract', { appRoot }));
  steps.push(t('deploy.stepMarker', { file: REMOTE.ownerFile }));
  if (choice.mode === 'create') {
    steps.push(
      driver.id === 'passenger'
        ? `PassengerApps::register_application  name=${ctx.appName} path=${appRoot} domain=${target.domain} base_uri=/`
        : `cloudlinux-selector create  --app-root ${appRoot} --domain ${target.domain} --startup-file ${ctx.project.startupFile}`
    );
  }
  steps.push(
    driver.id === 'passenger'
      ? `PassengerApps::ensure_deps  type=npm  app_path=~/${appRoot}`
      : `cloudlinux-selector install-modules  --app-root ${appRoot}`
  );
  steps.push(t('deploy.stepRestart'));

  note(steps.map((s, i) => `${String(i + 1).padStart(2)}. ${s}`).join('\n'), t('deploy.stepsTitle'));
}
