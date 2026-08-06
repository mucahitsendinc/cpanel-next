import path from 'node:path';
import { saveProjectConfig } from '../config.mjs';
import { listDomains, resolveDomain, TYPE_LABEL } from '../domain.mjs';
import * as remote from '../remote.mjs';
import * as mysql from '../mysql.mjs';
import { readOwnerMarker } from '../guards.mjs';
import { runLaravelDeploy } from '../laravel-core.mjs';
import { normalizeSettings, MIGRATE_MODES, VENDOR_MODES } from '../laravel.mjs';
import { cancelJob } from '../shell/worker.mjs';
import { t } from '../i18n/index.mjs';
import {
  outro, note, select, text, confirm, spinner, log, color, bytes, typeToConfirm, UserError,
} from '../ui.mjs';

/**
 * Laravel yayınlama — etkileşimli akış.
 *
 * `deploy.mjs` projeyi tanıyıp buraya devrediyor. Ayrı bir dosya olması
 * bilinçli: Laravel'in soruları (veritabanı, migration kipi) Next.js'te hiç
 * yok, Next.js'inkiler (başlangıç dosyası, Node sürümü) burada hiç yok.
 * İkisini tek fonksiyonda birleştirmek, her ikisini de okunmaz yapardı.
 */
export async function deployLaravel(ctx) {
  const { flags, cwd, cfg, project } = ctx;

  log.step(
    t('laravel.projectLine', {
      version: color.bold(`Laravel ${project.laravelVersion ?? ''}`),
      name: path.basename(cwd),
    })
  );

  /* -- 1. Domain --------------------------------------------------------- */
  const domains = await listDomains(ctx.client);
  if (!domains.length) throw new UserError(t('deploy.noDomains', { user: cfg.user, host: cfg.host }));

  const target = await chooseDomain(ctx, domains);
  if (!target.docroot) throw new UserError(t('laravel.noDocroot', { domain: target.domain }));

  /*
   * UYGULAMA KLASÖRÜ SORULMUYOR.
   *
   * Belge kökünü değiştirmiyoruz, dolayısıyla Laravel domainin kendi
   * klasörüne kuruluyor. Sorulacak bir şey yok — ve sorulmaması, yanlış
   * klasöre kurma ihtimalini tamamen ortadan kaldırıyor.
   */
  const appRoot = remote.rel(target.docroot);

  /* -- 2. İlk kurulum mu? ------------------------------------------------- */
  const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
  const first = marker?.framework !== 'laravel';

  const entries = await remote.list(ctx.client, appRoot).catch(() => []);
  const contents = entries.filter((e) => !['.', '..'].includes(e.name));

  const settings = normalizeSettings(
    { ...(cfg.project?.laravel ?? {}), ...flagOverrides(flags) },
    { first }
  );
  for (const w of settings.warnings) log.warn(t('laravel.settingInvalid', { detail: w }));

  /* -- 3. Veritabanı ------------------------------------------------------ */
  const db = first && !flags.yes ? await chooseDatabase(ctx) : null;

  /* -- 4. Özet ve onay ---------------------------------------------------- */
  printSummary(ctx, { target, appRoot, first, settings, db, contents });

  if (flags['dry-run']) {
    outro(color.yellow(t('deploy.dryRunDone')));
    return;
  }

  /*
   * Dolu klasör uyarısı.
   *
   * Belge kökü zaten bir siteyi barındırıyor olabilir — WordPress, düz HTML,
   * başka bir Laravel. Kod dizinleri silineceği için bunu görmeden geçmek
   * yayındaki bir siteyi götürmek demek.
   */
  if (contents.length) {
    log.warn(t('laravel.folderNotEmpty', { count: contents.length, appRoot }));
    log.info(color.dim(contents.slice(0, 12).map((e) => e.name).join('  ')));
    if (flags.confirm !== undefined) {
      if (flags.confirm !== appRoot) {
        throw new UserError(
          t('deploy.confirmMismatch', { given: flags.confirm, appRoot }),
          t('deploy.confirmMismatchHint')
        );
      }
    } else if (!(await typeToConfirm(appRoot))) {
      throw new UserError(t('common.notConfirmed'));
    }
  } else if (!flags.yes) {
    if (!(await confirm({ message: t('deploy.askPublish', { url: `https://${target.domain}` }) }))) {
      throw new UserError(t('common.cancelled'));
    }
  }

  /* -- 5. Yürüt ----------------------------------------------------------- */
  const s = spinner();
  s.start(t('deploy.applying'));
  const notices = [];
  let jobId = null;
  const onSigint = () => {
    if (!jobId) return;
    s.message(t('worker.cancelling'));
    cancelJob(ctx, jobId).catch(() => {});
  };
  process.on('SIGINT', onSigint);

  let result;
  try {
    result = await runLaravelDeploy(
      ctx,
      { cwd, project, target, settings, db, first, transport: flags.transport },
      (e) => {
        if (e.type === 'job') jobId = e.jobId;
        else if (e.type === 'progress') {
          s.message(t('deploy.uploadingProgress', { sent: bytes(e.sent), total: bytes(e.total) }));
        } else if (e.type === 'remote') s.message(`${e.text}${e.pct ? ` (${e.pct}%)` : ''}`);
        else if (e.type === 'step') {
          s.message(e.key === 'deploy.packed'
            ? t('deploy.packed', { files: e.params.files, size: bytes(e.params.size) })
            : e.text);
        } else if (e.type === 'info' || e.type === 'warn') {
          notices.push({ level: e.type, text: e.text });
        }
      }
    );
    s.stop(t('deploy.published'));
  } catch (err) {
    s.stop(err?.cancelled ? t('worker.cancelled', { label: t('laravel.title') }) : t('deploy.remoteFailed'), 1);
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
  }

  for (const n of notices) (n.level === 'warn' ? log.warn : log.info)(n.text);

  /*
   * AÇIKTA MI? — bu satır, yayının başarılı sayılıp sayılmayacağını belirler.
   *
   * Kaynak kod belge kökünün altında. Yönlendirme çalışmıyorsa `.env`
   * internete açık demektir ve bunu "uyarı" olarak geçiştirmek doğru olmaz.
   */
  if (result.exposure.exposed.length) {
    log.error(t('laravel.exposedTitle'));
    note(
      [
        t('laravel.exposedBody', { list: result.exposure.exposed.join(', ') }),
        '',
        t('laravel.exposedFix'),
      ].join('\n'),
      color.red(t('laravel.exposedTitle'))
    );
  }

  saveProjectConfig(cwd, {
    host: cfg.host,
    user: cfg.user,
    domain: target.domain,
    appRoot,
    framework: 'laravel',
    laravel: {
      migrate: settings.migrate === 'fresh-seed' ? 'migrate' : settings.migrate,
      firstMigrate: 'fresh-seed',
      vendor: settings.vendor,
      forceDebugOff: settings.forceDebugOff,
      optimize: settings.optimize,
    },
  });

  note(
    [
      `${color.dim(t('deploy.labelUrl'))}      ${color.cyan(result.url)}`,
      `${color.dim(t('deploy.labelAccount'))}      ${cfg.user}@${cfg.host}`,
      `${color.dim(t('deploy.labelFolder'))}     ~/${appRoot}`,
      result.backupPath ? `${color.dim(t('deploy.labelBackup'))}      ~/${result.backupPath}` : null,
    ].filter(Boolean).join('\n'),
    t('deploy.doneTitle')
  );

  outro(color.green(t('deploy.live')));
}

/**
 * `deploymanager update` — Laravel dalı.
 *
 * Hiçbir şey sormuyor: hedef `.cpanel-next.json` içinde kayıtlı. Veritabanı
 * seçimi de yok — `.env` zaten sunucuda ve ona dokunulmuyor (APP_DEBUG
 * dışında). Kullanıcının istediği tam olarak buydu: "sadece update olarak
 * çalışsın, vendor'ı silsin, dosyaları atsın, migrate'i çalıştırsın".
 */
export async function updateLaravel(ctx, { target, appRoot }) {
  const { flags, cwd, cfg, project } = ctx;

  const settings = normalizeSettings(
    { ...(cfg.project?.laravel ?? {}), ...flagOverrides(flags) },
    { first: false }
  );
  for (const w of settings.warnings) log.warn(t('laravel.settingInvalid', { detail: w }));

  const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
  if (marker?.framework && marker.framework !== 'laravel') {
    throw new UserError(t('update.otherProject', { project: marker.project ?? '?' }), t('update.notLinkedHint'));
  }

  note(
    [
      `${color.dim(t('deploy.sUrl'))}   ${color.cyan(`https://${target.domain}`)}`,
      `${color.dim(t('laravel.sRoot'))}   ~/${appRoot}`,
      `${color.dim(t('laravel.sMigrate'))}   ${migrateLabel(settings.migrate)}`,
      `${color.dim(t('laravel.sVendor'))}   ${t(`laravel.vendorMode.${settings.vendor}`)}`,
    ].join('\n'),
    t('update.title')
  );
  if (settings.migrate === 'fresh-seed') log.warn(t('laravel.freshWarning'));

  const s = spinner();
  s.start(t('deploy.applying'));
  const notices = [];
  let jobId = null;
  const onSigint = () => {
    if (!jobId) return;
    s.message(t('worker.cancelling'));
    cancelJob(ctx, jobId).catch(() => {});
  };
  process.on('SIGINT', onSigint);

  let result;
  try {
    result = await runLaravelDeploy(
      ctx,
      { cwd, project, target, settings, db: null, first: false, transport: flags.transport },
      (e) => {
        if (e.type === 'job') jobId = e.jobId;
        else if (e.type === 'progress') {
          s.message(t('deploy.uploadingProgress', { sent: bytes(e.sent), total: bytes(e.total) }));
        } else if (e.type === 'remote') s.message(`${e.text}${e.pct ? ` (${e.pct}%)` : ''}`);
        else if (e.type === 'step') s.message(e.text);
        else if (e.type === 'info' || e.type === 'warn') notices.push({ level: e.type, text: e.text });
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
  if (result.exposure.exposed.length) {
    log.error(t('laravel.exposedTitle'));
    log.error(t('laravel.exposedBody', { list: result.exposure.exposed.join(', ') }));
  }
  outro(`${color.green(t('deploy.live'))}  ${color.cyan(result.url)}`);
}

/* ------------------------------------------------------------- yardımcılar */

function flagOverrides(flags) {
  const out = {};
  if (flags.migrate) out.migrate = flags.migrate;
  if (flags.migrate) out.firstMigrate = flags.migrate;
  if (flags['no-migrate']) { out.migrate = 'none'; out.firstMigrate = 'none'; }
  if (flags.vendor) out.vendor = flags.vendor;
  if (flags['keep-debug']) out.forceDebugOff = false;
  // Yayın sonrası temizlik varsayılan açık; kapatmak için açık bayrak gerekiyor.
  if (flags['no-clean']) out.clean = false;
  return out;
}

async function chooseDomain(ctx, domains) {
  const preset = ctx.flags.domain ?? ctx.cfg.project?.domain;
  if (preset) {
    const resolved = await resolveDomain(ctx.client, preset, domains);
    if (resolved.kind === 'not-found') {
      throw new UserError(
        t('deploy.domainNotFound', { domain: preset }),
        t('deploy.domainNotFoundHint', { list: domains.map((d) => d.domain).join('\n  ') })
      );
    }
    if (resolved.kind === 'parked') throw new UserError(resolved.reason);
    return resolved;
  }

  const picked = await select({
    message: t('deploy.askDomain', { account: color.dim(`${ctx.cfg.user}@${ctx.cfg.host}`) }),
    options: domains
      .filter((d) => d.type !== 'parked')
      .map((d) => ({
        value: d.domain,
        label: d.domain,
        hint: `${TYPE_LABEL[d.type] ?? d.type}${d.docroot ? ` · ~/${d.docroot}` : ''}`,
      })),
  });
  return resolveDomain(ctx.client, picked, domains);
}

/**
 * Veritabanı seçimi — yalnızca ilk kurulumda.
 *
 * Üç yol var ve üçü de meşru: hesapta zaten bir veritabanı olabilir, yenisi
 * gerekebilir ya da kullanıcı `.env`'i kendi doldurmuş olabilir. Varsayılan
 * olarak hiçbirini seçmiyoruz.
 */
async function chooseDatabase(ctx) {
  const s = spinner();
  s.start(t('db.reading'));
  const data = await mysql.overview(ctx.client).catch(() => null);
  s.stop(data ? t('db.count', { count: data.databases.length }) : t('laravel.dbUnavailable'));
  if (!data) return null;

  const mode = await select({
    message: t('laravel.askDb'),
    options: [
      { value: 'new', label: t('laravel.dbNew'), hint: t('laravel.dbNewHint') },
      ...(data.databases.length
        ? [{ value: 'existing', label: t('laravel.dbExisting'), hint: t('laravel.dbExistingHint') }]
        : []),
      { value: 'skip', label: t('laravel.dbSkip'), hint: t('laravel.dbSkipHint') },
    ],
  });

  if (mode === 'skip') return null;

  if (mode === 'new') {
    const name = await text({
      message: t('db.namePrompt'),
      validate: (v) => (String(v || '').trim() ? undefined : t('db.nameRequired')),
    });
    const s2 = spinner();
    s2.start(t('db.creating'));
    const r = await mysql.provision(ctx.client, { name: String(name).trim() });
    s2.stop(t('db.created', { database: r.database }));
    if (r.password) log.warn(t('db.passwordOnce'));
    return r;
  }

  const database = await select({
    message: t('laravel.pickDb'),
    options: data.databases.map((d) => ({
      value: d.name,
      label: d.name,
      hint: `${bytes(d.size)}${d.users.length ? ` · ${d.users.join(', ')}` : ''}`,
    })),
  });

  /*
   * Var olan bir veritabanının kullanıcı ŞİFRESİ BİZDE YOK — cPanel de
   * göstermiyor. İki dürüst seçenek var: kullanıcı şifreyi kendi yazar ya da
   * biz bu veritabanı için yeni bir kullanıcı açarız. Uydurmak yok.
   */
  const chosen = data.databases.find((d) => d.name === database);
  const userMode = await select({
    message: t('laravel.askDbUser'),
    options: [
      { value: 'new', label: t('laravel.dbUserNew'), hint: t('laravel.dbUserNewHint') },
      ...(chosen.users.length
        ? [{ value: 'existing', label: t('laravel.dbUserExisting'), hint: chosen.users.join(', ') }]
        : []),
    ],
  });

  if (userMode === 'new') {
    const s3 = spinner();
    s3.start(t('db.creating'));
    const r = await mysql.provision(ctx.client, { name: database, user: `${database}_app` });
    s3.stop(t('db.created', { database: r.database }));
    if (r.password) log.warn(t('db.passwordOnce'));
    return r;
  }

  const user = chosen.users.length === 1
    ? chosen.users[0]
    : await select({
        message: t('laravel.pickDbUser'),
        options: chosen.users.map((u) => ({ value: u, label: u })),
      });
  const password = await text({ message: t('laravel.dbPasswordPrompt') });
  const server = await mysql.getServerInfo(ctx.client);
  return {
    database,
    user,
    password: String(password || '') || null,
    host: server.host,
    port: server.port,
  };
}

function printSummary(ctx, { target, appRoot, first, settings, db, contents }) {
  const { cfg, project, cwd } = ctx;
  const rows = [
    [t('deploy.sLocalProject'), cwd],
    [t('deploy.sFramework'), `Laravel ${project.laravelVersion ?? ''}`],
    null,
    [t('deploy.sServer'), `${cfg.host}:${cfg.port}`],
    [t('deploy.sAccount'), cfg.user],
    [t('deploy.sDomain'), target.domain],
    [t('laravel.sRoot'), `~/${appRoot}${contents.length ? color.yellow(t('laravel.sNotEmpty', { count: contents.length })) : ''}`],
    [t('laravel.sPublic'), `~/${appRoot}/public  ${color.dim(t('laravel.sViaHtaccess'))}`],
    null,
    [t('laravel.sMode'), first ? color.yellow(t('laravel.sFirst')) : t('laravel.sUpdate')],
    [t('laravel.sMigrate'), migrateLabel(settings.migrate)],
    [t('laravel.sVendor'), t(`laravel.vendorMode.${settings.vendor}`)],
    [t('laravel.sDebug'), settings.forceDebugOff ? t('laravel.sDebugOff') : t('laravel.sDebugKeep')],
    [t('laravel.sClean'), settings.clean ? t('laravel.sCleanOn') : t('laravel.sCleanOff')],
    [t('laravel.sDb'), db ? `${db.database} · ${db.user}` : t('laravel.sDbUntouched')],
  ];

  const width = Math.max(...rows.filter(Boolean).map(([l]) => l.length));
  note(
    rows.map((r) => (r ? `${color.dim(r[0])}${' '.repeat(width - r[0].length + 2)}${r[1]}` : '')).join('\n'),
    t('deploy.summaryTitle')
  );

  if (settings.migrate === 'fresh-seed') log.warn(t('laravel.freshWarning'));
}

function migrateLabel(mode) {
  const label = t(`laravel.migrateMode.${mode}`);
  return mode === 'fresh-seed' ? color.red(label) : label;
}

export { MIGRATE_MODES, VENDOR_MODES };
