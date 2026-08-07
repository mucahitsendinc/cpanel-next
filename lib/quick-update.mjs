import fs from 'node:fs';
import path from 'node:path';
import { makeZipFromList, buildProject, ensureDependencies } from './packager.mjs';
import { upload } from './transport/index.mjs';
import * as remote from './remote.mjs';
import { readOwnerMarker } from './guards.mjs';
import { resolveExcludes } from './deployignore.mjs';
import { loadProjectConfig } from './config.mjs';
import { LARAVEL_EXCLUDES, composerLockHash } from './laravel.mjs';
import {
  fingerprint,
  diffManifest,
  uploadList,
  hasWork,
  readRemoteManifest,
  writeRemoteManifest,
} from './delta.mjs';
import { REMOTE } from './paths.mjs';
import { t } from './i18n/index.mjs';
import { UserError } from './ui.mjs';

/**
 * HIZLI GÜNCELLEME — yalnızca değişen dosyalar.
 *
 * Tam yayın her seferinde her şeyi paketleyip yüklüyor ve sunucudaki kod
 * dizinlerini silip yeniden açıyor. Doğru ama pahalı: tek satır değişse de
 * yüz megabayt gidiyor.
 *
 * Burada dayanak, en son gönderdiğimiz dosyaların parmak izi (`delta.mjs`,
 * her yayın sonunda sunucuya yazılıyor). Yerel liste yeniden hesaplanıp
 * karşılaştırılıyor; yalnızca içeriği değişenler, yeniler ve yerelde
 * silinmiş olanlar işleme giriyor.
 *
 * ⚠ `cleanDir` YOK. Tam yayının "önce sil, sonra aç" adımı burada bilerek
 * atlanıyor — zaten amaç sunucudaki her şeyi yeniden yazmamak. Silme
 * yalnızca manifestte olup artık gönderilmeyen dosyalar için.
 */

/** Hızlı güncellemenin reddedildiği durumlar — hepsi kullanıcıya açıklanıyor. */
export function quickUpdateBlocker({ manifest, marker, localLock, framework }) {
  /*
   * Manifest yoksa sunucuda NE OLDUĞUNU bilmiyoruz. Delta göndermek, orada
   * artık yerelde bulunmayan dosyaları sonsuza kadar bırakmak demek olurdu.
   */
  if (!manifest) return 'noManifest';

  /*
   * Kilit dosyası değiştiyse bağımlılıklar değişmiş. Kurulum tam yayının
   * işi: hızlı güncelleme `composer install` / `npm install` koşturmuyor ve
   * eksik bir bağımlılıkla siteyi düşürmek burada olmamalı.
   */
  if (framework === 'laravel' && localLock && marker?.composerLock && localLock !== marker.composerLock) {
    return 'lockChanged';
  }

  return null;
}

/**
 * @param {object} ctx
 * @param {object} spec  { cwd, project, appRoot, domain, framework, build }
 */
export async function runQuickUpdate(ctx, spec, onEvent = () => {}) {
  const { cwd, project, appRoot, domain, framework = 'next', build = true } = spec;
  const emit = (type, key, params = {}) => onEvent({ type, key, params, text: t(key, params) });

  /* -- 1. Derle ----------------------------------------------------------- */
  /*
   * Derleme ÖNCE koşuyor: değişiklik listesi derlenmiş çıktıyı da kapsamalı,
   * yoksa kaynak değişip çıktı eski kalır ve site güncellenmemiş görünür.
   */
  if (build && hasBuildScript(cwd)) {
    const output = (chunk) => onEvent({ type: 'output', text: chunk });
    await ensureDependencies(cwd, {
      packageManager: project?.packageManager ?? 'npm',
      onOutput: output,
      onStep: (pm) => emit('step', 'packager.installing', { pm }),
    });
    emit('step', 'deploy.building');
    await buildProject(cwd, {
      packageManager: project?.packageManager ?? 'npm',
      onOutput: output,
      expectFiles: framework === 'laravel'
        ? ['public/build/manifest.json', 'public/build/.vite/manifest.json', 'public/mix-manifest.json']
        : ['.next/BUILD_ID'],
    });
  }

  /* -- 2. Karşılaştır ----------------------------------------------------- */
  emit('step', 'quick.comparing');

  const cfg = loadProjectConfig(cwd) ?? {};
  const base = framework === 'laravel' ? LARAVEL_EXCLUDES : undefined;
  const { excludes } = resolveExcludes(cwd, { base, projectExclude: cfg.exclude ?? null });

  const [manifest, marker] = await Promise.all([
    readRemoteManifest(ctx.client, appRoot),
    readOwnerMarker(ctx.client, appRoot).catch(() => null),
  ]);

  const localLock = framework === 'laravel' ? composerLockHash(cwd) : null;
  const blocker = quickUpdateBlocker({ manifest, marker, localLock, framework });
  if (blocker) throw new UserError(t(`quick.${blocker}`), t(`quick.${blocker}Hint`));

  const local = fingerprint(cwd, { excludes, allowEnv: framework === 'laravel' ? ['.env.example'] : [] });
  const diff = diffManifest(manifest, local.files);

  if (!hasWork(diff)) {
    emit('done', 'quick.noChanges');
    return { url: `https://${domain}`, changed: 0, added: 0, removed: 0, skipped: diff.unchanged };
  }

  const send = uploadList(diff);
  emit('info', 'quick.plan', {
    changed: diff.changed.length,
    added: diff.added.length,
    removed: diff.removed.length,
    same: diff.unchanged,
  });

  /* -- 3. Gönder ---------------------------------------------------------- */
  const runId = Date.now().toString(36);
  const uploadDir = `${REMOTE.uploadDir}/${runId}`;

  if (send.length) {
    emit('step', 'deploy.packing');
    const pkg = await makeZipFromList(cwd, send);
    ctx.cleanup?.push(async () => fs.rmSync(pkg.dir, { recursive: true, force: true }));

    emit('step', 'deploy.uploading');
    await upload(ctx, {
      zipPath: pkg.zipPath,
      remoteDir: uploadDir,
      onProgress: ({ sent, total }) => onEvent({ type: 'progress', sent, total }),
    });

    // ⚠ cleanDir YOK — üzerine açılıyor.
    emit('step', 'deploy.extracting');
    await remote.extractZip(ctx.client, `${uploadDir}/pkg.zip`, appRoot);
    await remote.remove(ctx.client, uploadDir, { required: false }).catch(() => {});
  }

  /* -- 4. Yerelde silinenler ---------------------------------------------- */
  /*
   * Yalnızca MANİFESTTE olanlar siliniyor. Sunucuda üretilmiş dosyalar
   * (yüklemeler, loglar, önbellek) hiçbir manifestte yer almadığı için
   * dokunulmuyor.
   */
  if (diff.removed.length) {
    emit('step', 'quick.removing', { count: diff.removed.length });
    await remote.removeMany(
      ctx.client,
      diff.removed.map((f) => `${appRoot}/${f}`),
      { verify: false }
    );
  }

  /* -- 5. Yeni parmak izi -------------------------------------------------- */
  await writeRemoteManifest(ctx.client, appRoot, local.files);

  emit('done', 'quick.done', {
    changed: diff.changed.length,
    added: diff.added.length,
    removed: diff.removed.length,
  });

  return {
    url: `https://${domain}`,
    changed: diff.changed.length,
    added: diff.added.length,
    removed: diff.removed.length,
    skipped: diff.unchanged,
  };
}

function hasBuildScript(cwd) {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts?.build);
  } catch {
    return false;
  }
}
