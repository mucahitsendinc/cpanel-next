import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { publicProfile } from './state.mjs';
import { detectProject, SERVER_TEMPLATE } from '../detect.mjs';
import { listDomains, resolveDomain, createSubdomain, deleteSubdomain, TYPE_LABEL } from '../domain.mjs';
import { planZip, DEFAULT_EXCLUDES } from '../packager.mjs';
import { assertAppRoot, inspectOwnership, readOwnerMarker } from '../guards.mjs';
import { runDeploy } from '../deploy-core.mjs';
import { openSession, provisionToken, persistProfile } from '../auth.mjs';
import { closeSession } from '../browser/session.mjs';
import { removeProfile, getPreferences, savePreference } from '../config.mjs';
import * as remote from '../remote.mjs';
import * as mysql from '../mysql.mjs';
import * as links from '../cpanel-links.mjs';
import * as email from '../email.mjs';
import * as ftp from '../ftp.mjs';
import { changePassword } from '../account.mjs';
import { dumpDatabase, archiveAndDownload } from '../dbbackup.mjs';
import { isInsideDownloads, revealInFileManager } from '../download.mjs';
import { parseEnv, upsertEnv, removeEnv, maskValue } from '../envfile.mjs';
import { REMOTE, HOME_DIR, ensureHomeDir } from '../paths.mjs';
import { regimeLabel } from '../context.mjs';
import { setLocale, t } from '../i18n/index.mjs';
import { VERSION } from '../version.mjs';
import { resolveExcludes } from '../deployignore.mjs';
import { runQuickUpdate } from '../quick-update.mjs';
import { collectLocal, transferPlan, safeLocalTarget } from '../transfer.mjs';
import { makeZipFromList } from '../packager.mjs';
import { upload, uploadSplit } from '../transport/index.mjs';
import { downloadFile } from '../download.mjs';
import { createHash } from 'node:crypto';
import { execViaWorker, shq } from '../shell/worker.mjs';
import { createSession, buildScript, parseResult, applyResult, prettyCwd } from '../shell/session.mjs';
import { normalizeHooks, HOOK_STAGES } from '../hooks.mjs';
import { UserError } from '../ui.mjs';

const RECENT_FILE = path.join(HOME_DIR, 'recent.json');

/*
 * Yazılabilecek ortam dosyaları — İZİN LİSTESİ.
 *
 * Serbest dosya adı almak, bu ucun keyfî dosya yazma aracına dönüşmesi
 * demekti (`file: "../../.ssh/authorized_keys"`). Ad temizlemek yerine
 * kısıtlıyoruz; aracın her yerinde aynı kural.
 */
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

/** Proje kökündeki .cpanel-next.json — kayıtlı domain/klasör bağlantısı. */
function projectLink(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, '.cpanel-next.json'), 'utf8'));
    return {
      domain: d.domain ?? null,
      appRoot: d.appRoot ?? null,
      appName: d.appName ?? null,
      hooks: d.hooks ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Proje kökündeki `.cpanel-next.json` içindeki Laravel ayarları.
 *
 * Tek tuşla güncellemede arayüz ayar göndermiyor — göndermemeli de: kullanıcı
 * "Güncelle"ye basarken migration kipini yeniden seçmek istemiyor, PROJEDE
 * yazılı olanın uygulanmasını bekliyor. Terminal tarafı da aynı dosyayı
 * okuyor; iki ön yüzün aynı kararı vermesi böyle sağlanıyor.
 */
function projectLaravel(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.cpanel-next.json'), 'utf8')).laravel ?? {};
  } catch {
    return {};
  }
}


/**
 * Projenin TAM hariç tutma listesi.
 *
 * ⚠ Doğrudan `DEFAULT_EXCLUDES` KULLANMAYIN.
 *
 * Bu yardımcı bir kusuru kapatmak için var: `.cpanel-next.json` içindeki
 * `exclude` alanını yalnızca terminal komutu okuyordu, web arayüzü ve
 * masaüstü uygulaması her çağrıda düz `DEFAULT_EXCLUDES` veriyordu. Yani
 * kullanıcı ayarı yazıyor, `deploymanager` ile çalışıyor, uygulamadan
 * yayınlayınca sessizce yok sayılıyordu. `.deployignore` de aynı yerden
 * besleniyor.
 */
function excludesFor(dir, base) {
  const cfg = projectConfigOf(dir);
  return resolveExcludes(dir, { base, projectExclude: cfg.exclude ?? null });
}

/** Proje kökündeki .cpanel-next.json — okunamıyorsa boş nesne. */
function projectConfigOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.cpanel-next.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Düzenlenebilir dosya üst sınırı.
 *
 * ⚠ 1 MB DEĞİL. `readJson` gövdeyi tam 1.000.000 baytta kesiyor; 1 MB'lık
 * bir dosya JSON kaçışlarıyla o sınırı aşar ve kaydetme sessizce
 * reddedilirdi. 512 KB, kaçışlar iki katına çıksa bile güvenli.
 */
const EDIT_MAX_BYTES = 512 * 1024;

const contentHash = (text) =>
  createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);

/**
 * YERELDEN SUNUCUYA.
 *
 * Yayın hattının aksine hedef dizin TEMİZLENMİYOR: burada amaç seçili
 * dosyaları eklemek, klasörü yeniden kurmak değil.
 */
async function sendToServer(ctx, { localDir, remoteDir, items }, emit) {
  const say = (type, key, params = {}) => emit({ type, key, params, text: t(key, params) });

  const collected = collectLocal(localDir, items);
  if (!collected.files.length) throw new UserError(t('fb.nothing'));
  for (const name of collected.skipped) say('warn', 'fb.skippedDir', { name });
  if (collected.symlinks.length) say('warn', 'fb.skippedLinks', { count: collected.symlinks.length });
  if (collected.truncated) say('warn', 'fb.truncated', { max: collected.files.length });

  say('step', 'deploy.packing');
  const pkg = await makeZipFromList(localDir, collected.files);
  ctx.cleanup?.push(async () => fs.rmSync(pkg.dir, { recursive: true, force: true }));

  const uploadDir = `${REMOTE.uploadDir}/fb${Date.now().toString(36)}`;
  say('step', 'deploy.uploading');
  try {
    await upload(ctx, {
      zipPath: pkg.zipPath,
      remoteDir: uploadDir,
      onProgress: ({ sent, total }) => emit({ type: 'progress', sent, total }),
    });
  } catch (err) {
    /*
     * Büyük gönderim: yayın hattındaki parçalama yolu burada da geçerli.
     * 40 MB'lık parçalar doğrudan hedefe açılıyor.
     */
    if (err?.code !== 'TOO_LARGE') throw err;
    say('warn', 'deploy.uploadTooLarge');
    await remote.mkdirp(ctx.client, remoteDir);
    await uploadSplit(ctx, {
      cwd: localDir,
      files: collected.files,
      remoteDir: uploadDir,
      targetDir: remoteDir,
      onProgress: ({ part, parts }) => emit({ type: 'remote', text: `${part}/${parts}` }),
    });
    await remote.remove(ctx.client, uploadDir, { required: false }).catch(() => {});
    say('done', 'fb.sent', { count: collected.files.length });
    return { count: collected.files.length };
  }

  say('step', 'deploy.extracting');
  await remote.mkdirp(ctx.client, remoteDir);
  await remote.extractZip(ctx.client, `${uploadDir}/pkg.zip`, remoteDir);
  await remote.remove(ctx.client, uploadDir, { required: false }).catch(() => {});

  say('done', 'fb.sent', { count: collected.files.length });
  return { count: collected.files.length };
}

/**
 * SUNUCUDAN YERELE.
 *
 * Hedef, ekranda açık olan yerel klasör. Dosya adı SUNUCUDAN geldiği için
 * `safeLocalTarget` ile sınırlanıyor — bkz. transfer.mjs.
 */
async function fetchFromServer(ctx, { localDir, remoteDir, items }, emit) {
  const say = (type, key, params = {}) => emit({ type, key, params, text: t(key, params) });

  const listing = await remote.list(ctx.client, remoteDir).catch(() => []);
  let done = 0;

  for (const raw of items) {
    const name = path.posix.basename(String(raw));
    const entry = listing.find((e) => e.name === name);
    if (!entry) { say('warn', 'fb.notFound', { name }); continue; }
    if (entry.type === 'dir') { say('warn', 'fb.dirDownload', { name }); continue; }

    const target = safeLocalTarget(localDir, name);
    if (!target) { say('warn', 'fb.unsafeName', { name }); continue; }

    say('step', 'fb.downloading', { name });
    await downloadFile(ctx, `${remoteDir}/${name}`, target, {
      onProgress: ({ sent, total }) => emit({ type: 'progress', sent, total }),
    });
    done += 1;
  }

  if (!done) throw new UserError(t('fb.nothing'));
  say('done', 'fb.fetched', { count: done, dir: localDir });
  return { count: done, dir: localDir };
}

/** Proje kökündeki .cpanel-next.json içindeki hook tanımları. */
function projectHooks(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, '.cpanel-next.json'), 'utf8');
    return JSON.parse(raw).hooks ?? {};
  } catch {
    return {};
  }
}

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
      /*
       * `hasProfiles` — ilk açılışın çıkmazını kapatan alan.
       *
       * Kasa her zaman KİLİTLİ başlıyor, hiç hesap eklenmemiş olsa bile.
       * Arayüz yalnızca `locked`'a baktığı için yeni kullanıcı "Kasayı aç"
       * ekranına düşüyor, şifre yazıyor ve `no profiles` hatası alıyordu:
       * geçilemeyen bir kapı. Açılacak bir kasa olup olmadığını arayüzün
       * bilmesi gerekiyor.
       */
      const { loadGlobalConfig } = await import('../config.mjs');
      const saved = Object.keys(loadGlobalConfig().profiles ?? {});

      return json(200, {
        // Sürüm her ekranda görünsün: bir hatayı bildirirken sorulan ilk soru.
        version: VERSION,
        locked: state.locked,
        hasProfiles: saved.length > 0,
        lang: state.lang,
        profiles: state.locked ? [] : [...state.unlocked.values()].map(publicProfile),
        jobs: [...state.jobs.values()].map(summarizeJob),
        initialProject: state.initialProject ?? null,
      });
    }

    if (route === 'unlock' && method === 'POST') {
      const body = await readJson(req);
      const profiles = state.unlock(String(body.master ?? ''));
      return json(200, { locked: false, profiles });
    }

    if (route === 'heartbeat' && method === 'POST') {
      state.beat();
      return json(200, { ok: true, jobs: state.hasRunningJobs() });
    }

    if (route === 'exit' && method === 'POST') {
      // "Terminale dön" düğmesi — beklemeden çıkmak için.
      state.exitRequested = true;
      return json(200, { ok: true, jobs: state.hasRunningJobs() });
    }

    /*
     * Projenin kendi terminal komutları — OKU ve YAZ.
     *
     * Kaynak `.cpanel-next.json`; yayınla güncellemenin AYNI dosyayı okuması
     * gerekiyor, yoksa "yayınlarken ayarladım ama güncellerken yok" durumu
     * doğuyor. Tek dosya olduğu için o sorun burada yapısal olarak yok.
     */
    if (route === 'hooks' && method === 'POST') {
      const body = await readJson(req);
      const dir = String(body.path ?? '');
      if (!dir || !fs.existsSync(dir)) throw new UserError(t('deploy.projectMissing', { dir }));

      // Yalnızca okumak isteniyorsa yazma yok.
      if (!body.hooks) {
        return json(200, { hooks: projectHooks(dir), stages: HOOK_STAGES });
      }

      /*
       * Doğrulama YAZMADAN ÖNCE: geçersiz bir tanımı dosyaya yazmak,
       * kullanıcının bir sonraki yayında sessizce yok sayılan bir komutla
       * karşılaşması demekti.
       */
      const { hooks, warnings } = normalizeHooks(body.hooks);

      const { loadProjectConfig, saveProjectConfig } = await import('../config.mjs');
      const current = loadProjectConfig(dir) ?? {};
      saveProjectConfig(dir, { ...current, hooks });

      return json(200, { hooks, warnings, stages: HOOK_STAGES });
    }

    /*
     * SUNUCUDA KOMUT ÇALIŞTIR.
     *
     * `cd` bir sonraki komuta taşınıyor: dizin `ctx.shell`de duruyor ve her
     * komuttan önce oraya giriliyor (bkz. shell/session.mjs). Kabuk durumunun
     * kendisi taşınmıyor — worker her işi ayrı bir `sh` ile koşuyor.
     */
    /*
     * HIZLI GÜNCELLEME — yalnızca değişen dosyalar.
     *
     * Reddedilebilir: sunucuda dosya kaydı yoksa ya da kilit dosyası
     * değiştiyse. İkisi de kullanıcıya sebebiyle birlikte söyleniyor;
     * sessizce tam yayına düşmek, "hızlı" dediği şeyin neden yüz megabayt
     * gönderdiğini anlamamasına yol açardı.
     */
    if (route === 'quick-update' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const cwd = String(body.projectPath ?? '');
      if (!cwd || !fs.existsSync(cwd)) throw new UserError(t('deploy.projectMissing', { dir: cwd }));

      const project = detectProject(cwd);
      const appRoot = remote.rel(String(body.appRoot ?? ''));
      if (!appRoot) throw new UserError(t('deploy.projectMissing', { dir: body.appRoot ?? '' }));

      const job = state.createJob('quick', {
        profile: body.profile, domain: body.domain, appRoot, projectPath: cwd,
      });

      runQuickUpdate(
        ctx,
        {
          cwd,
          project,
          appRoot,
          domain: body.domain,
          framework: project.framework === 'laravel' ? 'laravel' : 'next',
          build: body.noBuild !== true,
        },
        (e) => state.pushEvent(job, e)
      )
        .then((result) => state.finishJob(job, { result }))
        .catch((error) => state.finishJob(job, { error }));

      return json(202, { jobId: job.id });
    }

    /* --------------------------------------------------- dosya tarayıcısı */

    /** Sunucudaki dizin listesi. */
    if (route === 'remote-browse' && method === 'GET') {
      const ctx = await state.session(url.searchParams.get('profile'));
      const home = `/home/${ctx.client.user}`;
      const raw = url.searchParams.get('path') || home;
      const rel = remote.rel(raw);
      const entries = await remote.list(ctx.client, rel);
      const abs = rel ? `${home}/${rel}` : home;
      return json(200, {
        path: abs,
        home,
        parent: rel ? `${home}/${rel.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '') : null,
        entries: entries
          .filter((e) => e.name !== '.' && e.name !== '..')
          .map((e) => ({ name: e.name, type: e.type === 'dir' ? 'dir' : 'file', size: e.size, mtime: e.mtime }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)),
      });
    }

    /** Aktarım ÖZETİ — onay ekranı için, hiçbir şey göndermeden. */
    if (route === 'transfer-plan' && method === 'POST') {
      const body = await readJson(req);
      const dir = String(body.localDir ?? '');
      if (!fs.existsSync(dir)) throw new UserError(t('deploy.projectMissing', { dir }));
      return json(200, transferPlan(collectLocal(dir, body.items ?? [])));
    }

    /** Aktarım — iki yönlü. Onay çağıranın sorumluluğunda (ekranda soruluyor). */
    if (route === 'transfer' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const up = body.direction !== 'down';
      const localDir = String(body.localDir ?? '');
      const remoteDir = remote.rel(String(body.remoteDir ?? ''));
      if (!fs.existsSync(localDir)) throw new UserError(t('deploy.projectMissing', { dir: localDir }));

      const job = state.createJob(up ? 'upload' : 'download', {
        profile: body.profile, localDir, remoteDir, count: (body.items ?? []).length,
      });

      (up
        ? sendToServer(ctx, { localDir, remoteDir, items: body.items ?? [] }, (e) => state.pushEvent(job, e))
        : fetchFromServer(ctx, { localDir, remoteDir, items: body.items ?? [] }, (e) => state.pushEvent(job, e)))
        .then((result) => state.finishJob(job, { result }))
        .catch((error) => state.finishJob(job, { error }));

      return json(202, { jobId: job.id });
    }

    /**
     * Sunucuda silme — ÇİFT ONAYLI.
     *
     * `confirm`, silinecek tek öğenin adına birebir eşit olmalı. Silme geri
     * alınamıyor ve yanlış klasörü silmek siteyi bitirir; tek tıkla
     * yapılabilecek bir şey değil.
     */
    if (route === 'remote-delete' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const dir = remote.rel(String(body.remoteDir ?? ''));
      const items = (body.items ?? []).map((n) => path.posix.basename(String(n)));
      if (!items.length) throw new UserError(t('fb.nothing'));
      if (items.length > 1) throw new UserError(t('fb.oneAtATime'));
      if (String(body.confirm ?? '') !== items[0]) {
        throw new UserError(t('fb.confirmName', { name: items[0] }));
      }
      const r = await remote.removeMany(ctx.client, [`${dir}/${items[0]}`]);
      if (r.failed.length) throw new UserError(t('fb.deleteFailed', { list: r.failed.join(', ') }));
      return json(200, { removed: r.removed });
    }

    /** Uzak dosyayı OKU — düzenleyici için. */
    if (route === 'remote-file' && method === 'GET') {
      const ctx = await state.session(url.searchParams.get('profile'));
      const raw = remote.rel(url.searchParams.get('path') ?? '');
      const dir = path.posix.dirname(raw);
      const file = path.posix.basename(raw);

      const entry = (await remote.list(ctx.client, dir).catch(() => []))
        .find((e) => e.name === file);
      if (!entry) throw new UserError(t('fb.notFound', { name: file }));
      if (entry.size > EDIT_MAX_BYTES) {
        throw new UserError(t('fb.tooBigEdit', { max: Math.round(EDIT_MAX_BYTES / 1024) }));
      }

      const content = (await remote.readFile(ctx.client, dir, file)) ?? '';
      // İkili dosya düzenleyicide açılmıyor — kaydetmek onu bozardı.
      if (content.includes('\0')) throw new UserError(t('fb.binary'));
      return json(200, { content, hash: contentHash(content) });
    }

    /** Uzak dosyayı YAZ — kayıp güncelleme korumalı. */
    if (route === 'remote-file' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const raw = remote.rel(String(body.path ?? ''));
      const dir = path.posix.dirname(raw);
      const file = path.posix.basename(raw);
      const content = String(body.content ?? '');

      if (Buffer.byteLength(content, 'utf8') > EDIT_MAX_BYTES) {
        throw new UserError(t('fb.tooBigEdit', { max: Math.round(EDIT_MAX_BYTES / 1024) }));
      }

      /*
       * ⚠ KAYIP GÜNCELLEME KORUMASI.
       *
       * Dosya açıldıktan sonra başka bir yerden değişmiş olabilir: bir
       * deploy, cPanel Dosya Yöneticisi, başka bir sekme. Bunsuz bir
       * düzenleyici, kullanıcının canlı `.env`'ini sessizce geri alabilirdi.
       */
      if (body.expectedHash) {
        const current = (await remote.readFile(ctx.client, dir, file).catch(() => null)) ?? '';
        if (contentHash(current) !== body.expectedHash) throw new UserError(t('fb.changed'));
      }

      await remote.saveFile(ctx.client, dir, file, content);
      return json(200, { saved: true, hash: contentHash(content) });
    }

    if (route === 'shell' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const command = String(body.command ?? '').trim();
      if (!command) throw new UserError(t('shell.empty'));

      /*
       * TEK UÇUŞ. Worker işleri zaten seri koşuyor; paralel gönderilen
       * komutlar sunucuda kuyruğa girer ama her birinin yoklaması cPanel
       * API'sini ayrı ayrı döver. Rate limit olmadığı için sınır burada.
       */
      if (ctx.shellBusy) throw new UserError(t('shell.busy'));
      ctx.shellBusy = true;

      const job = state.createJob('shell', { profile: body.profile, command });

      (async () => {
        const script = buildScript(command, { cwd: ctx.shell.cwd, home: shq(ctx.shell.home) });
        const res = await execViaWorker(ctx, script, {
          label: 'shell',
          fast: true,
          /*
           * Kullanıcının komutu sıfırdan farklı dönebilir (`ls /yok`) ve bu
           * NORMAL — iş hatası değil. Gerçek çıkış kodu çıktıdaki
           * işaretlerden okunuyor.
           */
          tolerant: true,
          timeout: 5 * 60_000,
          onProgress: (step) => state.pushEvent(job, { type: 'remote', text: step }),
        });

        const parsed = parseResult(res.output);
        applyResult(ctx.shell, parsed);

        // Geçmiş: en fazla 10, yinelenenler tekilleştirilmiş, DİSKE YAZILMIYOR
        // (komut satırında şifre geçebilir).
        ctx.shell.history = [command, ...ctx.shell.history.filter((c) => c !== command)].slice(0, 10);

        if (parsed.output) state.pushEvent(job, { type: 'output', text: `${parsed.output}\n` });
        return {
          exitCode: parsed.exitCode,
          cwd: ctx.shell.cwd,
          prompt: prettyCwd(ctx.shell.cwd, ctx.shell.home),
          history: ctx.shell.history,
        };
      })()
        .then((result) => state.finishJob(job, { result }))
        .catch((error) => state.finishJob(job, { error }))
        .finally(() => { ctx.shellBusy = false; });

      return json(202, {
        jobId: job.id,
        prompt: prettyCwd(ctx.shell.cwd, ctx.shell.home),
      });
    }

    /** Terminal durumu — istem satırı ve geçmiş. */
    if (route === 'shell-state' && method === 'GET') {
      const ctx = await state.session(url.searchParams.get('profile'));
      return json(200, {
        prompt: prettyCwd(ctx.shell.cwd, ctx.shell.home),
        history: ctx.shell.history,
        busy: Boolean(ctx.shellBusy),
      });
    }

    /** Ev dizinine dön — kullanıcı nerede olduğunu kaybederse. */
    if (route === 'shell-reset' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      ctx.shell = createSession({ home: ctx.shell.home });
      return json(200, { prompt: prettyCwd(ctx.shell.cwd, ctx.shell.home) });
    }

    if (route === 'lock' && method === 'POST') {
      state.lock();
      return json(200, { locked: true });
    }

    if (route === 'lang' && method === 'POST') {
      const body = await readJson(req);
      state.lang = setLocale(body.lang);
      // KALICI: yalnızca belleğe yazmak, kullanıcının her açılışta dili
      // yeniden seçmesi demekti.
      savePreference('lang', state.lang);
      return json(200, { lang: state.lang });
    }

    /*
     * ANA ŞİFRE — cPanel'den bağımsız, ARACIN kendi şifresi.
     *
     * Değiştirmenin hiçbir yolu yoktu: kasa kuruluyordu, unutulursa
     * açılmıyordu, ama değiştirilemiyordu. Şifresini sızdırdığını düşünen
     * birinin tek çaresi bütün hesapları silip yeniden eklemekti.
     */
    if (route === 'master-password' && method === 'POST') {
      const body = await readJson(req);
      if (state.locked) throw new UserError('locked');
      const { changeMasterPassword } = await import('../config.mjs');
      const r = changeMasterPassword(String(body.oldPassword ?? ''), String(body.newPassword ?? ''));
      // Bellekteki anahtar da tazeleniyor; yoksa bu oturumda yapılacak ilk
      // yazma eski anahtarla mühürlenip kasayı tutarsız bırakırdı.
      state.vaultKey = r.key;
      return json(200, { ok: true, resealed: r.resealed });
    }

    /* ---- tercihler ------------------------------------------------------ */
    if (route === 'preferences' && method === 'GET') {
      return json(200, { preferences: getPreferences() });
    }

    if (route === 'preferences' && method === 'POST') {
      const body = await readJson(req);
      for (const [k, v] of Object.entries(body)) {
        if (!['ui', 'lang'].includes(k)) continue;
        savePreference(k, v);
        if (k === 'lang') state.lang = setLocale(v ?? undefined);
      }
      return json(200, { preferences: getPreferences(), lang: state.lang });
    }

    /* ---- profil yönetimi ------------------------------------------------ */
    /*
     * Arayüzün terminalle eşit olması için profil ekleme/silme burada da var.
     * Akış `login` komutuyla birebir aynı: oturum aç → token üret → kasaya
     * şifreleyerek yaz. cPanel ŞİFRESİ hiçbir yere kaydedilmez; yalnızca bu
     * istek boyunca bellekte durur.
     */
    if (route === 'profiles' && method === 'POST') {
      const body = await readJson(req);
      const host = String(body.host ?? '').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
      const user = String(body.user ?? '').trim();
      const port = Number(body.port) || 2083;
      if (!host || !user || !body.password) throw new UserError('host, user and password are required');
      // Kasa zaten açıksa ana şifre istemiyoruz — tek şifre, tüm hesaplar.
      const master = body.master ?? null;
      if (!master && state.locked) throw new UserError('master password is required');

      const session = await openSession({
        host,
        port,
        user,
        pass: String(body.password),
        insecure: false,
        verbose: state.verbose,
        assumeYes: true,
      });

      let token = null;
      let tokenName = null;
      try {
        const r = await provisionToken({ sessionClient: state.clientFor({ host, port, user, session }) });
        token = r.token;
        tokenName = r.name;
      } catch (err) {
        if (err?.code !== 'FEATURE_DISABLED') {
          await closeSession(session);
          throw err;
        }
      } finally {
        await closeSession(session);
      }

      if (master) {
        process.env.CPANEL_NEXT_MASTER_PASSWORD = String(master);
        try {
          await persistProfile({ host, port, user, token, tokenName });
        } finally {
          delete process.env.CPANEL_NEXT_MASTER_PASSWORD;
        }
        state.unlock(String(master));
      } else {
        // Açık kasanın anahtarıyla doğrudan mühürle; şifre hiç sorulmuyor.
        const { sealToken } = await import('../vault.mjs');
        const { saveProfile } = await import('../config.mjs');
        saveProfile(host, {
          host,
          port,
          user,
          tokenName,
          createdAt: new Date().toISOString(),
          tokenEnc: token ? sealToken(state.vaultKey, token) : undefined,
        });
        state.unlocked.set(host, { name: host, host, port, user, tokenName, token });
      }

      // Otomatik giriş isteniyorsa şifre kasaya mühürleniyor — AYRI ve AÇIK
      // bir tercih olarak, token kaydından sonra.
      if (body.savePassword) {
        await storePassword(state, host, String(body.password));
      }

      return json(200, { profiles: [...state.unlocked.values()].map(publicProfile) });
    }

    /*
     * Hesap DÜZENLEME.
     *
     * Eskiden yalnızca ekle/sil vardı ve şu durumlarda tek çare hesabı silip
     * yeniden eklemekti:
     *   · token cPanel'den iptal edilmiş (şifre değişimi token'ı BOZMAZ, ama
     *     kullanıcılar genelde aynı anda token'ı da siliyor)
     *   · sunucu adı, port ya da kullanıcı adı değişmiş
     *   · hesap başka bir sunucuya taşınmış
     *
     * Silip yeniden eklemek, aracın ürettiği eski token'ı sunucuda ÖKSÜZ
     * bırakıyordu — geçerli ama artık kimsenin bilmediği bir tam yetki
     * anahtarı. Düzenleme bu yüzden bir kolaylık değil, güvenlik meselesi.
     */
    if (route.startsWith('profiles/') && method === 'PATCH') {
      const name = decodeURIComponent(route.slice('profiles/'.length));
      const body = await readJson(req);
      if (state.locked) throw new UserError('locked');

      const current = state.unlocked.get(name);
      if (!current) throw new UserError(t('logout.notFound', { name }));

      const host = String(body.host ?? current.host).trim()
        .replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
      const user = String(body.user ?? current.user).trim();
      const port = Number(body.port ?? current.port) || 2083;
      if (!host || !user) throw new UserError('host and user are required');

      let token = current.token;
      let tokenName = current.tokenName;

      /*
       * Şifre VERİLDİYSE yeni bir token üretiliyor.
       *
       * Şifre yine hiçbir yere yazılmıyor; yalnızca bu istek boyunca bellekte
       * duruyor ve token üretmek için kullanılıyor.
       */
      if (body.password) {
        const session = await openSession({
          host, port, user, pass: String(body.password),
          insecure: false, verbose: state.verbose, assumeYes: true,
        });
        try {
          const r = await provisionToken({ sessionClient: state.clientFor({ host, port, user, session }) });
          token = r.token;
          tokenName = r.name;
        } finally {
          await closeSession(session);
        }
      }

      const { sealToken } = await import('../vault.mjs');
      const { saveProfile } = await import('../config.mjs');

      // Profiller sunucu adıyla anahtarlanıyor; sunucu değiştiyse eski kayıt
      // ARTA KALMAMALI, yoksa listede aynı hesap iki kez görünür.
      if (host !== name) {
        removeProfile(name);
        state.unlocked.delete(name);
        state.sessions.delete(name);
      }

      saveProfile(host, {
        host,
        port,
        user,
        tokenName,
        updatedAt: new Date().toISOString(),
        tokenEnc: token && state.vaultKey ? sealToken(state.vaultKey, token) : undefined,
      });
      state.unlocked.set(host, {
        name: host, host, port, user, tokenName, token,
        password: current.password ?? null,
      });
      state.sessions.delete(host); // bir sonraki istek yeni bilgilerle bağlansın

      /*
       * Şifre saklama tercihi burada da AÇIKÇA yönetiliyor.
       *
       * `savePassword: false` gelirse kayıtlı şifre SİLİNİYOR — otomatik
       * girişi kapatmanın yolu hesabı silmek olmamalı.
       */
      if (body.savePassword && body.password) {
        await storePassword(state, host, String(body.password));
      } else if (body.savePassword === false) {
        await storePassword(state, host, null);
      }

      return json(200, { profiles: [...state.unlocked.values()].map(publicProfile) });
    }

    /*
     * Bağlantı testi.
     *
     * "Şifremi değiştirdim, hâlâ çalışıyor mu?" sorusunun cevabı deploy'un
     * ortasında değil, burada verilmeli. Tek bir `whoami` çağrısı, kayıtlı
     * token'ın hâlâ geçerli olup olmadığını kesin olarak söylüyor.
     */
    if (route.startsWith('profiles/') && route.endsWith('/test') && method === 'POST') {
      const name = decodeURIComponent(route.slice('profiles/'.length, -'/test'.length));
      if (state.locked) throw new UserError('locked');
      const profile = state.unlocked.get(name);
      if (!profile) throw new UserError(t('logout.notFound', { name }));

      const client = state.clientFor({ host: profile.host, port: profile.port, user: profile.user });
      client.token = profile.token;
      try {
        const info = await client.whoami();
        return json(200, {
          ok: true,
          user: info?.user ?? profile.user,
          domain: info?.domain ?? null,
          theme: info?.theme ?? null,
        });
      } catch (err) {
        // Başarısızlık bir SUNUCU hatası değil, bir CEVAP: arayüz bunu kırmızı
        // bir kutu olarak değil, "token geçersiz" durumu olarak gösteriyor.
        return json(200, { ok: false, error: err.message, hint: err.hint ?? null });
      }
    }

    if (route.startsWith('profiles/') && method === 'DELETE') {
      const name = decodeURIComponent(route.slice('profiles/'.length));
      const existed = removeProfile(name);
      if (!existed) throw new UserError(t('logout.notFound', { name }));
      state.unlocked.delete(name);
      state.sessions.delete(name);
      return json(200, {
        profiles: [...state.unlocked.values()].map(publicProfile),
        tokenName: null,
      });
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

      /*
       * cPanel'in kendi ekranlarına bağlantılar buradan gidiyor.
       *
       * Tarayıcıda üretmiyoruz çünkü hesabın TEMASI gerekiyor (Dosya
       * Yöneticisi'nin yolu temaya bağlı) ve o bilgi yalnızca sunucuda,
       * probe sonucunda var.
       */
      const account = { host: ctx.client.host, port: ctx.client.port, user: ctx.client.user };
      const theme = ctx.probeResult.theme;

      /*
       * LARAVEL SİTELERİ AYRI KEŞFEDİLİYOR.
       *
       * `listApps` Node.js kayıt defterini okuyor (PassengerApps /
       * CloudLinux Selector). Laravel'in orada bir kaydı YOK — PHP'yi
       * sunucunun kendi işleyicisi çalıştırıyor. Bu yüzden Laravel siteleri
       * panelde hiç görünmüyordu ve tek tuşla güncellenemiyordu.
       *
       * Bulma yolu: her domainin belge kökündeki sahiplik işaretine bakmak.
       * `framework: 'laravel'` yazan bir işaret, oraya bu araçla Laravel
       * yayınlandığı anlamına geliyor.
       *
       * İşaretler PARALEL okunuyor: çok domainli bir hesapta sırayla okumak
       * paneli saniyelerce bekletirdi.
       */
      const sites = (
        await Promise.all(
          domains
            .filter((d) => d.docroot && d.type !== 'parked')
            .map(async (d) => {
              const marker = await readOwnerMarker(ctx.client, d.docroot).catch(() => null);
              if (marker?.framework !== 'laravel') return null;
              return {
                domain: d.domain,
                appRoot: remote.rel(d.docroot),
                framework: 'laravel',
                ownerProject: marker.project ?? null,
                version: marker.version ?? null,
                deployedAt: marker.createdAt ?? null,
                filesUrl: links.fileManager(
                  { host: ctx.client.host, port: ctx.client.port, user: ctx.client.user },
                  { dir: d.docroot, theme: ctx.probeResult.theme }
                ),
              };
            })
        )
      ).filter(Boolean);

      return json(200, {
        profile: publicProfile(state.unlocked.get(name)),
        sites,
        regime: ctx.probeResult.regime,
        regimeLabel: regimeLabel(ctx.probeResult.regime),
        maxApps: ctx.probeResult.maxApps,
        driver: ctx.driver?.id ?? null,
        domains: domains.map((d) => ({ ...d, typeLabel: TYPE_LABEL[d.type] ?? d.type })),
        apps: enriched.map((a) => ({
          ...a,
          filesUrl: links.fileManager(account, { dir: a.path, theme }),
        })),
        links: {
          cpanel: links.cpanelHome(account),
          phpMyAdmin: links.phpMyAdmin(account),
          files: links.fileManager(account, { theme }),
          tokens: links.apiTokens(account, { theme }),
        },
      });
    }

    /* ---- subdomain ------------------------------------------------------- */
    if (route === 'subdomain' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const created = await createSubdomain(ctx.client, {
        subLabel: String(body.label ?? '').trim().toLowerCase(),
        rootDomain: body.rootDomain,
        dir: `${String(body.label ?? '').trim().toLowerCase()}.${body.rootDomain}`,
      });
      return json(200, created);
    }

    if (route === 'subdomain' && method === 'DELETE') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const domain = String(body.domain ?? '');

      // Yazarak onay: subdomain silmek belge kökünü de götürebiliyor.
      if (body.confirm !== domain) {
        throw new UserError(
          t('deploy.confirmMismatch', { given: body.confirm ?? '', appRoot: domain }),
          t('deploy.confirmMismatchHint')
        );
      }
      // Üzerinde kayıtlı bir Node uygulaması varsa önce onu kaldırmak gerekir.
      const apps = ctx.driver ? await ctx.driver.listApps(ctx) : [];
      const bound = apps.find((a) => a.domain === domain);
      if (bound) throw new UserError(t('subdomain.boundToApp', { app: bound.name }));

      await deleteSubdomain(ctx.client, domain);
      return json(200, { ok: true, domain });
    }

    /* ---- veritabanı ------------------------------------------------------ */
    /*
     * cPanel'in MySQL UAPI'si eksiksiz — burada köprüye, cron'a, tarayıcıya
     * gerek yok. Bu yüzden veritabanı işlemleri İŞ (job) olarak koşmuyor:
     * hepsi tek bir HTTP turunda biter.
     */
    if (route.startsWith('db/') && method === 'GET') {
      const name = decodeURIComponent(route.slice('db/'.length));
      const ctx = await state.session(name);
      const data = await mysql.overview(ctx.client);
      return json(200, {
        ...data,
        pmaUrl: mysql.phpMyAdminUrl({
          host: ctx.client.host,
          port: ctx.client.port,
          user: ctx.client.user,
        }),
      });
    }

    if (route === 'db-create' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const result = await mysql.provision(ctx.client, {
        name: String(body.name ?? '').trim(),
        user: body.user ? String(body.user).trim() : null,
        password: body.password ? String(body.password) : null,
      });
      return json(200, {
        ...result,
        pmaUrl: mysql.phpMyAdminUrl({
          host: ctx.client.host,
          port: ctx.client.port,
          user: ctx.client.user,
          database: result.database,
        }),
      });
    }

    /*
     * Silme: YAZARAK ONAY, sunucuda denetleniyor.
     *
     * Veritabanı silmek, klasör silmekten geri alınması daha zor bir iş —
     * yedeği yok. Arayüzdeki onay kutusu yetmez, bu uç doğrudan da
     * çağrılabilir.
     */
    if (route === 'db-delete' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const database = String(body.database ?? '');
      if (body.confirm !== database) {
        throw new UserError(
          t('deploy.confirmMismatch', { given: body.confirm ?? '', appRoot: database }),
          t('db.deleteHint')
        );
      }
      await mysql.deleteDatabase(ctx.client, database);
      return json(200, { ok: true, database });
    }

    if (route === 'db-user-delete' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const user = String(body.user ?? '');
      if (body.confirm !== user) {
        throw new UserError(
          t('deploy.confirmMismatch', { given: body.confirm ?? '', appRoot: user }),
          t('db.deleteHint')
        );
      }
      await mysql.deleteUser(ctx.client, user);
      return json(200, { ok: true, user });
    }

    if (route === 'db-grant' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      if (body.revoke) await mysql.revoke(ctx.client, body.user, body.database);
      else await mysql.grantAll(ctx.client, body.user, body.database);
      return json(200, { ok: true });
    }

    if (route === 'db-password' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const password = body.password ? String(body.password) : mysql.generatePassword();
      await mysql.setPassword(ctx.client, String(body.user), password);
      const server = await mysql.getServerInfo(ctx.client);
      return json(200, {
        user: body.user,
        password,
        url: body.database
          ? mysql.buildDatabaseUrl({
              user: body.user,
              password,
              host: server.host,
              port: server.port,
              database: body.database,
            })
          : null,
      });
    }

    /* ---- ortam dosyası ---------------------------------------------------- */
    /*
     * `.env` pakete GİRMİYOR (izin listesi onu dışarıda tutuyor), yani sunucuya
     * ulaşmasının başka yolu yok. Bağlantı dizesini üretip kullanıcıyı FTP'ye
     * göndermek, işi yarım bırakmak olurdu.
     *
     * Değerler VARSAYILAN OLARAK MASKELİ dönüyor; ham hâli açıkça isteniyor.
     */
    if (route === 'env' && method === 'GET') {
      const ctx = await state.session(url.searchParams.get('profile'));
      const appRoot = remote.rel(url.searchParams.get('appRoot') ?? '');
      const file = url.searchParams.get('file') || '.env';
      if (!appRoot) throw new UserError('appRoot required');
      if (!ENV_FILES.includes(file)) throw new UserError(`unsupported env file: ${file}`);
      const reveal = url.searchParams.get('reveal') === '1';
      const raw = await remote.readFile(ctx.client, appRoot, file).catch(() => null);
      const values = parseEnv(raw ?? '');
      return json(200, {
        file,
        exists: raw !== null,
        entries: Object.entries(values).map(([key, value]) => ({
          key,
          value: reveal ? value : maskValue(key, value),
          masked: !reveal && maskValue(key, value) !== value,
        })),
      });
    }

    if (route === 'env' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const appRoot = remote.rel(body.appRoot ?? '');
      const file = body.file || '.env';
      if (!appRoot) throw new UserError('appRoot required');
      if (!ENV_FILES.includes(file)) throw new UserError(`unsupported env file: ${file}`);

      const current = (await remote.readFile(ctx.client, appRoot, file).catch(() => null)) ?? '';
      let next;
      let changed;
      if (body.remove) {
        const r = removeEnv(current, String(body.remove));
        next = r.content;
        changed = { removed: r.changed ? [body.remove] : [] };
      } else {
        const r = upsertEnv(current, body.entries ?? {});
        next = r.content;
        changed = { added: r.added, updated: r.updated, unchanged: r.unchanged };
      }
      await remote.saveFile(ctx.client, appRoot, file, next);
      return json(200, { ok: true, file, ...changed });
    }

    /*
     * Yerel `.env.local` — kullanıcının kendi makinesinde.
     *
     * Sunucudakiyle aynı değeri yerelde de istemek en yaygın istek: `npm run
     * dev` aynı veritabanına bağlansın diye. Yalnızca ortam dosyalarına ve
     * yalnızca var olan bir dizine yazıyoruz.
     */
    if (route === 'env-local' && method === 'POST') {
      const body = await readJson(req);
      const dir = String(body.projectPath ?? '');
      const file = body.file || '.env.local';
      if (!ENV_FILES.includes(file)) throw new UserError(`unsupported env file: ${file}`);
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new UserError('project path not found');
      }
      const target = path.join(dir, file);
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const r = upsertEnv(current, body.entries ?? {});
      fs.writeFileSync(target, r.content, { mode: 0o600 });
      return json(200, { ok: true, file, path: target, added: r.added, updated: r.updated });
    }

    /* ---- e-posta ---------------------------------------------------------- */
    if (route.startsWith('mail/') && method === 'GET') {
      const name = decodeURIComponent(route.slice('mail/'.length));
      const ctx = await state.session(name);
      const [accounts, domains] = await Promise.all([
        email.listAccounts(ctx.client),
        email.listDomains(ctx.client).catch(() => []),
      ]);
      return json(200, { accounts, domains });
    }

    if (route === 'mail-create' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const r = await email.createAccount(ctx.client, {
        user: body.user, domain: body.domain,
        password: body.password || null, quota: Number(body.quota) || 0,
      });
      return json(200, r);
    }

    if (route === 'mail-password' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      return json(200, await email.setPassword(ctx.client, body.email, body.password || null));
    }

    if (route === 'mail-quota' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      await email.setQuota(ctx.client, body.email, Number(body.quota) || 0);
      return json(200, { ok: true });
    }

    if (route === 'mail-delete' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      // Yazarak onay: bir posta kutusunu silmek içindeki bütün postaları da siler.
      if (body.confirm !== body.email) {
        throw new UserError(
          t('deploy.confirmMismatch', { given: body.confirm ?? '', appRoot: body.email }),
          t('mail.deleteHint')
        );
      }
      await email.deleteAccount(ctx.client, body.email);
      return json(200, { ok: true });
    }

    if (route === 'mail-settings' && method === 'GET') {
      const ctx = await state.session(url.searchParams.get('profile'));
      const account = url.searchParams.get('email');
      return json(200, await email.clientSettings(ctx.client, account));
    }

    /* ---- FTP -------------------------------------------------------------- */
    if (route.startsWith('ftp/') && method === 'GET') {
      const name = decodeURIComponent(route.slice('ftp/'.length));
      const ctx = await state.session(name);
      const [accounts, server] = await Promise.all([
        ftp.listAccounts(ctx.client).catch(() => []),
        ftp.serverInfo(ctx.client, { host: ctx.client.host }),
      ]);
      return json(200, { accounts, server });
    }

    if (route === 'ftp-create' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const r = await ftp.createAccount(ctx.client, {
        user: body.user, password: body.password || null,
        dir: body.dir, quota: Number(body.quota) || 0,
      });
      return json(200, { ...r, login: ftp.loginName(r.user, ctx.client.host) });
    }

    if (route === 'ftp-password' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      return json(200, await ftp.setPassword(ctx.client, body.user, body.password || null));
    }

    if (route === 'ftp-delete' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      if (body.confirm !== body.user) {
        throw new UserError(
          t('deploy.confirmMismatch', { given: body.confirm ?? '', appRoot: body.user }),
          t('ftp.deleteHint')
        );
      }
      await ftp.deleteAccount(ctx.client, body.user);
      return json(200, { ok: true });
    }

    /* ---- cPanel hesap şifresi --------------------------------------------- */
    /*
     * Şifre değişince KASADAKİ kopya da güncelleniyor. Yoksa otomatik giriş
     * eski şifreyle denemeye devam eder ve kullanıcı "değiştirdim, bozuldu"
     * der — oysa bozulan bizim kaydımız.
     */
    if (route === 'account-password' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      await changePassword(ctx.client, {
        oldPassword: String(body.oldPassword ?? ''),
        newPassword: String(body.newPassword ?? ''),
      });
      const profile = state.unlocked.get(body.profile);
      if (profile?.password) await storePassword(state, body.profile, String(body.newPassword));
      return json(200, { ok: true, vaultUpdated: Boolean(profile?.password) });
    }

    /* ---- yedek ve indirme -------------------------------------------------- */
    /*
     * Bunlar İŞ olarak koşuyor: mysqldump ve parçalı aktarım dakikalar
     * sürebiliyor ve kullanıcı ne olduğunu görmeli.
     */
    if (route === 'db-backup' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const job = state.createJob('backup', { profile: body.profile, database: body.database });

      dumpDatabase(ctx, String(body.database), {
        onProgress: (p) => state.pushEvent(job, { type: 'remote', text: progressText(p), pct: p.pct }),
      })
        .then((r) => state.finishJob(job, { result: { path: r.path, size: r.size } }))
        .catch((error) => state.finishJob(job, { error }));

      return json(202, { jobId: job.id });
    }

    if (route === 'files-download' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const job = state.createJob('download', { profile: body.profile, path: body.path });

      archiveAndDownload(ctx, String(body.path), {
        onProgress: (p) => state.pushEvent(job, { type: 'remote', text: progressText(p), pct: p.pct }),
      })
        .then((r) => state.finishJob(job, { result: { path: r.path, size: r.size } }))
        .catch((error) => state.finishJob(job, { error }));

      return json(202, { jobId: job.id });
    }

    /*
     * "Finder'da göster".
     *
     * ⚠ Serbest yol KABUL EDİLMİYOR: bu uç, yerel makinede bir süreç
     * başlatıyor. Yalnızca aracın kendi indirme klasörünün altındaki yollar
     * açılabiliyor, yani bu uç bir "her şeyi aç" aracına dönüşemez.
     */
    if (route === 'reveal' && method === 'POST') {
      const body = await readJson(req);
      const target = path.resolve(String(body.path ?? ''));
      if (!isInsideDownloads(target)) throw new UserError(t('download.notOnDisk', { path: target }));
      return json(200, { ok: revealInFileManager(target) });
    }

    /* ---- yerel dosya sistemi ------------------------------------------- */
    if (route === 'browse' && method === 'GET') {
      const target = url.searchParams.get('path') || os.homedir();
      return json(200, browse(target, { withFiles: url.searchParams.get('files') === '1' }));
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
        const p = planZip(dir, { excludes: excludesFor(dir).excludes, allowEnv: [] });
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
      // Kayıtlı bağlantı: arayüz domain ve klasörü hazır doldursun, kullanıcı
      // her seferinde elle yazmasın.
      return json(200, { project, plan, hasStartup: project.hasServerJs, link: projectLink(dir) });
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

      const ownership = await inspectOwnership(ctx.client, appRoot, {
        dirExists,
        apps,
        domain: target.domain,
      });

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

    /* ---- Laravel hazırlığı ------------------------------------------------ */
    /*
     * Laravel'in AYRI bir preflight'ı var çünkü uygulama klasörü SEÇİLMİYOR:
     * belge kökünün ta kendisi. Genel `preflight` bu yolu `assertAppRoot` ile
     * reddeder — ve haklıdır, Next.js için kaynak kodu belge köküne koymak
     * hatadır. Laravel'de ise zorunlu düzen bu.
     */
    if (route === 'laravel-preflight' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const domains = await listDomains(ctx.client);
      const target = await resolveDomain(ctx.client, body.domain, domains);

      if (target.kind === 'not-found') throw new UserError(t('status.notFound', { domain: body.domain }));
      if (target.kind === 'parked') throw new UserError(target.reason);
      if (!target.docroot) throw new UserError(t('laravel.noDocroot', { domain: target.domain }));

      const appRoot = remote.rel(target.docroot);
      const entries = (await remote.list(ctx.client, appRoot).catch(() => []))
        .filter((e) => !['.', '..'].includes(e.name));
      const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);

      return json(200, {
        target: { kind: target.kind, domain: target.domain, docroot: target.docroot },
        appRoot,
        first: marker?.framework !== 'laravel',
        count: entries.length,
        sample: entries.slice(0, 14).map((e) => e.name),
        ownerProject: marker?.project ?? null,
      });
    }

    /* ---- deploy --------------------------------------------------------- */
    if (route === 'deploy' && method === 'POST') {
      const body = await readJson(req);
      const job = await startDeploy(state, body);
      return json(202, { jobId: job.id });
    }

    /* ---- uygulama denetimi --------------------------------------------- */
    /*
     * Başlat/durdur/yeniden başlat da İŞ olarak koşuyor.
     *
     * CloudLinux'ta bunlar worker'dan geçiyor ve 5-60 saniye sürebiliyor.
     * Eşzamanlı çalıştırıp sonunda "ok" dönmek, kullanıcıyı ne olduğunu
     * bilmeden bekletmek demekti.
     */
    if (route === 'app-action' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const apps = await ctx.driver.listApps(ctx);
      const app = apps.find((a) => remote.rel(a.path) === remote.rel(body.appRoot));
      if (!app) throw new UserError('app not found');
      if (!['start', 'stop', 'restart'].includes(body.action)) {
        throw new UserError(`unknown action: ${body.action}`);
      }

      const job = state.createJob(body.action, { profile: body.profile, appRoot: app.path });
      const emit = (key, params = {}) =>
        state.pushEvent(job, { type: 'step', key, params, text: t(key, params) });

      (async () => {
        // Anahtarı `${action}ing` diye birleştirmek "stop" için "stoping"
        // üretiyordu ve çeviri bulunamıyordu. Açık eşleme, sessiz kayıp yok.
        const LABEL = { start: 'apps.starting', stop: 'apps.stopping', restart: 'apps.restarting' };
        emit(LABEL[body.action], { name: app.name });
        const onProgress = (step, pct) => state.pushEvent(job, { type: 'remote', text: step, pct });
        if (body.action === 'start') await ctx.driver.start(ctx, app, { onProgress });
        else if (body.action === 'stop') await ctx.driver.stop(ctx, app, { onProgress });
        else await ctx.driver.restart(ctx, app, { url: app.domain ? `https://${app.domain}` : null });
        return { action: body.action };
      })()
        .then((result) => state.finishJob(job, { result }))
        .catch((error) => state.finishJob(job, { error }));

      return json(202, { jobId: job.id });
    }

    /* ---- uygulama silme --------------------------------------------------- */
    /*
     * Silme faz 1'de bilerek yoktu; artık var ama tek tıkla değil.
     * `confirm` alanı app-root ile BİREBİR eşleşmek zorunda ve bu SUNUCUDA
     * denetleniyor — arayüzü atlayıp ucu doğrudan çağırmak da işe yaramaz.
     * Dosyaları silmek ayrıca ve açıkça istenmeli.
     */
    if (route === 'app-delete' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const appRoot = remote.rel(body.appRoot);

      if (body.confirm !== appRoot) {
        throw new UserError(
          t('deploy.confirmMismatch', { given: body.confirm ?? '', appRoot }),
          t('deploy.confirmMismatchHint')
        );
      }
      assertAppRoot(appRoot, { docroots: [] });

      const apps = await ctx.driver.listApps(ctx);
      const app = apps.find((a) => remote.rel(a.path) === appRoot);
      if (!app) throw new UserError('app not found');

      const job = state.createJob('delete', { profile: body.profile, appRoot });
      (async () => {
        state.pushEvent(job, {
          type: 'step',
          text: t('apps.deletingApp', { name: app.name }),
        });
        return ctx.driver.destroyApp(ctx, app, {
          deleteFiles: Boolean(body.deleteFiles),
          onProgress: (step, pct) => state.pushEvent(job, { type: 'remote', text: step, pct }),
        });
      })()
        .then((result) => state.finishJob(job, { result }))
        .catch((error) => state.finishJob(job, { error }));

      return json(202, { jobId: job.id });
    }

    /* ---- bağlı projeden güncelleme --------------------------------------- */
    /*
     * Uygulamanın sahiplik işareti, hangi YEREL projeden yayınlandığını
     * söylüyor. O klasör hâlâ duruyorsa güncelleme tek tıkla yapılabilir —
     * hedef seçilmiyor, hatırlanıyor.
     */
    if (route === 'app-update' && method === 'POST') {
      const body = await readJson(req);
      const ctx = await state.session(body.profile);
      const appRoot = remote.rel(body.appRoot);
      /*
       * `projectPath` GELDİYSE onu kullan; sahiplik işaretine yalnızca hiç
       * gelmediğinde düşülüyor. Eskiden arayüz bunu hiç göndermiyordu ve
       * sunucu sessizce işaretteki eski projeyi yayınlıyordu.
       */
      const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
      const projectPath = body.projectPath || marker?.project || null;

      if (!projectPath || !fs.existsSync(projectPath)) {
        throw new UserError(t('update.notLinked'), t('update.notLinkedHint'));
      }

      /*
       * ⚠ FRAMEWORK UYUŞMAZLIĞI REDDEDİLİYOR.
       *
       * Bu klasöre daha önce ne yayınlandığını sahiplik işareti söylüyor.
       * Gelen projenin framework'ü ondan farklıysa yanlış proje seçilmiş
       * demektir — ve bu, o klasörün ÜSTÜNE başka bir uygulamayı yazmak olur.
       *
       * Arayüz bir hata yüzünden tam bunu yapıyordu: seçili proje, sitenin
       * bağlı olduğu projeyi eziyordu. Arayüz düzeltildi ama denetim burada
       * olmak zorunda — bu uç doğrudan da çağrılabilir ve hatanın bedeli
       * yayındaki bir siteyi kaybetmek.
       */
      const incoming = detectProject(projectPath);
      if (marker?.framework && incoming.framework !== marker.framework) {
        throw new UserError(
          t('update.frameworkMismatch', {
            expected: marker.framework,
            got: incoming.framework,
            appRoot,
          }),
          t('update.frameworkMismatchHint', { project: marker.project ?? '?' })
        );
      }

      const job = await startDeploy(state, {
        profile: body.profile,
        projectPath,
        domain: body.domain ?? marker?.domain,
        appRoot,
        noBuild: Boolean(body.noBuild),
        confirm: appRoot, // hedef hatırlanıyor, seçilmiyor
      });
      return json(202, { jobId: job.id });
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

/**
 * cPanel şifresini kasaya mühürler ya da siler.
 *
 * ⚠ Bu, aracın varsayılan sözünden bilinçli bir SAPMA: normalde cPanel şifresi
 * hiçbir yere yazılmıyor. Otomatik girişin başka yolu olmadığı için (cPanel
 * spesifikasyonu: `Session::create_temp_user` geçerli bir OTURUM gerektiriyor,
 * token yetmiyor) isteğe bağlı olarak sunuluyor.
 *
 * Saklandığında token ile aynı kasada: scrypt ile türetilmiş anahtar,
 * AES-256-GCM, 0600 dosya. Blast radius açısından zaten saklanan token da tam
 * yetkili — ama şifre başka yerlerde tekrar kullanılmış olabilir, o yüzden
 * tercih kullanıcının.
 */
async function storePassword(state, name, password) {
  const { sealToken } = await import('../vault.mjs');
  const { saveProfile, loadGlobalConfig, saveGlobalConfig } = await import('../config.mjs');
  const profile = state.unlocked.get(name);
  if (!profile) return;

  if (password === null) {
    // `saveProfile` alanları BİRLEŞTİRİYOR; silmek için doğrudan yazmak gerek.
    const config = loadGlobalConfig();
    if (config.profiles[name]) {
      delete config.profiles[name].passwordEnc;
      saveGlobalConfig(config);
    }
    profile.password = null;
    return;
  }

  if (!state.vaultKey) throw new UserError('vault key unavailable');
  saveProfile(name, { passwordEnc: sealToken(state.vaultKey, password) });
  profile.password = password;
}

/* ------------------------------------------------------------------ deploy */

async function startDeploy(state, body) {
  const ctx = await state.session(body.profile);
  const cwd = body.projectPath;
  if (!cwd || !fs.existsSync(cwd)) throw new UserError('project path not found');

  const project = detectProject(cwd);
  if (!project.deployable) throw new UserError(project.blockers.join(' · '));

  if (project.framework === 'laravel') return startLaravelDeploy(state, ctx, body, project, cwd);

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

  // Başlangıç dosyası yoksa kullanıcının projesine yaz — CLI ile aynı davranış.
  const startupPath = path.join(cwd, project.startupFile);
  if (!fs.existsSync(startupPath)) fs.writeFileSync(startupPath, SERVER_TEMPLATE);

  const apps = ctx.driver ? await ctx.driver.listApps(ctx) : [];
  const existingApp = apps.find((a) => remote.rel(a.path) === appRoot) ?? null;
  const { excludes: projectExcludes } = excludesFor(cwd);
  const plan = planZip(cwd, { excludes: projectExcludes, allowEnv: [] });

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
      excludes: projectExcludes,
      preserve: ['.env.local', '.env.production.local'],
      noBuild: Boolean(body.noBuild),
      transport: body.transport ?? null,
      nodeVersion: body.nodeVersion ?? null,
      cleanModules: Boolean(body.cleanModules),
      hooks: body.hooks ?? projectHooks(cwd),
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

/**
 * Laravel yayını — web arayüzü dalı.
 *
 * Terminal akışıyla AYNI çekirdeği (`runLaravelDeploy`) kullanıyor; burada
 * yalnızca kararlar gövdeden okunuyor. İki arayüzün ayrı gövdeleri olsaydı
 * birinde düzeltilen davranış diğerinde kalırdı.
 */
async function startLaravelDeploy(state, ctx, body, project, cwd) {
  const { runLaravelDeploy } = await import('../laravel-core.mjs');
  const { normalizeSettings } = await import('../laravel.mjs');

  const domains = await listDomains(ctx.client);
  const target = await resolveDomain(ctx.client, body.domain, domains);
  if (target.kind === 'not-found' || target.kind === 'parked' || !target.docroot) {
    throw new UserError(t('status.notFound', { domain: body.domain }));
  }

  const appRoot = remote.rel(target.docroot);
  const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
  const first = marker?.framework !== 'laravel';

  const entries = (await remote.list(ctx.client, appRoot).catch(() => []))
    .filter((e) => !['.', '..'].includes(e.name));

  /*
   * YAZARAK ONAY — sunucuda zorunlu.
   *
   * Belge kökü dolu olabilir: orada yayında bir WordPress, düz bir HTML site
   * ya da başka bir Laravel duruyor olabilir ve kod dizinleri silinecek.
   * Arayüzdeki kutuyu atlayıp ucu doğrudan çağırmak da işe yaramasın diye
   * denetim burada.
   */
  if (entries.length && body.confirm !== appRoot) {
    throw new UserError(
      t('deploy.confirmMismatch', { given: body.confirm ?? '', appRoot }),
      t('deploy.confirmMismatchHint')
    );
  }

  /*
   * Ayarlar: arayüz gönderdiyse o, göndermediyse PROJEDEKİ.
   *
   * Sihirbazdan gelen yayında kullanıcı kipleri ekranda seçiyor. Panelden
   * "Güncelle"ye basıldığında ise hiçbir şey seçmiyor ve projesinde yazılı
   * olanın uygulanmasını bekliyor.
   */
  const saved = projectLaravel(cwd);

  /*
   * ⚠ EKRANDAN GELEN AYAR, PROJEDEKİNİN ÜSTÜNE BİNİYOR — YERİNİ ALMIYOR.
   *
   * İlk hâli `body.laravel` varsa YALNIZCA onun alanlarından bir nesne kurup
   * `saved`'ı tamamen atıyordu. Sonuç: `.cpanel-next.json` içine
   * `"optimize": false` yazan biri sihirbazdan yayınladığında o ayar sessizce
   * kayboluyordu — ekran o alanı hiç göndermiyor, yok sayılan alan da
   * varsayılana dönüyor.
   *
   * Artık taban `saved`; ekran yalnızca GÖNDERDİĞİ alanları eziyor.
   */
  const settings = normalizeSettings(
    body.laravel
      ? {
          ...saved,
          migrate: body.laravel.migrate ?? saved.migrate,
          firstMigrate: body.laravel.migrate ?? saved.firstMigrate,
          vendor: body.laravel.vendor ?? saved.vendor,
          forceDebugOff: body.laravel.keepDebug ? false : saved.forceDebugOff,
          clean: body.laravel.clean ?? saved.clean,
        }
      : saved,
    { first }
  );

  const job = state.createJob('deploy', {
    profile: body.profile,
    domain: target.domain,
    appRoot,
    projectPath: cwd,
  });

  runLaravelDeploy(
    ctx,
    {
      cwd, project, target, settings,
      db: body.db ?? null, first, transport: body.transport ?? null,
      // Kullanıcının kendi terminal komutları — Next tarafıyla aynı kaynak.
      hooks: body.hooks ?? projectHooks(cwd),
    },
    (e) => state.pushEvent(job, e)
  )
    .then((result) => {
      rememberProject(cwd, { profile: body.profile, domain: target.domain, appRoot });
      state.finishJob(job, {
        result: { url: result.url, backupPath: result.backupPath, exposed: result.exposure.exposed },
      });
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

/** İş kaydına yazılacak kısa ilerleme satırı. */
function progressText(p) {
  if (p.phase === 'remote') return p.step ?? '';
  if (p.phase === 'download') return `${p.done}/${p.total}`;
  return p.phase ?? '';
}

/* --------------------------------------------------------- yerel yardımcılar */

/**
 * Dizin gezgini.
 *
 * Yalnızca DİZİNLERİ listeler ve dosya içeriğine hiç bakmaz. Kullanıcı kendi
 * makinesinde gezindiği için kısıtlama koymuyoruz, ama okuma da yapmıyoruz.
 */
/**
 * Yerel dizin listesi.
 *
 * ⚠ `withFiles` parametresiz çağrı ESKİ DAVRANIŞI koruyor: yalnızca
 * dizinler, gizli olanlar yok. Proje seçici bunu kullanıyor ve dosya
 * göstermek orada gereksiz gürültü olurdu. Dosya tarayıcısı `files=1`
 * geçerek dosyaları ve gizli girdileri de istiyor.
 */
function browse(target, { withFiles = false } = {}) {
  const dir = path.resolve(target);
  const entries = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const isDir = e.isDirectory();
      if (!withFiles && !isDir) continue;
      if (!isDir && !e.isFile() && !e.isSymbolicLink()) continue;
      // Gizli girdiler yalnızca dosya tarayıcısında; `.env` düzenlemek için
      // görünmeleri gerekiyor.
      if (!withFiles && e.name.startsWith('.') && e.name !== '.') continue;
      if (!withFiles && e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      let size = 0;
      let mtime = 0;
      if (withFiles) {
        try { const st = fs.lstatSync(full); size = st.size; mtime = Math.floor(st.mtimeMs / 1000); } catch { /* yok say */ }
      }
      entries.push({
        name: e.name,
        path: full,
        type: isDir ? 'dir' : 'file',
        size,
        mtime,
        isProject: isDir && fs.existsSync(path.join(full, 'package.json')),
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
