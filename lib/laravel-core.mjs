import fs from 'node:fs';
import path from 'node:path';
import { buildProject, makeZip, ensureDependencies } from './packager.mjs';
import { upload } from './transport/index.mjs';
import * as remote from './remote.mjs';
import * as mysql from './mysql.mjs';
import { parseEnv, upsertEnv } from './envfile.mjs';
import { mergeMarked } from './htaccess.mjs';
import { buildOwnerMarker, writeOwnerMarker, readOwnerMarker } from './guards.mjs';
import { fingerprintList, writeRemoteManifest } from './delta.mjs';
import { normalizeHooks } from './hooks.mjs';
import { execViaWorker, shq } from './shell/worker.mjs';
import {
  installMaintenanceRule, enableMaintenance, disableMaintenance,
  BEGIN as MAINT_BEGIN, END as MAINT_END,
} from './maintenance.mjs';
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
    hooks: rawHooks = {},
  } = spec;

  /*
   * Hook tanımı yayına girmeden doğrulanıyor. Geçersiz bir satır yayını
   * DURDURMUYOR (kullanıcının build'i çoktan koştu) ama sessizce de
   * geçmiyor: hangi tanımın yok sayıldığı ekrana yazılıyor.
   */
  const { hooks, warnings: hookWarnings, count: hookCount } = normalizeHooks(rawHooks);

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

  for (const w of hookWarnings) emit('warn', 'deploy.hookInvalid', { detail: w });
  if (hookCount) emit('info', 'deploy.hooksPlanned', { count: hookCount });

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
      hooks,
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

  /*
   * Hızlı güncellemenin dayanağı — bkz. delta.mjs. Gönderdiğimiz dosyaların
   * parmak izi; bir sonraki güncelleme yalnızca değişenleri yollayabilsin.
   */
  await writeRemoteManifest(ctx.client, appRoot, fingerprintList(cwd, pkg.included));

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

  /* -- 13. Site gerçekten açılıyor mu? ------------------------------------ */
  let health = await siteHealth(ctx, { domain: target.domain, appRoot });

  if (health.checked && health.status >= 500) {
    emit('warn', 'laravel.unhealthy', { status: health.status });
    if (health.log) {
      // Ham PHP hatası — çevrilmiyor, olduğu gibi gösteriliyor.
      onEvent({ type: 'output', text: `\n${health.log.trimEnd()}\n` });
    } else if (health.logTooBig) {
      emit('info', 'laravel.logTooBig', {});
    } else {
      emit('info', 'laravel.noLog', {});
    }

    /*
     * Önbellek kaynaklı 500'lerin çoğu `optimize:clear` ile geçiyor. Denemek
     * bedava; işe yararsa kullanıcı 500 ile baş başa kalmıyor, yaramazsa da
     * elimizde zaten log var.
     */
    try {
      emit('step', 'laravel.recovering');
      await clearCachesForRecovery(ctx, { appRoot, domain: target.domain });
      const after = await siteHealth(ctx, { domain: target.domain, appRoot });
      if (after.checked && after.status < 500) {
        emit('warn', 'laravel.recovered', { status: after.status });
        health = { ...after, recovered: true };
      } else {
        emit('warn', 'laravel.recoverFailed', { status: after.status ?? '—' });
        health = { ...after, recovered: false };
      }
    } catch (err) {
      emit('warn', 'laravel.recoverFailed', { status: err.message });
    }
  }

  emit('done', 'deploy.published');
  return { url, backupPath, pkg, appRoot, vendor, exposure, health };
}

/* ----------------------------------------------------------------- .htaccess */

export async function ensureLaravelHtaccess(client, appRoot) {
  const current = (await remote.readFile(client, appRoot, '.htaccess').catch(() => null)) ?? '';
  /*
   * ⚠ BAKIM BLOĞUNUN ALTINDA KALMAK ZORUNDA.
   *
   * Laravel bloğu isteği `public/` içine yeniden yazıp `[L]` ile turu
   * bitiriyor; üstte olursa bakım kuralı hiç değerlendirilmiyor ve güncelleme
   * boyunca site bakım sayfası yerine 500 veriyor.
   */
  const next = mergeMarked(current, {
    begin: HT_BEGIN,
    end: HT_END,
    block: HT_BLOCK,
    after: { begin: MAINT_BEGIN, end: MAINT_END },
  });
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

/**
 * Site 5xx verdiğinde son çare: önbelleği tamamen boşalt.
 *
 * ⚠ BU BİR ONARIM, BİR TERCİH DEĞİL — ve sessiz değil.
 *
 * Canlıda şu yaşandı: yayın "başarılı" dedi, site 500 verdi, kullanıcı
 * cPanel Terminal'e girip elle `optimize:clear` çalıştırınca site açıldı.
 * Aracın yapabileceği bir şeyi kullanıcıya yaptırmak doğru değil.
 *
 * Yalnızca site GERÇEKTEN 5xx verirken koşuyor, yani normal bir yayında
 * hiç çalışmıyor. Çalıştığında da ekrana yazıyor: `config:cache` gitmiş
 * oluyor, site bir tık yavaşlıyor ve kullanıcının bunu bilmesi gerekiyor.
 */
async function clearCachesForRecovery(ctx, { appRoot, domain }) {
  const target = `/home/${ctx.client.user}/${appRoot}`;
  const candidates = await phpCandidates(ctx, domain);
  const lines = [
    `cd ${shq(target)} 2>/dev/null || exit 1`,
    'PHP=""',
    `for p in ${candidates.map(shq).join(' ')}; do [ -x "$p" ] && PHP="$p" && break; done`,
    '[ -n "$PHP" ] || PHP=$(command -v php 2>/dev/null)',
    '[ -n "$PHP" ] || exit 1',
    '"$PHP" artisan optimize:clear 2>&1',
  ];
  await execViaWorker(ctx, lines.join('\n'), {
    label: t('laravel.recovering'),
    timeout: 3 * 60_000,
  });
}

async function runServerSteps(ctx, {
  appRoot,
  domain,
  settings,
  installVendor,
  keyGenerate,
  hooks = {},
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

  /*
   * KULLANICININ KENDİ KOMUTLARI.
   *
   * Üç durak, Next tarafıyla AYNI adları taşıyor (`preInstall`,
   * `postInstall`, `postStart`) — böylece tek bir `.cpanel-next.json`
   * biçimi iki çatıya da yetiyor ve kullanıcı iki ayrı sözlük öğrenmiyor.
   * Laravel'deki karşılıkları:
   *
   *   preInstall  → dosyalar yerinde, composer HENÜZ koşmadı
   *   postInstall → vendor hazır, artisan HENÜZ başlamadı
   *   postStart   → her şey bitti (migration, önbellek, temizlik dahil)
   *
   * `$PHP` ve `$APPDIR` komutlara AÇIK: kullanıcının kendi artisan çağrısı
   * için doğru PHP sürümünü tahmin etmesi gerekmesin — `"$PHP" artisan …`
   * yazması yeterli.
   *
   * ⚠ ÖLÜMCÜL DEĞİLLER. Kullanıcının komutu başarısız olduğunda yayın
   * DEVAM ediyor: yarıda kesmek, dosyaları yüklenmiş ama artisan'ı koşmamış
   * bir uygulama bırakırdı — yani sitenin kendisini bozardı. Hata çıktısı
   * günlüğe yazılıyor.
   */
  /*
   * ⚠ KULLANICININ KOMUTU AYRI BIR KABUKTA, TIRNAKLANMIS OLARAK KOSUYOR.
   *
   * Ilk yazimda komut betige HAM gomuluyordu. Kapatilmamis tek bir tirnak
   * bütün yayin betigini sozdizimi hatasina dusururdu — yani kullanicinin
   * yazim hatasi, dosyalari yuklenmis ama artisan'i hic kosmamis bir
   * uygulama birakirdi.
   *
   * `sh -c '<komut>'` ile komut tek bir argumana kapaniyor: icindeki hata
   * yalnizca o komutu dusuruyor, betigin geri kalani saglam kaliyor.
   *
   * `PHP` ve `APPDIR` bu yuzden EXPORT ediliyor: alt kabuk yalnizca disa
   * aktarilmis degiskenleri goruyor ve kullanicinin `"$PHP" artisan ...`
   * yazabilmesi bu ikisine bagli.
   */
  lines.push('export PHP APPDIR');

  const runHooks = (stage, pct) => {
    const list = hooks?.[stage] ?? [];
    list.forEach((cmd, i) => {
      push(pct, `${stage}[${i + 1}]: ${cmd}`, `sh -c ${shq(cmd)}`, false);
    });
    return list.length;
  };

  runHooks('preInstall', 14);

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

  runHooks('postInstall', 40);

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

  // En son: kullanıcının "yayın bitince şunu da çalıştır" komutları.
  runHooks('postStart', 95);

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

/* ------------------------------------------------------------ site ayakta mı */

/*
 * Bundan büyük bir logu çekmiyoruz: `Fileman::get_file_content` aralık
 * desteklemiyor, yani "sonunu oku" diye bir şey yok — dosyanın TAMAMI
 * belleğe geliyor. `clean` açıkken log deploy sonunda sıfırlandığı için
 * buradaki dosya zaten küçük olur; kapalıysa devasa olabilir.
 */
const LOG_MAX_BYTES = 256 * 1024;
const LOG_TAIL_CHARS = 3000;

/**
 * Yayın bittikten sonra site gerçekten açılıyor mu?
 *
 * ⚠ BU ADIMIN VARLIK SEBEBİ: deploy "başarılı" diyor, site 500 veriyordu.
 *
 * Bütün sunucu adımları sırayla başarılı dönebilir ve site yine de açılmaz —
 * bozuk bir önbellek, eksik bir uzantı, `.env`'deki bir değer. Kullanıcıya
 * "yayınlandı" deyip onu tarayıcıda sürprizle karşılamak, hatayı da elle
 * aramaya bırakmak demekti.
 *
 * 5xx görürsek `laravel.log`'un SONUNU getiriyoruz: gerçek PHP hatası orada
 * ve kullanıcının cPanel'e girip dosyayı bulması gerekmiyor.
 */
async function siteHealth(ctx, { domain, appRoot, timeout = 20_000 }) {
  let status = null;
  try {
    const res = await request(`https://${domain}/`, { timeout, rejectUnauthorized: false });
    status = res.status;
  } catch {
    // Ulaşılamadı: DNS yayılmamış, sertifika yok, ağ kapalı olabilir. Bir şey
    // İDDİA ETMİYORUZ — "site bozuk" demek burada yanlış olurdu.
    return { checked: false, status: null, log: null };
  }

  if (!(status >= 500)) return { checked: true, status, log: null };

  let log = null;
  let logTooBig = false;
  try {
    const dir = `${appRoot}/storage/logs`;
    const entry = (await remote.list(ctx.client, dir)).find(
      (f) => f.name === 'laravel.log' && f.type !== 'dir'
    );
    if (entry && entry.size > LOG_MAX_BYTES) {
      logTooBig = true;
    } else if (entry && entry.size > 0) {
      const raw = await remote.readFile(ctx.client, dir, 'laravel.log');
      if (raw) log = String(raw).slice(-LOG_TAIL_CHARS);
    }
  } catch {
    // Log okunamadı. Durum kodunu yine de bildiriyoruz; o bile tek başına
    // "yayınlandı" demekten iyi.
  }

  return { checked: true, status, log, logTooBig };
}

function hasBuildScript(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return Boolean(pkg.scripts?.build);
  } catch {
    return false;
  }
}
