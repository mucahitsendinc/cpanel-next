import fs from 'node:fs';
import path from 'node:path';
import { UserError, log } from '../ui.mjs';
import { t } from '../i18n/index.mjs';
import { mkdirp, abs, rel, extractZip, remove, exists } from '../remote.mjs';

/**
 * Paketi sunucuya taşır.
 *
 * SIRA:
 *   1. upload  — `Fileman::upload_files` (multipart). Tek istek, saf UAPI,
 *                token'la çalışır. Kullanıcıların çoğunda biten yol budur.
 *   2. ftp     — açıksa çok daha hızlı. Ama cPanel FTP'yi v86'dan beri
 *                VARSAYILAN KAPALI gönderiyor ("düz metin şifre" gerekçesiyle),
 *                bu yüzden birincil olamaz; yalnızca fırsatçı hızlı yol.
 *   3. split   — paket boyut sınırına takılıyorsa çok parçalı zip. Her parça
 *                ayrı yüklenir ve AYNI dizine açılır. Tamamen API ile çalışır;
 *                shell gerektirmez — stok cPanel'de tek uygulanabilir yedek.
 *
 * Not: "base64 parça + sunucuda birleştir" yöntemini KULLANMIYORUZ. Birleştirme
 * shell/PHP gerektirir; stok cPanel hesabında öyle bir yol yok. Çok parçalı zip
 * aynı sorunu saf API ile çözüyor.
 */

const SPLIT_TARGET_BYTES = 40 * 1024 * 1024;

export async function upload(ctx, { zipPath, remoteDir, onProgress, prefer = null }) {
  await mkdirp(ctx.client, remoteDir);

  const order = prefer ? [prefer] : ['upload', 'ftp'];
  let lastError = null;

  for (const strategy of order) {
    try {
      if (strategy === 'upload') {
        await uploadViaFileman(ctx, { zipPath, remoteDir, onProgress });
        return { strategy: 'upload' };
      }
      if (strategy === 'ftp') {
        if (!(await ftpAvailable(ctx))) continue;
        await uploadViaFtp(ctx, { zipPath, remoteDir, onProgress });
        return { strategy: 'ftp' };
      }
    } catch (err) {
      lastError = err;
      ctx.client.log(`${strategy} transport failed: ${err.message}`);
      if (isSizeError(err)) throw Object.assign(err, { code: 'TOO_LARGE' });
    }
  }

  throw lastError ?? new UserError(t('transport.failed'));
}

/* --------------------------------------------------------- Fileman upload */

/**
 * ⚠ Alan adı `file-1`, `file-2`, … biçiminde ARTAN olmalı (cPanel parametre
 * tablosu böyle diyor). cPanel'in kendi curl örneği `file=` kullanıyor ama
 * Perl ve PHP örnekleri `file-1`; tabloya uyuyoruz.
 *
 * ⚠ Bu işlev WHM proxy'sinden çağrılamaz — bizim yolumuz zaten doğrudan cPanel.
 */
async function uploadViaFileman(ctx, { zipPath, remoteDir, onProgress }) {
  const size = fs.statSync(zipPath).size;
  const result = await ctx.client.uapiUpload(
    'Fileman',
    'upload_files',
    { dir: abs(ctx.client, remoteDir) },
    [
      {
        field: 'file-1',
        filename: path.basename(zipPath),
        path: zipPath,
        contentType: 'application/zip',
      },
    ],
    {
      onProgress: onProgress
        ? ({ sent, total }) => onProgress({ sent, total: total || size })
        : undefined,
    }
  );

  const uploads = result?.uploads ?? result;
  const first = Array.isArray(uploads) ? uploads[0] : uploads;
  if (first && Number(first.status) === 0) {
    throw new UserError(t('transport.rejected', { reason: first.reason || t('transport.unknownReason') }));
  }

  // "Başarılı" yanıtına güvenmiyoruz; dosya gerçekten orada mı diye bakıyoruz.
  const target = `${rel(remoteDir)}/${path.basename(zipPath)}`;
  if (!(await exists(ctx.client, target))) {
    throw new UserError(t('transport.missingAfterUpload'));
  }
  return target;
}

function isSizeError(err) {
  return /too large|entity too large|max.*size|413/i.test(String(err?.message || ''));
}

/* ------------------------------------------------------------------- FTP */

async function ftpAvailable(ctx) {
  if (ctx.capabilities?.ftp !== undefined) return ctx.capabilities.ftp;
  let ok = false;
  try {
    const info = await ctx.client.uapi('Ftp', 'get_ftp_daemon_info', {});
    ok = Boolean(info?.type && info.type !== 'disabled');
  } catch {
    try {
      const name = await ctx.client.uapi('Ftp', 'server_name', {});
      ok = Boolean(name && !/disabled/i.test(String(name)));
    } catch {
      ok = false;
    }
  }
  if (ctx.capabilities) ctx.capabilities.ftp = ok;
  return ok;
}

/**
 * Geçici bir FTP hesabı açar, yükler, siler.
 *
 * ⚠ `disallowdot` VARSAYILAN 1'dir: adında nokta olan kullanıcı adları sessizce
 * kırpılır (`deploy.bot` → `deploybot`). Nokta kullanmıyoruz ki sürpriz olmasın.
 */
async function uploadViaFtp(ctx, { zipPath, remoteDir, onProgress }) {
  let ftp;
  try {
    ftp = await import('basic-ftp');
  } catch {
    throw new UserError(t('transport.ftpMissing'));
  }

  const suffix = Math.random().toString(36).slice(2, 8);
  const ftpUser = `cpnext${suffix}`;
  const ftpPass = randomPassword();

  await ctx.client.uapiPost('Ftp', 'add_ftp', {
    user: ftpUser,
    pass: ftpPass,
    homedir: rel(remoteDir),
    quota: 0,
    disallowdot: 0,
  });

  const client = new ftp.Client(120_000);
  try {
    await client.access({
      host: ctx.client.host,
      user: `${ftpUser}@${ctx.mainDomain ?? ctx.client.host}`,
      password: ftpPass,
      secure: true,
      secureOptions: { rejectUnauthorized: false },
    });
    if (onProgress) {
      const total = fs.statSync(zipPath).size;
      client.trackProgress((info) => onProgress({ sent: info.bytes, total }));
    }
    await client.uploadFrom(zipPath, path.basename(zipPath));
  } finally {
    client.close();
    // Geçici hesabı sil ve SİLİNDİĞİNİ DOĞRULA.
    try {
      await ctx.client.uapiPost('Ftp', 'delete_ftp', { user: ftpUser, destroy: 0 });
      const remaining = await ctx.client.uapi('Ftp', 'list_ftp', {}).catch(() => []);
      const rows = Array.isArray(remaining) ? remaining : Object.values(remaining || {});
      if (rows.some((r) => String(r.user || '').startsWith(ftpUser))) {
        log.warn(t('transport.ftpCleanupFailed', { user: ftpUser }));
      }
    } catch {
      log.warn(t('transport.ftpCleanupFailed', { user: ftpUser }));
    }
  }
}

function randomPassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*_-';
  let out = '';
  for (let i = 0; i < 24; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/* ----------------------------------------------------- çok parçalı yedek */

/**
 * Paketi birden çok zip'e böler, her birini ayrı yükleyip AYNI hedefe açar.
 *
 * Tek büyük yüklemeye izin vermeyen hostlar için (WHM "Max HTTP submission
 * size" düşürülmüş olabilir). Tamamen API ile çalışır: shell gerekmez.
 */
export async function uploadSplit(ctx, { cwd, files, extraFiles, remoteDir, targetDir, onProgress }) {
  const { makeZipFromList } = await import('../packager.mjs');
  await mkdirp(ctx.client, remoteDir);

  const groups = partition(cwd, files, SPLIT_TARGET_BYTES);
  log.info(t('transport.splitting', { count: groups.length }));

  for (let i = 0; i < groups.length; i += 1) {
    const isLast = i === groups.length - 1;
    const part = await makeZipFromList(cwd, groups[i], {
      extraFiles: isLast ? extraFiles : [],
      name: `part-${i}.zip`,
    });
    onProgress?.({ part: i + 1, parts: groups.length, phase: 'upload' });
    await uploadViaFileman(ctx, { zipPath: part.zipPath, remoteDir });
    onProgress?.({ part: i + 1, parts: groups.length, phase: 'extract' });
    await extractZip(ctx.client, `${rel(remoteDir)}/part-${i}.zip`, rel(targetDir));
    await remove(ctx.client, `${rel(remoteDir)}/part-${i}.zip`, { required: false });
    fs.rmSync(part.dir, { recursive: true, force: true });
  }

  return { strategy: 'split', parts: groups.length };
}

function partition(cwd, files, targetBytes) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const file of files) {
    let s = 0;
    try {
      s = fs.statSync(path.join(cwd, file)).size;
    } catch {
      /* yok sayılabilir */
    }
    if (size + s > targetBytes && current.length) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += s;
  }
  if (current.length) groups.push(current);
  return groups;
}
