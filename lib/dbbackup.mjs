import path from 'node:path';
import * as mysql from './mysql.mjs';
import * as remote from './remote.mjs';
import { execViaWorker, shq } from './shell/worker.mjs';
import { downloadFile, downloadDir, stampName } from './download.mjs';
import { REMOTE } from './paths.mjs';
import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * Veritabanı yedeği.
 *
 * cPanel'in UAPI'sinde tek bir veritabanını dışa aktaran bir uç YOK —
 * `Mysql::dump_database_schema` yalnızca şemayı veriyor, veriyi vermiyor.
 * `Backup::fullbackup_to_homedir` ise hesabın TAMAMINI alıyor: saatler
 * sürebiliyor, kotayı doldurabiliyor ve "şu veritabanını indir" isteğine
 * verilecek cevap değil.
 *
 * Bu yüzden `mysqldump` kabuktan koşuyor (worker zaten her iki rejimde de
 * çalışıyor).
 *
 * ⚠ ŞİFRE KOMUT SATIRINA YAZILMIYOR. `mysqldump -pSIFRE` paylaşımlı bir
 * sunucuda `ps` çıktısında herkese görünür. Bunun yerine 0600 izinli geçici
 * bir `--defaults-extra-file` yazılıyor ve iş biter bitmez siliniyor.
 */

/** Yedek için açılan geçici MySQL kullanıcısının ad öneki. */
const TEMP_PREFIX = 'bk';

/**
 * Veritabanını sunucuda dışa aktarır ve yerele indirir.
 *
 * Geçici bir MySQL kullanıcısı açılıyor çünkü var olan kullanıcıların şifresi
 * bizde YOK ve cPanel de göstermiyor. Kullanıcı iş biter bitmez siliniyor —
 * hata hâlinde de.
 */
export async function dumpDatabase(ctx, database, { onProgress = () => {} } = {}) {
  const home = `/home/${ctx.client.user}`;
  const stage = `${REMOTE.uploadDir}/dump-${Date.now().toString(36)}`;
  const remoteFile = `${stage}/${database}.sql.gz`;

  const restrictions = await mysql.getRestrictions(ctx.client);
  const tempUser = mysql.withPrefix(restrictions.prefix, `${TEMP_PREFIX}${randomSuffix()}`);
  const tempPass = mysql.generatePassword(28);

  let created = false;
  try {
    onProgress({ phase: 'user' });
    await mysql.createUser(ctx.client, tempUser, tempPass);
    created = true;
    await mysql.grantAll(ctx.client, tempUser, database);

    onProgress({ phase: 'dump' });
    await execViaWorker(
      ctx,
      [
        `cn_progress 15 ${shq('Yedek aliniyor')}`,
        `mkdir -p ${shq(`${home}/${stage}`)} || cn_fail "gecici dizin olusturulamadi"`,
        `CNF=${shq(`${home}/${stage}/my.cnf`)}`,
        // Önce 0600, SONRA içerik: dosya bir an bile herkese okunur olmasın.
        `: > "$CNF" && chmod 600 "$CNF"`,
        `printf '[client]\\nuser=%s\\npassword=%s\\nhost=127.0.0.1\\n' ${shq(tempUser)} ${shq(tempPass)} > "$CNF"`,
        `MD=$(command -v mysqldump 2>/dev/null || echo /usr/bin/mysqldump)`,
        `[ -x "$MD" ] || cn_fail ${shq(t('dbbackup.noMysqldump'))}`,
        `cn_progress 40 ${shq('mysqldump')}`,
        `"$MD" --defaults-extra-file="$CNF" --single-transaction --quick --routines --events ` +
          `--default-character-set=utf8mb4 ${shq(database)} | gzip -9 > ${shq(`${home}/${remoteFile}`)} ` +
          `|| cn_fail ${shq(t('dbbackup.dumpFailed'))}`,
        `rm -f "$CNF"`,
        `[ -s ${shq(`${home}/${remoteFile}`)} ] || cn_fail ${shq(t('dbbackup.empty'))}`,
        `cn_progress 70 ${shq('Yedek hazir')}`,
      ].join('\n'),
      { label: t('dbbackup.title'), timeout: 20 * 60_000, onProgress: (step, pct) => onProgress({ phase: 'remote', step, pct }) }
    );

    onProgress({ phase: 'transfer' });
    const local = path.join(downloadDir(), stampName(database, '.sql.gz'));
    const result = await downloadFile(ctx, remoteFile, local, {
      onProgress: (p) => onProgress({ phase: 'transfer', ...p }),
    });

    return result;
  } finally {
    /*
     * Temizlik HER durumda. Yarıda kalan bir yedek, geride tam yetkili bir
     * MySQL kullanıcısı ve düz metin şifre içeren bir dosya bırakmamalı.
     */
    if (created) await mysql.deleteUser(ctx.client, tempUser).catch(() => {});
    await remote.remove(ctx.client, stage, { required: false }).catch(() => {});
  }
}

/**
 * Sunucudaki bir klasörü arşivleyip indirir.
 *
 * Tek tek dosya indirmek yerine arşivlemek bilinçli: 5.000 dosyalık bir
 * `public/uploads` için tek tek indirme binlerce HTTP turu demek.
 */
export async function archiveAndDownload(ctx, targetPath, { onProgress = () => {} } = {}) {
  const home = `/home/${ctx.client.user}`;
  const rel = remote.rel(targetPath);
  if (!rel) throw new UserError(t('download.pathRequired'));

  const stage = `${REMOTE.uploadDir}/arc-${Date.now().toString(36)}`;
  const base = path.posix.basename(rel) || 'home';
  const remoteFile = `${stage}/${base}.tar.gz`;

  try {
    await execViaWorker(
      ctx,
      [
        `cn_progress 15 ${shq('Arsiv olusturuluyor')}`,
        `mkdir -p ${shq(`${home}/${stage}`)} || cn_fail "gecici dizin olusturulamadi"`,
        // `-C` ile üst dizine geçip yalnızca hedefi arşivliyoruz; yoksa arşiv
        // içinde `/home/kullanici/...` diye gereksiz bir ağaç oluşuyor.
        `tar -czf ${shq(`${home}/${remoteFile}`)} -C ${shq(path.posix.dirname(`${home}/${rel}`))} ${shq(base)} ` +
          `|| cn_fail ${shq(t('download.archiveFailed'))}`,
        `cn_progress 55 ${shq('Arsiv hazir')}`,
      ].join('\n'),
      { label: t('download.title'), timeout: 20 * 60_000, onProgress: (step, pct) => onProgress({ phase: 'remote', step, pct }) }
    );

    const local = path.join(downloadDir(), stampName(base, '.tar.gz'));
    return await downloadFile(ctx, remoteFile, local, {
      onProgress: (p) => onProgress({ phase: 'transfer', ...p }),
    });
  } finally {
    await remote.remove(ctx.client, stage, { required: false }).catch(() => {});
  }
}

function randomSuffix() {
  // Kısa tutuluyor: MySQL kullanıcı adı sınırı bazı sürümlerde 16 karakter ve
  // önek zaten yerin çoğunu alıyor.
  return Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
}
