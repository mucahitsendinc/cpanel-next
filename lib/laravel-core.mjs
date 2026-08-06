import fs from 'node:fs';
import path from 'node:path';
import { buildProject, makeZip, ensureDependencies } from './packager.mjs';
import { upload } from './transport/index.mjs';
import * as remote from './remote.mjs';
import * as mysql from './mysql.mjs';
import { parseEnv, upsertEnv } from './envfile.mjs';
import { mergeMarked } from './htaccess.mjs';
import { buildOwnerMarker, writeOwnerMarker, readOwnerMarker } from './guards.mjs';
import { execViaWorker, shq } from './shell/worker.mjs';
import { installMaintenanceRule, enableMaintenance, disableMaintenance } from './maintenance.mjs';
import { REMOTE } from './paths.mjs';
import { request } from './http.mjs';
import { t } from './i18n/index.mjs';
import { UserError } from './ui.mjs';
import {
  HT_BEGIN,
  HT_END,
  HT_BLOCK,
  LARAVEL_EXCLUDES,
  LARAVEL_PRESERVE,
  MERGED_DIRS,
  MANIFEST_LIMIT,
  publicManifest,
  stalePublicFiles,
  vendorDecision,
  composerLockHash,
  buildEnvPatch,
  artisanPlan,
} from './laravel.mjs';

/**
 * Laravel yayınlama hattı — arayüzden bağımsız.
 *
 * Next.js hattının (deploy-core.mjs) kardeşi ama AYRI bir gövde, çünkü bu bir
 * ince ayar değil çatallanma:
 *
 *   · Node yok, Passenger yok, başlangıç dosyası yok — PHP'yi sunucunun kendi
 *     işleyicisi çalıştırıyor.
 *   · Uygulama klasörü SEÇİLMİYOR: domainin belge kökünün ta kendisi.
 *   · `.env` gönderilmiyor; sunucudaki dosya kullanıcınındır.
 *   · Kurulum sonrası artisan adımları var (migration, önbellek, izinler).
 */
export async function runLaravelDeploy(ctx, spec, onEvent = () => {}) {
  const {
    cwd,
    project,
    target,
    settings,
    db = null,
    first = false,
    transport = null,
  } = spec;

  /*
   * UYGULAMA KÖKÜ = BELGE KÖKÜ.
   *
   * Kullanıcı bunu seçmiyor. Docroot'a dokunmadığımız için Laravel domainin
   * kendi klasörüne kuruluyor ve `.htaccess` isteği `public/` içine alıyor.
   */
  const appRoot = remote.rel(target.docroot);
  if (!appRoot) throw new UserError(t('laravel.noDocroot', { domain: target.domain }));

  const url = `https://${target.domain}`;
  const emit = (type, key, params = {}) => onEvent({ type, key, params, text: t(key, params) });

  /* -- 1. Bakım kuralı --------------------------------------------------- */
  try {
    await installMaintenanceRule(ctx.client, appRoot, { domain: target.domain });
  } catch (err) {
    emit('warn', 'deploy.maintenanceRuleFailed', { error: err.message });
  }

  /* -- 2. Varlıkları YERELDE derle --------------------------------------- */
  /*
   * ⚠ `npm run build` YEREL `node_modules` OLMADAN KOŞMAZ.
   *
   * Canlı bir denemede tam olarak bu oldu: `vite: command not found`, çıkış
   * kodu 127. `npm run build` betiği `node_modules/.bin`i PATH'e ekliyor ama
   * o dizin yoksa eklenecek bir şey de yok. Denemeden önce bakıyoruz, çünkü
   * 127 hatası kullanıcıya "vite kurulu değil mi?" dedirtiyor — oysa eksik
   * olan `npm install`.
   *
   * Derlenmiş çıktı ZATEN varsa derlemeyi atlıyoruz: kullanıcı varlıkları
   * daha önce derlemiş ve `node_modules`'ü silmiş olabilir. Bu durumda
   * yayını durdurmak gereksiz.
   */
  if (settings.buildAssets && project.assetBuilder && hasBuildScript(cwd)) {
    const output = (chunk) => onEvent({ type: 'output', text: chunk });

    // `node_modules` yoksa KURULUYOR. Kullanıcıya "önce npm install çalıştır"
    // demek, aracın zaten yapabileceği bir şeyi ona yaptırmaktı.
    await ensureDependencies(cwd, {
      packageManager: project.packageManager,
      onOutput: output,
      onStep: (pm) => emit('step', 'packager.installing', { pm }),
    });

    emit('step', 'laravel.buildingAssets', { builder: project.assetBuilder });
    /*
     * ⚠ Doğrulanacak çıktı LARAVEL'İNKİ.
     *
     * Varsayılan `.next/BUILD_ID`; ilk sürümde bu parametre yoktu ve vite
     * başarıyla derleyip çıktısını ekrana yazdıktan sonra deploy
     * ".next/BUILD_ID oluşmadı" diye reddediliyordu.
     *
     * Vite sürümüne göre manifest iki yerden birinde olabiliyor; Mix ise
     * kökte `mix-manifest.json` bırakıyor.
     */
    await buildProject(cwd, {
      packageManager: project.packageManager,
      onOutput: output,
      expectFiles: [
        'public/build/manifest.json',
        'public/build/.vite/manifest.json',
        'public/mix-manifest.json',
      ],
    });
  }

  /* -- 3. vendor kararı --------------------------------------------------- */
  const localLock = composerLockHash(cwd);
  const marker = await readOwnerMarker(ctx.client, appRoot).catch(() => null);
  const vendor = vendorDecision({
    mode: settings.vendor,
    localHash: localLock,
    remoteHash: marker?.composerLock ?? null,
    first,
  });
  emit('info', `laravel.vendor.${vendor.reason}`, {});

  /* -- 4. Paketle --------------------------------------------------------- */
  emit('step', 'deploy.packing');
  const excludes = [...LARAVEL_EXCLUDES, ...(vendor.ship ? [] : ['vendor/**'])];

  /*
   * `.env.example` PAKETE GİRİYOR — dotenv ailesinden tek istisna.
   *
   * Sunucuda `.env` yoksa oluşturulacak dosyanın dayanağı bu. İçinde sır
   * yok; zaten depoya commit edilen dosya. Diğer bütün `.env*` dosyaları
   * izin listesi dışında kaldığı için elenmeye devam ediyor.
   */
  const pkg = await makeZip(cwd, { excludes, allowEnv: ['.env.example'] });
  ctx.cleanup?.push(async () => fs.rmSync(pkg.dir, { recursive: true, force: true }));
  const manifest = publicManifest(pkg.included);
  emit('step', 'deploy.packed', { files: pkg.fileCount, size: pkg.size });
  if (pkg.skippedEnv.length) {
    emit('info', 'deploy.skippedEnv', { list: pkg.skippedEnv.join(', ') });
  }

  /* -- 5. Yedek ----------------------------------------------------------- */
  const runId = Date.now().toString(36);
  const uploadDir = `${REMOTE.uploadDir}/${runId}`;
  let backupPath = null;

  const existing = await remote.list(ctx.client, appRoot).catch(() => []);
  const meaningful = existing.filter((e) => !['.', '..', 'cgi-bin', '.well-known'].includes(e.name));
  if (meaningful.length) {
    emit('step', 'deploy.backingUp');
    try {
      backupPath = await makeLaravelBackup(ctx, appRoot);
      emit('info', 'deploy.backedUp', { path: backupPath });
    } catch (err) {
      throw new UserError(
        t('deploy.backupFailedMessage', { error: err.message }),
        t('deploy.backupFailedHint')
      );
    }
  }

  /* -- 6. Yükle ----------------------------------------------------------- */
  emit('step', 'deploy.uploading');
  await upload(ctx, {
    zipPath: pkg.zipPath,
    remoteDir: uploadDir,
    prefer: transport,
    onProgress: ({ sent, total }) => onEvent({ type: 'progress', sent, total }),
  });

  /* -- 7. Sunucuda uygula -------------------------------------------------- */
  emit('step', 'deploy.applying');
  let maintenanceOn = false;

  try {
    emit('step', 'deploy.maintenanceOn');
    await enableMaintenance(ctx.client, appRoot, { domain: target.domain }).catch((err) =>
      emit('warn', 'deploy.maintenanceRuleFailed', { error: err.message })
    );
    maintenanceOn = true;

    /*
     * KOD dizinleri siliniyor, VERİ dizinleri duruyor.
     *
     * `app/`, `config/`, `routes/`, `database/`, `resources/`, `vendor/` ve
     * kök dosyaları `cleanDir`'in normal yolundan geçip siliniyor — yerelde
     * silinmiş bir dosyanın sunucuda yaşamaya devam etmemesi için tek yol bu.
     * `public/` ve `storage/` koruma listesinde: paket `public/` üstüne
     * açılıyor, `storage/` hiç ellenmiyor.
     */
    emit('step', 'deploy.cleaning');
    const keep = [...LARAVEL_PRESERVE, ...MERGED_DIRS, ...(vendor.ship ? [] : ['vendor'])];
    const cleaned = await remote.cleanDir(ctx.client, appRoot, { keep });
    if (cleaned.failed.length) {
      throw new UserError(
        t('deploy.cleanFailed', { files: cleaned.failed.slice(0, 5).join(', ') }),
        t('deploy.cleanFailedHint')
      );
    }

    emit('step', 'deploy.extracting');
    await remote.extractZip(ctx.client, `${uploadDir}/pkg.zip`, appRoot);

    /*
     * `public/` budaması.
     *
     * Silinmediği için orada eski bir varlık kalabilir (ör. yeniden
     * adlandırılmış bir `build/assets/app-ESKI.js`). Yalnızca GEÇEN SEFER
     * BİZİM gönderdiğimiz ve bu sefer göndermediğimiz yollar siliniyor;
     * sunucuda üretilmiş dosyalar hiçbir manifestoda olmadığı için
     * dokunulmaz.
     */
    if (manifest && Array.isArray(marker?.publicFiles)) {
      const stale = stalePublicFiles(marker.publicFiles, manifest);
      if (stale.length) {
        emit('info', 'laravel.pruned', { count: stale.length });
        await remote.removeMany(ctx.client, stale.map((f) => `${appRoot}/${f}`), { verify: false });
      }
    } else if (!manifest) {
      emit('warn', 'laravel.manifestTooBig', { limit: MANIFEST_LIMIT });
    }

    if (!(await remote.exists(ctx.client, `${appRoot}/artisan`))) {
      throw new UserError(
        t('laravel.missingArtisan'),
        backupPath ? t('deploy.backupKept', { path: backupPath }) : undefined
      );
    }

    /* -- 8. Yönlendirme bloğu -------------------------------------------- */
    emit('step', 'laravel.htaccess');
    await ensureLaravelHtaccess(ctx.client, appRoot);

    /* -- 9. Sunucudaki .env ----------------------------------------------- */
    const envResult = await syncEnv(ctx, {
      appRoot,
      domain: target.domain,
      db,
      settings,
      first,
      emit,
    });

    /* -- 10. composer + artisan ------------------------------------------- */
    emit('step', 'laravel.running');
    await runServerSteps(ctx, {
      appRoot,
      domain: target.domain,
      settings,
      installVendor: vendor.install,
      keyGenerate: envResult.needsKey,
      onProgress: (step, pct) => onEvent({ type: 'remote', text: step, pct }),
      onStart: (jobId) => onEvent({ type: 'job', jobId }),
    });

    emit('step', 'deploy.maintenanceOff');
    await disableMaintenance(ctx.client, appRoot);
    maintenanceOn = false;
  } catch (err) {
    if (maintenanceOn) err.maintenanceLeftOn = target.domain;
    throw err;
  } finally {
    await remote.remove(ctx.client, uploadDir, { required: false }).catch(() => {});
  }

  /* -- 11. Sahiplik işareti ---------------------------------------------- */
  await writeOwnerMarker(
    ctx.client,
    appRoot,
    {
      ...buildOwnerMarker({
        appRoot,
        domain: target.domain,
        projectDir: cwd,
        version: pkg.sha256.slice(0, 12),
      }),
      framework: 'laravel',
      // Bir sonraki deploy'un "vendor değişti mi" kararı buna bakıyor.
      composerLock: localLock,
      // Bir sonraki deploy'un "public/ altında neyi budayabilirim" kararı da
      // buna bakıyor. Listede olmayan dosya asla silinmez.
      publicFiles: manifest,
    }
  );

  /* -- 12. AÇIKTA MI? ----------------------------------------------------- */
  /*
   * Bu adım isteğe bağlı bir güzellik değil.
   *
   * Belge kökünün altına kaynak kod koyduk. Yönlendirme çalışmıyorsa (host
   * `AllowOverride None` demiştir, mod_rewrite kapalıdır, `.htaccess` yok
   * sayılıyordur) `.env` dosyası internete açıktır — veritabanı şifresi,
   * uygulama anahtarı, API anahtarları. "Kurdum, herhalde olmuştur" demek
   * yerine gerçekten çekip bakıyoruz.
   */
  const exposure = await checkExposure(target.domain);
  if (exposure.exposed.length) {
    emit('warn', 'laravel.exposed', { list: exposure.exposed.join(', ') });
  } else if (exposure.checked) {
    emit('info', 'laravel.notExposed', {});
  }

  emit('done', 'deploy.published');
  return { url, backupPath, pkg, appRoot, vendor, exposure };
}

/* ----------------------------------------------------------------- .htaccess */

export async function ensureLaravelHtaccess(client, appRoot) {
  const current = (await remote.readFile(client, appRoot, '.htaccess').catch(() => null)) ?? '';
  const next = mergeMarked(current, { begin: HT_BEGIN, end: HT_END, block: HT_BLOCK });
  if (next === null) return false;
  await remote.saveFile(client, appRoot, '.htaccess', next);
  return true;
}

/* ---------------------------------------------------------------------- env */

/**
 * Sunucudaki `.env` dosyasını hizalar.
 *
 * ⚠ YERELDEKİ `.env` HİÇ GÖNDERİLMİYOR ve sunucudaki dosyanın hiçbir satırı
 * silinmiyor. Yalnızca `buildEnvPatch`'in ürettiği anahtarlar yazılıyor;
 * geri kalanı kullanıcınındır.
 */
async function syncEnv(ctx, { appRoot, domain, db, settings, first, emit }) {
  let raw = await remote.readFile(ctx.client, appRoot, '.env').catch(() => null);
  let created = false;

  if (raw === null) {
    // `.env` yok: `.env.example` pakette geldiği için ondan başlıyoruz.
    const example = await remote.readFile(ctx.client, appRoot, '.env.example').catch(() => null);
    if (example === null) throw new UserError(t('laravel.noEnvOnServer'), t('laravel.noEnvOnServerHint'));
    raw = example;
    created = true;
    emit('info', 'laravel.envCreated', {});
  }

  const current = parseEnv(raw);
  const patch = buildEnvPatch({
    domain,
    db,
    forceDebugOff: settings.forceDebugOff,
    current,
    first: first || created,
  });

  if (Object.keys(patch).length) {
    const next = upsertEnv(raw, patch);
    await remote.saveFile(ctx.client, appRoot, '.env', next.content);
    emit('info', 'laravel.envPatched', { keys: [...next.added, ...next.updated].join(', ') });
    raw = next.content;
  } else if (created) {
    await remote.saveFile(ctx.client, appRoot, '.env', raw);
  }

  // APP_KEY boşsa uygulama ilk istekte patlar; artisan'a üretteriyoruz.
  const key = parseEnv(raw).APP_KEY;
  return { needsKey: !key || key === 'base64:' };
}

/* -------------------------------------------------------------- sunucu adımı */

/**
 * PHP ikilisini bulur.
 *
 * Domainin MultiPHP sürümü önemli: Laravel 11 PHP 8.2 istiyor ve hesabın
 * varsayılan CLI'ı 7.4 olabiliyor. cPanel'e domainin sürümünü soruyoruz;
 * cevap alamazsak kabuk kendi arıyor.
 */
async function phpCandidates(ctx, domain) {
  const list = [];
  try {
    const data = await ctx.client.uapi('LangPHP', 'php_get_vhost_versions', {});
    const rows = Array.isArray(data) ? data : Object.values(data ?? {});
    const row = rows.find((r) => r?.vhost === domain) ?? rows[0];
    const version = row?.version; // ör. "ea-php82"
    if (version && /^ea-php\d+$/.test(version)) {
      list.push(`/opt/cpanel/${version}/root/usr/bin/php`, `/usr/local/bin/${version}`);
    }
  } catch {
    /* LangPHP yoksa kabuk arayacak */
  }
  return [
    ...list,
    '/opt/cpanel/ea-php83/root/usr/bin/php',
    '/opt/cpanel/ea-php82/root/usr/bin/php',
    '/opt/cpanel/ea-php81/root/usr/bin/php',
    '/usr/local/bin/php',
    '/usr/bin/php',
  ];
}

async function runServerSteps(ctx, {
  appRoot,
  domain,
  settings,
  installVendor,
  keyGenerate,
  onProgress,
  onStart,
}) {
  const home = `/home/${ctx.client.user}`;
  const target = `${home}/${appRoot}`;
  const lines = [];
  const push = (pct, label, cmd, fatal = true) => {
    lines.push(`cn_progress ${pct} ${shq(label)}`);
    if (cmd) lines.push(fatal ? `${cmd} 2>&1 || cn_fail ${shq(label)}` : `${cmd} 2>&1 || true`);
  };

  lines.push(`APPDIR=${shq(target)}`);
  lines.push(`cd "$APPDIR" 2>/dev/null || cn_fail "uygulama dizini yok: $APPDIR"`);

  // PHP: adaylar sırayla denenir, ilk çalıştırılabilir olan kullanılır.
  const candidates = await phpCandidates(ctx, domain);
  lines.push('PHP=""');
  lines.push(`for p in ${candidates.map(shq).join(' ')}; do [ -x "$p" ] && PHP="$p" && break; done`);
  lines.push('[ -n "$PHP" ] || PHP=$(command -v php 2>/dev/null)');
  lines.push('[ -n "$PHP" ] || cn_fail "PHP bulunamadi"');
  lines.push('cn_progress 12 "PHP: $PHP"');

  if (installVendor) {
    /*
     * Sunucuda composer.
     *
     * ⚠ CloudLinux'un varsayılan LVE bellek sınırı 1 GB ve composer bellek
     * canavarı; büyük projelerde OOM ile ölebiliyor. Bu yüzden varsayılan kip
     * bu DEĞİL — kullanıcı açıkça seçtiğinde koşuyor.
     */
    lines.push('COMPOSER=""');
    lines.push('for c in /opt/cpanel/composer/bin/composer /usr/local/bin/composer "$HOME/composer.phar"; do ' +
      '[ -x "$c" ] && COMPOSER="$c" && break; done');
    lines.push('[ -n "$COMPOSER" ] || COMPOSER=$(command -v composer 2>/dev/null)');
    lines.push('[ -n "$COMPOSER" ] || cn_fail "composer bulunamadi — vendor kipini auto yapin"');
    push(35, 'composer install',
      '"$PHP" -d memory_limit=-1 "$COMPOSER" install --no-dev --optimize-autoloader --no-interaction');
    lines.push('[ -f "$APPDIR/vendor/autoload.php" ] || cn_fail "composer install basarisiz"');
  } else {
    lines.push(`[ -f "$APPDIR/vendor/autoload.php" ] || cn_fail ${shq(t('laravel.vendorMissing'))}`);
  }

  const steps = artisanPlan({
    php: '"$PHP"',
    migrate: settings.migrate,
    optimize: settings.optimize,
    clean: settings.clean,
    keyGenerate,
  });

  let pct = 45;
  for (const step of steps) {
    pct = Math.min(92, pct + Math.floor(45 / steps.length));
    push(pct, step.label, step.cmd, step.fatal);
  }

  const result = await execViaWorker(ctx, lines.join('\n'), {
    label: t('laravel.title'),
    onProgress,
    onStart,
    timeout: 25 * 60_000,
  });
  ctx.client.log(result.output);
  return result;
}

/* ------------------------------------------------------------------- yedek */

async function makeLaravelBackup(ctx, appRoot) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = `${REMOTE.backupDir}/${appRoot.replace(/\//g, '_')}-${stamp}`;
  await remote.mkdirp(ctx.client, REMOTE.backupDir);
  await remote.copy(ctx.client, appRoot, dest);
  // `vendor` yedeğe girmiyor: kotayı doldurur ve composer.lock'tan yeniden
  // üretilebilir. Aynı gerekçe Next tarafında `node_modules` için geçerli.
  await remote.remove(ctx.client, `${dest}/vendor`, { required: false }).catch(() => {});
  return dest;
}

/* ------------------------------------------------------------- açıkta mı? */

const EXPOSURE_TARGETS = ['/.env', '/composer.json', '/artisan'];

/**
 * Kaynak dosyalar internetten okunabiliyor mu?
 *
 * Yalnızca durum koduna bakmak yetmez: bazı hostlar 200 ile bir hata sayfası
 * döndürüyor. `.env` için içerikte `APP_KEY`/`DB_` aranıyor, `composer.json`
 * için JSON'un kendisi.
 */
export async function checkExposure(domain, { timeout = 8000 } = {}) {
  const exposed = [];
  let checked = false;

  for (const target of EXPOSURE_TARGETS) {
    try {
      const res = await request(`https://${domain}${target}`, {
        timeout,
        rejectUnauthorized: false,
      });
      checked = true;
      if (res.status !== 200) continue;
      const body = String(res.text ?? '');
      if (target === '/.env' && /(APP_KEY|DB_PASSWORD|APP_ENV)\s*=/.test(body)) exposed.push(target);
      if (target === '/composer.json' && /"require"\s*:/.test(body)) exposed.push(target);
      if (target === '/artisan' && /Illuminate|#!\/usr\/bin\/env php/.test(body)) exposed.push(target);
    } catch {
      // Ulaşılamıyorsa bir şey İDDİA ETMİYORUZ: "açık değil" demek, DNS henüz
      // yayılmadığı için bağlanamadığımız durumda yanlış bir güvence olurdu.
    }
  }

  return { checked, exposed };
}

function hasBuildScript(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return Boolean(pkg.scripts?.build);
  } catch {
    return false;
  }
}
