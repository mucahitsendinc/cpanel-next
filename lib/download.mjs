import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import * as remote from './remote.mjs';
import { execViaWorker, shq } from './shell/worker.mjs';
import { REMOTE } from './paths.mjs';
import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * Sunucudan dosya indirme.
 *
 * SORUN: cPanel'in UAPI'sinde indirme ucu YOK. `Fileman` modülünde
 * `get_file_content` var ama aralık/offset desteklemiyor ve JSON döndürdüğü
 * için ikili dosyada bozuluyor — cPanel'in kendi notu bile "JSON dizeleri
 * geçerli UTF-8 olmak zorunda" diyor. Klasik `/download?file=…` adresi ise
 * oturum çerezi istiyor, token kabul etmiyor.
 *
 * ÇÖZÜM: yüklemenin aynadaki hâli. Dosya sunucuda base64'e çevrilip parçalara
 * bölünüyor, parçalar `get_file_content` ile tek tek okunuyor, yerelde
 * birleştirilip çözülüyor. base64 %33 şişiriyor ama ikili güvenliği
 * garantiliyor ve her cPanel sürümünde çalışıyor.
 */

/** Parça boyutu. Daha büyüğü JSON yanıtını ve belleği zorluyor. */
const CHUNK = 3 * 1024 * 1024;

/**
 * Aktarılabilecek üst sınır.
 *
 * Bu yol her parça için bir HTTP turu demek; 200 MB'lık bir dosya ~90 tur ve
 * dakikalar sürer. Sessizce denemek yerine sınırı söyleyip cPanel'in kendi
 * indirme ekranına yönlendirmek dürüst olan.
 */
export const MAX_BYTES = 200 * 1024 * 1024;

/**
 * @param {object} ctx
 * @param {string} remotePath  ev dizinine göreli
 * @param {string} localPath   yerel hedef dosya
 */
export async function downloadFile(ctx, remotePath, localPath, { onProgress = () => {} } = {}) {
  const rel = remote.rel(remotePath);
  const info = await remote.list(ctx.client, path.posix.dirname(rel) || '.').catch(() => []);
  const entry = info.find((e) => e.name === path.posix.basename(rel));
  if (!entry) throw new UserError(t('download.notFound', { path: rel }));
  if (entry.size > MAX_BYTES) {
    throw new UserError(
      t('download.tooLarge', { size: entry.size, max: MAX_BYTES }),
      t('download.tooLargeHint')
    );
  }

  const id = `${Date.now().toString(36)}`;
  const stage = `${REMOTE.uploadDir}/dl-${id}`;
  const home = `/home/${ctx.client.user}`;

  onProgress({ phase: 'prepare' });
  await execViaWorker(
    ctx,
    [
      `cn_progress 10 ${shq('Dosya hazirlaniyor')}`,
      `mkdir -p ${shq(`${home}/${stage}`)} || cn_fail "gecici dizin olusturulamadi"`,
      // `base64 -w0` GNU'ya özgü; POSIX `base64` satır sarıyor ve bu sorun
      // değil — çözerken boşlukları atıyoruz.
      `base64 ${shq(`${home}/${rel}`)} > ${shq(`${home}/${stage}/b64`)} || cn_fail "base64 basarisiz"`,
      `cd ${shq(`${home}/${stage}`)} && split -b ${CHUNK} b64 part. && rm -f b64`,
      `cn_progress 40 ${shq('Parcalar hazir')}`,
    ].join('\n'),
    { label: t('download.title'), timeout: 15 * 60_000 }
  );

  const parts = (await remote.list(ctx.client, stage))
    .filter((e) => e.type === 'file' && e.name.startsWith('part.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!parts.length) throw new UserError(t('download.noParts'));

  let base64 = '';
  for (let i = 0; i < parts.length; i += 1) {
    const chunk = await remote.readFile(ctx.client, stage, parts[i].name);
    if (chunk === null) throw new UserError(t('download.partFailed', { part: parts[i].name }));
    base64 += chunk;
    onProgress({ phase: 'download', done: i + 1, total: parts.length });
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, Buffer.from(base64.replace(/\s+/g, ''), 'base64'));

  await remote.remove(ctx.client, stage, { required: false }).catch(() => {});

  const size = fs.statSync(localPath).size;
  /*
   * Boyut denetimi: base64 çözümü sessizce yarım kalabiliyor (bir parça eksik
   * okunursa). Sunucudaki boyutla karşılaştırmak bunu yakalar.
   */
  if (entry.size && Math.abs(size - entry.size) > 0) {
    throw new UserError(t('download.sizeMismatch', { expected: entry.size, got: size }));
  }

  return { path: localPath, size };
}

/* ------------------------------------------------------------ yerel taraf */

/**
 * İndirilenlerin gideceği klasör.
 *
 * `~/Downloads` beklenen yer; oraya yazamıyorsak ev dizinine düşüyoruz.
 * Alt klasör kullanmak, aracın bıraktığı dosyaların kullanıcının kendi
 * indirmelerine karışmamasını sağlıyor.
 */
export function downloadDir() {
  const base = path.join(os.homedir(), 'Downloads');
  const target = fs.existsSync(base) ? path.join(base, 'cpanel-next') : path.join(os.homedir(), 'cpanel-next');
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/** Dosya adı damgası — aynı yedeği iki kez almak birbirini ezmesin. */
export function stampName(name, ext = '') {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${name}-${stamp}${ext}`;
}

/**
 * Yol, aracın kendi indirme klasörünün altında mı?
 *
 * "Klasörde göster" ucu yerel makinede bir süreç başlatıyor. Serbest yol
 * kabul etseydi bu uç bir "her şeyi aç" aracına dönüşürdü. Ad temizlemek
 * yerine SINIRLIYORUZ — aracın her yerindeki kural.
 *
 * `resolve` şart: `~/Downloads/cpanel-next/../../.ssh` gibi bir yol
 * normalleştirilmeden karşılaştırılırsa önek denetimi kandırılabilir.
 */
export function isInsideDownloads(target, base = downloadDir()) {
  const full = path.resolve(String(target ?? ''));
  const root = path.resolve(base);
  return full === root || full.startsWith(root + path.sep);
}

/**
 * Dosyayı sistemin dosya yöneticisinde GÖSTERİR (seçili olarak açar).
 *
 * Açmıyor, GÖSTERİYOR: bir `.sql.gz` dosyasını açmak kullanıcının istediği şey
 * değil, nerede olduğunu görmek istiyor.
 */
export function revealInFileManager(target) {
  const full = path.resolve(target);
  if (!fs.existsSync(full)) throw new UserError(t('download.notOnDisk', { path: full }));

  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', full]]
      : process.platform === 'win32'
        ? ['explorer', [`/select,${full}`]]
        // Linux'ta "seçili göster" evrensel değil; klasörü açmak en yakını.
        : ['xdg-open', [path.dirname(full)]];

  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}
