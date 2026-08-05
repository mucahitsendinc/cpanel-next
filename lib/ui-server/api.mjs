import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { publicProfile } from './state.mjs';
import { detectProject, SERVER_TEMPLATE } from '../detect.mjs';
import { listDomains, resolveDomain, TYPE_LABEL } from '../domain.mjs';
import { planZip, DEFAULT_EXCLUDES } from '../packager.mjs';
import { assertAppRoot, assertOwnership, readOwnerMarker } from '../guards.mjs';
import { runDeploy } from '../deploy-core.mjs';
import * as remote from '../remote.mjs';
import { REMOTE, HOME_DIR, ensureHomeDir } from '../paths.mjs';
import { regimeLabel } from '../context.mjs';
import { setLocale, t } from '../i18n/index.mjs';
import { UserError } from '../ui.mjs';

const RECENT_FILE = path.join(HOME_DIR, 'recent.json');

export async function handleApi(req, res, url, state) {
  const route = url.pathname.replace(/^\/api\//, '');
  const method = req.method;

  const json = (status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  try {
    /* ---- oturum ------------------------------------------------------- */
    if (route === 'status' && method === 'GET') {
      return json(200, {
        locked: state.locked,
        lang: state.lang,
        profiles: state.locked ? [] : [...state.unlocked.values()].map(publicProfile),
        jobs: [...state.jobs.values()].map(summarizeJob),
      });
    }

    if (route === 'unlock' && method === 'POST') {
      const body = await readJson(req);
      const profiles = state.unlock(String(body.master ?? ''));
      return json(200, { locked: false, profiles });
    }

    if (route === 'lock' && method === 'POST') {
      state.lock();
      return json(200, { locked: true });
    }

    if (route === 'lang' && method === 'POST') {
      const body = await readJson(req);
      state.lang = setLocale(body.lang);
      return json(200, { lang: state.lang });
    }

    /* ---- hesap genel görünümü ------------------------------------------ */
    if (route.startsWith('overview/') && method === 'GET') {
      const name = decodeURIComponent(route.slice('overview/'.length));
      const ctx = await state.session(name, { refresh: url.searchParams.get('refresh') === '1' });
      const domains = await listDomains(ctx.client);
      const apps = ctx.driver ? await ctx.driver.listApps(ctx) : [];

      const enriched = [];
      for (const app of apps) {
        const marker = await readOwnerMarker(ctx.client, app.path).catch(() => null);
        enriched.push({
          ...app,
          owned: marker?.tool === 'cpanel-next',
          ownerProject: marker?.project ?? null,
        });
      }

      return json(200, {
        profile: publicProfile(state.unlocked.get(name)),
        regime: ctx.probeResult.regime,
        regimeLabel: regimeLabel(ctx.probeResult.regime),
        maxApps: ctx.probeResult.maxApps,
        driver: ctx.driver?.id ?? null,
        domains: domains.map((d) => ({ ...d, typeLabel: TYPE_LABEL[d.type] ?? d.type })),
        apps: enriched,
      });
    }

    /* ---- yerel dosya sistemi ------------------------------------------- */
    if (route === 'browse' && method === 'GET') {
      const target = url.searchParams.get('path') || os.homedir();
      return json(200, browse(target));
    }

    if (route === 'recent' && method === 'GET') {
      return json(200, { items: readRecent() });
    }

    if (route === 'project' && method === 'GET') {
      const dir = url.searchParams.get('path');
      if (!dir) throw new UserError('path required');
      const project = detectProject(dir);
      let plan = null;
      if (project.deployable) {
        const p = planZip(dir, { excludes: DEFAULT_EXCLUDES, allowEnv: [] });
        plan = {
          files: p.included.length,
          bytes: p.bytes,
          skippedEnv: p.skippedEnv,
          excluded: [...p.excluded.entries()]
            .sort((a, b) => b[1].bytes - a[1].bytes)
            .slice(0, 10)
            .map(([pattern, v]) => ({ pattern, count: v.count, bytes: v.bytes })),
        };
      }
      return json(200, { project, plan, hasStartup: project.hasServerJs });
    }

    /* ---- deploy hazırlığı ---------------------------------------------- */
    if (route === 'preflight' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const domains = await listDomains(ctx.client);
      const target = await resolveDomain(ctx.client, body.domain, domains);

      if (target.kind === 'not-found') throw new UserError(t('status.notFound', { domain: body.domain }));
      if (target.kind === 'parked') throw new UserError(target.reason);

      const appRoot = assertAppRoot(body.appRoot, {
        docroots: domains.map((d) => d.docroot).filter(Boolean),
      });
      const dirExists = await remote.exists(ctx.client, appRoot);
      const apps = ctx.driver ? await ctx.driver.listApps(ctx) : [];
      const existingApp = apps.find((a) => remote.rel(a.path) === appRoot) ?? null;

      let ownership = { owned: true, reason: 'new' };
      if (dirExists) {
        ownership = await assertOwnership(ctx.client, appRoot, {
          adopt: Boolean(body.adopt),
          dirExists,
        }).catch((err) => ({ owned: false, error: err.message, hint: err.hint }));
      }

      return json(200, {
        target: {
          kind: target.kind,
          domain: target.domain,
          docroot: target.docroot ?? null,
          rootDomain: target.rootDomain ?? null,
          subLabel: target.subLabel ?? null,
        },
        appRoot,
        dirExists,
        destructive: dirExists,
        existingApp,
        ownership,
        otherApps: apps.filter((a) => remote.rel(a.path) !== appRoot),
      });
    }

    /* ---- deploy --------------------------------------------------------- */
    if (route === 'deploy' && method === 'POST') {
      const body = await readJson(req);
      const job = await startDeploy(state, body);
      return json(202, { jobId: job.id });
    }

    /* ---- uygulama denetimi --------------------------------------------- */
    if (route === 'app-action' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const apps = await ctx.driver.listApps(ctx);
      const app = apps.find((a) => remote.rel(a.path) === remote.rel(body.appRoot));
      if (!app) throw new UserError('app not found');

      // Silme YOK. Faz 1'de uygulama kaldırma özelliği bilerek bulunmuyor;
      // tek tıkla geri alınamaz bir işlem sunmuyoruz.
      if (body.action === 'start') await ctx.driver.start(ctx, app);
      else if (body.action === 'stop') await ctx.driver.stop(ctx, app);
      else if (body.action === 'restart')
        await ctx.driver.restart(ctx, app, { url: app.domain ? `https://${app.domain}` : null });
      else throw new UserError(`unknown action: ${body.action}`);

      return json(200, { ok: true });
    }

    /* ---- yedekler / geri alma ------------------------------------------- */
    if (route === 'backups' && method === 'GET') {
      const ctx = await state.session(url.searchParams.get('profile'));
      const entries = await remote.list(ctx.client, REMOTE.backupDir).catch(() => []);
      const items = entries
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
      return json(200, { items });
    }

    if (route === 'rollback' && method === 'POST') {
      const body = await readJson(req);
      const job = await startRollback(state, body);
      return json(202, { jobId: job.id });
    }

    /* ---- kayıtlar -------------------------------------------------------- */
    if (route === 'logs' && method === 'GET') {
      const ctx = await state.session(url.searchParams.get('profile'));
      const appRoot = url.searchParams.get('appRoot');
      const runFiles = (await remote.list(ctx.client, REMOTE.runDir).catch(() => []))
        .filter((e) => e.type === 'file' && /^status_.*\.json$/.test(String(e.name)))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5);

      const runs = [];
      for (const f of runFiles) {
        const s = await remote.readJson(ctx.client, REMOTE.runDir, f.name).catch(() => null);
        if (s) runs.push({ file: f.name, ...s });
      }

      let history = null;
      let marker = null;
      if (appRoot) {
        history = await remote.readJson(ctx.client, appRoot, REMOTE.historyFile).catch(() => null);
        marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
      }
      return json(200, { runs, history, marker });
    }

    /* ---- işler ----------------------------------------------------------- */
    if (route.startsWith('jobs/') && route.endsWith('/events') && method === 'GET') {
      const id = route.slice('jobs/'.length, -'/events'.length);
      return streamJob(res, state, id);
    }

    if (route.startsWith('jobs/') && method === 'GET') {
      const job = state.jobs.get(route.slice('jobs/'.length));
      if (!job) return json(404, { error: 'job not found' });
      return json(200, summarizeJob(job));
    }

    return json(404, { error: 'not found' });
  } catch (err) {
    const status = err instanceof UserError ? 400 : 500;
    return json(status, { error: err.message, hint: err.hint ?? null });
  }
}

/* ------------------------------------------------------------------ deploy */

async function startDeploy(state, body) {
  const ctx = await state.session(body.profile);
  const cwd = body.projectPath;
  if (!cwd || !fs.existsSync(cwd)) throw new UserError('project path not found');

  const project = detectProject(cwd);
  if (!project.deployable) throw new UserError(project.blockers.join(' · '));

  const domains = await listDomains(ctx.client);
  const target = await resolveDomain(ctx.client, body.domain, domains);
  if (target.kind === 'not-found' || target.kind === 'parked') {
    throw new UserError(t('status.notFound', { domain: body.domain }));
  }

  const appRoot = assertAppRoot(body.appRoot, {
    docroots: domains.map((d) => d.docroot).filter(Boolean),
  });
  const dirExists = await remote.exists(ctx.client, appRoot);

  /*
   * YAZARAK ONAY — sunucu tarafında zorunlu.
   *
   * Arayüzde bir onay kutusu göstermek yetmez: bu uç doğrudan da çağrılabilir.
   * Yıkıcı işlem için klasör adının BİREBİR gönderilmesi gerekiyor, yani hedef
   * kazara seçilmiş olamaz.
   */
  if (dirExists && body.confirm !== appRoot) {
    throw new UserError(
      t('deploy.confirmMismatch', { given: body.confirm ?? '', appRoot }),
      t('deploy.confirmMismatchHint')
    );
  }

  if (dirExists) {
    await assertOwnership(ctx.client, appRoot, { adopt: Boolean(body.adopt), dirExists });
  }

  // Başlangıç dosyası yoksa kullanıcının projesine yaz — CLI ile aynı davranış.
  const startupPath = path.join(cwd, project.startupFile);
  if (!fs.existsSync(startupPath)) fs.writeFileSync(startupPath, SERVER_TEMPLATE);

  const apps = ctx.driver ? await ctx.driver.listApps(ctx) : [];
  const existingApp = apps.find((a) => remote.rel(a.path) === appRoot) ?? null;
  const plan = planZip(cwd, { excludes: DEFAULT_EXCLUDES, allowEnv: [] });

  const job = state.createJob('deploy', {
    profile: body.profile,
    domain: target.domain,
    appRoot,
    projectPath: cwd,
  });

  // Bilerek await ETMİYORUZ: iş sunucuda yaşar, sekme kapansa da sürer.
  runDeploy(
    ctx,
    {
      cwd,
      project,
      target,
      appRoot,
      appName: body.appName || appRoot,
      existingApp,
      dirExists,
      excludes: DEFAULT_EXCLUDES,
      preserve: ['.env.local', '.env.production.local'],
      noBuild: Boolean(body.noBuild),
      transport: body.transport ?? null,
      nodeVersion: body.nodeVersion ?? null,
      cleanModules: Boolean(body.cleanModules),
      includedFiles: plan.included,
    },
    (e) => state.pushEvent(job, e)
  )
    .then((result) => {
      rememberProject(cwd, { profile: body.profile, domain: target.domain, appRoot });
      state.finishJob(job, { result: { url: result.url, backupPath: result.backupPath } });
    })
    .catch((err) => state.finishJob(job, { error: err }));

  return job;
}

async function startRollback(state, body) {
  const ctx = await state.session(body.profile);
  const appRoot = remote.rel(body.appRoot);

  if (body.confirm !== appRoot) {
    throw new UserError(
      t('deploy.confirmMismatch', { given: body.confirm ?? '', appRoot }),
      t('deploy.confirmMismatchHint')
    );
  }

  const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
  if (marker?.tool !== 'cpanel-next' && !body.adopt) {
    throw new UserError(t('rollback.notOwned', { appRoot }), t('rollback.notOwnedHint'));
  }

  const job = state.createJob('rollback', { profile: body.profile, appRoot, backup: body.backup });

  (async () => {
    const emit = (key, params = {}) =>
      state.pushEvent(job, { type: 'step', key, params, text: t(key, params) });

    const apps = ctx.driver ? await ctx.driver.listApps(ctx) : [];
    const app = apps.find((a) => remote.rel(a.path) === appRoot) ?? { name: appRoot, path: appRoot };

    if (ctx.driver?.stop) {
      emit('rollback.stopping');
      await ctx.driver.stop(ctx, app).catch(() => {});
    }

    emit('rollback.cleaning');
    const cleaned = await remote.cleanDir(ctx.client, appRoot, { keep: [] });
    if (cleaned.failed.length) {
      throw new UserError(t('rollback.cleanFailed', { files: cleaned.failed.slice(0, 5).join(', ') }));
    }

    emit('rollback.restoring');
    await remote.copy(ctx.client, `${REMOTE.backupDir}/${body.backup}`, appRoot);
    if (!(await remote.exists(ctx.client, `${appRoot}/package.json`))) {
      throw new UserError(t('rollback.missingPackageJson'));
    }

    if (ctx.driver?.applyAll) {
      emit('rollback.installingCron');
      await ctx.driver.applyAll(ctx, {
        appRoot,
        domain: app.domain,
        startupFile: app.startupFile ?? 'server.js',
        isNew: false,
        existingAppRoot: app.path,
        onProgress: (step, pct) => state.pushEvent(job, { type: 'remote', text: step, pct }),
      });
    } else {
      emit('rollback.installing');
      await ctx.driver.installDeps(ctx, app, {
        onProgress: (l) => state.pushEvent(job, { type: 'remote', text: String(l) }),
      });
      emit('rollback.starting');
      await ctx.driver.start(ctx, app).catch(() => {});
    }
    await ctx.driver.restart(ctx, app, { url: app.domain ? `https://${app.domain}` : null });
    return { appRoot };
  })()
    .then((result) => state.finishJob(job, { result }))
    .catch((err) => state.finishJob(job, { error: err }));

  return job;
}

/* -------------------------------------------------------------------- SSE */

function streamJob(res, state, id) {
  const job = state.jobs.get(id);
  if (!job) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'job not found' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  // Geçmişi baştan gönder: sekme sonradan açılsa da tam kayıt görünsün.
  for (const e of job.events) send(e);
  if (job.status !== 'running') {
    send({ type: job.status, result: job.result, error: job.error });
    res.end();
    return;
  }

  job.listeners.add(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);

  const cleanup = () => {
    clearInterval(keepAlive);
    job.listeners.delete(send);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

function summarizeJob(job) {
  return {
    id: job.id,
    type: job.type,
    meta: job.meta,
    status: job.status,
    error: job.error,
    result: job.result,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    lastEvent: job.events[job.events.length - 1] ?? null,
  };
}

/* --------------------------------------------------------- yerel yardımcılar */

/**
 * Dizin gezgini.
 *
 * Yalnızca DİZİNLERİ listeler ve dosya içeriğine hiç bakmaz. Kullanıcı kendi
 * makinesinde gezindiği için kısıtlama koymuyoruz, ama okuma da yapmıyoruz.
 */
function browse(target) {
  const dir = path.resolve(target);
  const entries = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      entries.push({
        name: e.name,
        path: full,
        isProject: fs.existsSync(path.join(full, 'package.json')),
      });
    }
  } catch (err) {
    throw new UserError(`cannot read directory: ${err.message}`);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), entries };
}

function readRecent() {
  try {
    return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function rememberProject(dir, meta) {
  try {
    ensureHomeDir();
    const items = readRecent().filter((i) => i.path !== dir);
    items.unshift({ path: dir, name: path.basename(dir), ...meta, at: new Date().toISOString() });
    fs.writeFileSync(RECENT_FILE, `${JSON.stringify(items.slice(0, 20), null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* önemsiz */
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Yerel arayüzden gelen gövdeler küçük; büyük gövde bir hata işaretidir.
      if (size > 1_000_000) {
        req.destroy();
        reject(new UserError('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(new UserError(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}
