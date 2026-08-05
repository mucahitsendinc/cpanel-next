import fs from 'node:fs';
import path from 'node:path';
import { createSubdomain } from './domain.mjs';
import { buildProject, makeZip } from './packager.mjs';
import { upload, uploadSplit } from './transport/index.mjs';
import * as remote from './remote.mjs';
import { buildOwnerMarker, writeOwnerMarker } from './guards.mjs';
import { escalateToSession } from './auth.mjs';
import { REMOTE } from './paths.mjs';
import { installMaintenanceRule, enableMaintenance, disableMaintenance } from './maintenance.mjs';
import { t } from './i18n/index.mjs';
import { UserError } from './ui.mjs';

/**
 * Deploy'un YÜRÜTME hattı — arayüzden bağımsız.
 *
 * Buradaki hiçbir şey soru sormaz, hiçbir şey ekrana yazmaz. Kararlar (hangi
 * domain, hangi klasör, üzerine yazılsın mı) çağıran tarafta verilir ve
 * hazır bir `spec` olarak gelir. İlerleme `onEvent` ile dışarı akar.
 *
 * Sebep: aynı hattı iki ön yüz kullanıyor — terminal (clack prompt'ları) ve
 * yerel web arayüzü (SSE). Ön yüze özgü tek satır buraya girerse ikisinden
 * biri çalışmaz hâle gelir.
 */

/**
 * @param {object} ctx     client, driver, cfg, flags, cleanup, capabilities
 * @param {object} spec    kararlar (aşağıda)
 * @param {(e:object)=>void} onEvent  { type, key, params, text, pct }
 */
export async function runDeploy(ctx, spec, onEvent = () => {}) {
  const {
    cwd,
    project,
    target,
    appRoot,
    appName,
    existingApp = null,
    dirExists = false,
    excludes = [],
    preserve = ['.env.local', '.env.production.local'],
    noBuild = false,
    transport = null,
    nodeVersion = null,
    cleanModules = false,
    includedFiles = [],
  } = spec;

  const url = `https://${target.domain}`;
  const emit = (type, key, params = {}) => onEvent({ type, key, params, text: t(key, params) });

  /* -- 1. Subdomain ------------------------------------------------------ */
  if (target.kind === 'new-subdomain') {
    emit('step', 'deploy.creatingSubdomain', { domain: target.domain });
    await withSessionFallback(ctx, () =>
      createSubdomain(ctx.client, {
        subLabel: target.subLabel,
        rootDomain: target.rootDomain,
        dir: target.docroot,
      })
    );
    emit('info', 'deploy.sslNote');
  }

  /* -- 2. Bakım kuralını erkenden kur ------------------------------------ */
  // Build'den ÖNCE: LiteSpeed .htaccess'i gecikmeli okuyor, build süresi ona
  // fırsat veriyor. Bakım modunu açmıyor, yalnızca hazırlıyor.
  if (target.docroot) {
    try {
      await installMaintenanceRule(ctx.client, target.docroot, { domain: target.domain });
    } catch (err) {
      emit('warn', 'deploy.maintenanceRuleFailed', { error: err.message });
    }
  }

  /* -- 3. Build (DAİMA yerelde) ------------------------------------------ */
  if (!noBuild) {
    emit('step', 'deploy.building');
    await buildProject(cwd, {
      packageManager: project.packageManager,
      onOutput: (chunk) => onEvent({ type: 'output', text: chunk }),
    });
  } else {
    emit('warn', 'deploy.noBuildFlag');
    if (!fs.existsSync(path.join(cwd, '.next', 'BUILD_ID'))) {
      throw new UserError(t('deploy.noBuildOutput'));
    }
  }

  /* -- 3. Paketle -------------------------------------------------------- */
  emit('step', 'deploy.packing');
  const stamp = () => `${new Date().toISOString()}\n`;
  const pkg = await makeZip(cwd, {
    excludes,
    allowEnv: [],
    // tmp/ dizinini pakete koyuyoruz ki Passenger'ın restart dosyası için yer
    // hazır olsun; sunucuda ayrıca mkdir çağrısı gerekmesin.
    extraFiles: [{ path: 'tmp/restart.txt', content: stamp() }],
  });
  ctx.cleanup?.push(async () => fs.rmSync(pkg.dir, { recursive: true, force: true }));
  emit('step', 'deploy.packed', { files: pkg.fileCount, size: pkg.size });
  if (pkg.skippedEnv.length) {
    emit('info', 'deploy.skippedEnv', { list: pkg.skippedEnv.join(', ') });
  }

  /* -- 4. Yedek — geri dönüş yolu olmadan üzerine yazmayız --------------- */
  const runId = Date.now().toString(36);
  const uploadDir = `${REMOTE.uploadDir}/${runId}`;
  let backupPath = null;

  if (dirExists) {
    emit('step', 'deploy.backingUp');
    try {
      backupPath = await makeBackup(ctx, appRoot);
      emit('info', 'deploy.backedUp', { path: backupPath });
    } catch (err) {
      throw new UserError(
        t('deploy.backupFailedMessage', { error: err.message }),
        t('deploy.backupFailedHint')
      );
    }
  }

  /* -- 5. Yükle ---------------------------------------------------------- */
  emit('step', 'deploy.uploading');
  let transportUsed;
  try {
    const res = await withSessionFallback(ctx, () =>
      upload(ctx, {
        zipPath: pkg.zipPath,
        remoteDir: uploadDir,
        prefer: transport,
        onProgress: ({ sent, total }) => onEvent({ type: 'progress', sent, total }),
      })
    );
    transportUsed = res.strategy;
  } catch (err) {
    if (err?.code === 'TOO_LARGE') {
      emit('warn', 'deploy.uploadTooLarge');
      await remote.mkdirp(ctx.client, appRoot);
      await uploadSplit(ctx, {
        cwd,
        files: includedFiles,
        extraFiles: [{ path: 'tmp/restart.txt', content: stamp() }],
        remoteDir: uploadDir,
        targetDir: appRoot,
      });
      transportUsed = 'split';
    } else {
      throw err;
    }
  }
  emit('info', 'deploy.uploaded', { strategy: transportUsed });

  /* -- 6. Sunucuda uygula ------------------------------------------------ */
  emit('step', 'deploy.applying');
  let app = existingApp;
  let maintenanceOn = false;

  try {
    /*
     * Bakım modu, uygulamayı DURDURMADAN HEMEN ÖNCE açılıyor.
     *
     * Docroot'a düz bir index.html koymak işe yaramaz: orada Passenger
     * yapılandırması var ve Apache/LiteSpeed her isteği Node uygulamasına
     * devrediyor, statik dosyaya hiç bakmıyor. Bu yüzden .htaccess kuralı
     * isteği 503'e çeviriyor ve bakım sayfasını ErrorDocument olarak veriyor.
     */
    if (target.docroot) {
      emit('step', 'deploy.maintenanceOn');
      await enableMaintenance(ctx.client, target.docroot, { domain: target.domain }).catch((err) =>
        emit('warn', 'deploy.maintenanceRuleFailed', { error: err.message })
      );
      maintenanceOn = true;
    }

    if (existingApp) {
      emit('step', 'deploy.stopping');
      await ctx.driver.stop(ctx, existingApp).catch(() => {});
    }

    if (transportUsed !== 'split') {
      if (dirExists) {
        emit('step', 'deploy.cleaning');
        const cleaned = await remote.cleanDir(ctx.client, appRoot, { keep: preserve });
        if (cleaned.failed.length) {
          throw new UserError(
            t('deploy.cleanFailed', { files: cleaned.failed.slice(0, 5).join(', ') }),
            t('deploy.cleanFailedHint')
          );
        }
      } else {
        await remote.mkdirp(ctx.client, appRoot);
      }

      emit('step', 'deploy.extracting');
      await remote.extractZip(ctx.client, `${uploadDir}/pkg.zip`, appRoot);
    }

    // "Başarılı" yanıtına güvenmiyoruz; paket gerçekten açıldı mı diye bakıyoruz.
    if (!(await remote.exists(ctx.client, `${appRoot}/package.json`))) {
      throw new UserError(
        t('deploy.missingPackageJson'),
        backupPath ? t('deploy.backupKept', { path: backupPath }) : undefined
      );
    }

    /*
     * `--clean-modules`: bağımlılıkları sıfırdan kur.
     *
     * Normalde `node_modules` temizlikten muaf tutuluyor (kurulum artımlı
     * olsun diye). Ağaç bozulduğunda tek çıkış yolu onu silmek; iki rejimde
     * de aynı çağrı işe yarıyor — CloudLinux'ta bu bir venv sembolik bağı ve
     * `install-modules` onu yeniden kuruyor.
     */
    if (cleanModules) {
      emit('step', 'deploy.cleaningModules');
      await remote.remove(ctx.client, `${appRoot}/node_modules`, { required: false });
    }

    emit('step', 'deploy.writingMarker');
    await writeOwnerMarker(
      ctx.client,
      appRoot,
      buildOwnerMarker({
        appRoot,
        domain: target.domain,
        projectDir: cwd,
        version: pkg.sha256.slice(0, 12),
      })
    );

    if (ctx.driver.applyAll) {
      // CloudLinux: kaydet + kur + başlat adımlarının her biri ayrı bir cron
      // turu (~60-90 sn) demek. Hepsini tek betikte koşturuyoruz.
      emit('step', 'deploy.runningRemote');
      await ctx.driver.applyAll(ctx, {
        appRoot,
        domain: target.domain,
        startupFile: project.startupFile,
        nodeVersion,
        isNew: !existingApp,
        existingAppRoot: existingApp?.path ?? null,
        onProgress: (step, pct) => onEvent({ type: 'remote', text: step, pct }),
      });
      app = (await ctx.driver.findApp(ctx, { path: appRoot, domain: target.domain })) ?? {
        name: appName,
        path: appRoot,
      };
    } else {
      if (!existingApp) {
        emit('step', 'deploy.registering');
        app = await ctx.driver.createApp(ctx, {
          name: appName,
          appRoot,
          domain: target.domain,
          baseUri: '/',
          mode: 'production',
          nodeVersion,
          startupFile: project.startupFile,
        });
      } else {
        await ctx.driver.start(ctx, existingApp).catch(() => {});
      }

      emit('step', 'deploy.installing');
      await ctx.driver.installDeps(ctx, app, {
        onProgress: (line) => onEvent({ type: 'remote', text: String(line) }),
      });
    }

    emit('step', 'deploy.restarting');
    await ctx.driver.restart(ctx, app, { url });

    if (maintenanceOn) {
      emit('step', 'deploy.maintenanceOff');
      await disableMaintenance(ctx.client, target.docroot);
      maintenanceOn = false;
    }
  } catch (err) {
    /*
     * Hata hâlinde bakım modu AÇIK BIRAKILIYOR — bilerek.
     *
     * Deploy yarıda kaldıysa uygulama zaten ayakta değil; ziyaretçiye ham bir
     * Passenger hatası göstermektense "yenileniyor" sayfası göstermek daha
     * doğru. Nasıl kapatılacağı kullanıcıya söyleniyor.
     */
    if (maintenanceOn) err.maintenanceLeftOn = target.domain;
    throw err;
  } finally {
    await remote.remove(ctx.client, uploadDir, { required: false }).catch(() => {});
  }

  /* -- 7. Geçmiş --------------------------------------------------------- */
  await appendHistory(ctx, appRoot, {
    date: new Date().toISOString(),
    version: pkg.sha256.slice(0, 12),
    files: pkg.fileCount,
    size: pkg.size,
    transport: transportUsed,
    ok: true,
  });

  emit('done', 'deploy.published');
  return { url, backupPath, transportUsed, pkg, app };
}

/**
 * Token yolu tıkanırsa oturum kipine yükseltip işlemi TEKRAR dener.
 *
 * cPanel API token'larının API2 uçlarında çalışıp çalışmadığı hiçbir resmî
 * kaynakta belgeli değil; bazı hostlarda çalışıyor, bazılarında 403 dönüyor.
 * Kullanıcıyı bu ayrıntıyla uğraştırmak yerine sessizce oturum açıyoruz.
 */
export async function withSessionFallback(ctx, fn) {
  try {
    return await fn();
  } catch (err) {
    const needsSession =
      err?.code === 'API2_AUTH' || err?.code === 'API2_PARSE' || err?.code === 'FEATURE_DISABLED';
    if (!needsSession || ctx.sessionClient) throw err;
    await escalateToSession(ctx, err.message);
    ctx.client = ctx.sessionClient;
    return fn();
  }
}

/**
 * Yedek alır.
 *
 * `node_modules` yedeğe GİRMEZ: kota dolarsa deploy değil müşteri patlar ve
 * bağımlılıklar zaten sunucuda yeniden kurulabiliyor. Takas bilinçli — geri
 * alma ~5 sn yerine 1-2 dk sürüyor, ama yedek 400 MB yerine ~30 MB.
 */
export async function makeBackup(ctx, appRoot) {
  // slice(0, 14) — 15 olsaydı milisaniye ayırıcısını da alır ve klasör adı
  // noktayla biterdi ("…092218."). O da yedek adını ayrıştıran regex'i
  // bozar, yani geri alma yedeği uygulamayla eşleştiremezdi.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = `${REMOTE.backupDir}/${appRoot}-${stamp}`;
  await remote.mkdirp(ctx.client, REMOTE.backupDir);
  await remote.copy(ctx.client, appRoot, dest);
  await remote.remove(ctx.client, `${dest}/node_modules`, { required: false }).catch(() => {});
  return dest;
}

async function appendHistory(ctx, appRoot, entry) {
  try {
    const history = (await remote.readJson(ctx.client, appRoot, REMOTE.historyFile)) ?? [];
    history.push(entry);
    await remote.saveFile(
      ctx.client,
      appRoot,
      REMOTE.historyFile,
      `${JSON.stringify(history.slice(-50), null, 2)}\n`
    );
  } catch {
    /* geçmiş yazılamazsa deploy'u başarısız saymayız */
  }
}
