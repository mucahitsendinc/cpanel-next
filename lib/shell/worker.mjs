import { randomBytes } from 'node:crypto';
import { UserError } from '../ui.mjs';
import { t } from '../i18n/index.mjs';
import * as remote from '../remote.mjs';

/**
 * Kalıcı iş görevlisi (worker).
 *
 * SORUN: her komut için tek seferlik cron eklemek, HER işte 0-60 saniye
 * bekleme demekti. İkinci ve sonraki deploy'larda bu, işin en uzun adımıydı.
 *
 * ÇÖZÜM: sunucuda sürekli yaşayan bir kabuk betiği bir iş klasörünü dinliyor;
 * iş bırakıldığında ~2 saniyede alıp çalıştırıyor. Cron artık işi tetiklemiyor,
 * yalnızca worker'ın ayakta olduğunu denetliyor.
 *
 * ÖLÇÜLDÜ — `setsid` ile ayrılan süreç, kendisini başlatan cron süreci
 * bittikten sonra da yaşıyor. Ama tek bir şart var:
 *
 *   ⚠ WORKER'I PHP ÜZERİNDEN BAŞLATMAYIN. PHP `shell_exec`, arka plana
 *     atılan çocuğun devraldığı boruyu beklediği için askıda kalıyor —
 *     `>/dev/null 2>&1 </dev/null &` yazmak bile kurtarmıyor. Bu yüzden
 *     cron, PHP'yi değil DOĞRUDAN launcher betiğini çağırıyor.
 *
 * DAYANIKLILIK:
 *   · cron satırı KALICI, hiç silinmiyor — crontab kabuktan düzenlenmiyor
 *   · launcher `pgrep` ile bakıyor; worker ölmüşse yeniden başlatıyor
 *   · worker'ın ömrü sınırlı, süresi dolunca kendini bitiriyor ve launcher
 *     bir sonraki turda yeniden açıyor (sonsuz süreç LVE limitlerinde birikir)
 */

export const WORKER_DIR = '.cpanel-next-worker';
/**
 * Betikler değiştiğinde BU SAYIYI ARTIRIN.
 *
 * Kurulum sürüm damgasına bakıp atlıyor; damga artmazsa sunucuda eski betik
 * kalır ve yeni davranış hiç devreye girmez. Geliştirme sırasında tam olarak
 * bu oldu: launcher yeniden yazıldı ama sunucudaki eski sürüm çalışmaya
 * devam etti.
 */
export const WORKER_VERSION = '6';

const JOBS = `${WORKER_DIR}/jobs`;
const RUNNING = `${WORKER_DIR}/running`;
const RESULTS = `${WORKER_DIR}/results`;
const BEAT_FRESH_MS = 20_000; // worker 2 sn'de bir vuruyor; 20 sn fazlasıyla tolerans

/**
 * Worker betiği.
 *
 * Saf POSIX sh — hesapta bash olmayabilir. JSON ayrıştırmıyor: iş dosyası
 * doğrudan çalıştırılabilir bir kabuk betiği ve durum dosyasını kendisi
 * yazıyor. Böylece worker'ın tek görevi "gördüğünü çalıştırmak".
 */
function workerScript(home) {
  return `#!/bin/sh
# cpanel-next worker v${WORKER_VERSION} — uzun ömürlü dinleyici
# Ters tırnak yerine $( ) : ikisi de POSIX, ama ters tırnak bu betiği üreten
# JS şablon değişmezini bozuyor.

DIR="${home}/${WORKER_DIR}"
JOBS="$DIR/jobs"
RUNNING="$DIR/running"
RESULTS="$DIR/results"
BEAT="$DIR/worker.beat"
VERFILE="$DIR/worker.version"
MYVER="${WORKER_VERSION}"
LIFE=3300

mkdir -p "$JOBS" "$RUNNING" "$RESULTS"
START=$(date +%s)

while : ; do
  date +%s > "$BEAT"

  # SÜRÜM DENETİMİ — kendi kendini emekliye ayırma.
  # Yeni sürüm kurulduğunda istemcinin sunucuda süreç öldürmesi gerekmesin
  # diye eski worker mismatch'i kendisi görüp çıkıyor; launcher bir sonraki
  # turda yenisini açıyor. Kullanıcıya hiçbir şey sorulmuyor.
  DISKVER=$(cat "$VERFILE" 2>/dev/null || echo "$MYVER")
  if [ "$DISKVER" != "$MYVER" ]; then
    echo "$(date '+%F %T') surum degisti ($MYVER -> $DISKVER), cikiliyor" >> "$DIR/worker.log"
    exit 0
  fi

  for JOB in "$JOBS"/*.sh ; do
    [ -e "$JOB" ] || continue
    ID=$(basename "$JOB" .sh)
    # Atomik sahiplenme: mv başarısızsa işi başkası almış.
    mv "$JOB" "$RUNNING/$ID.sh" 2>/dev/null || continue
    sh "$RUNNING/$ID.sh" >> "$RESULTS/$ID.out" 2>&1
    rm -f "$RUNNING/$ID.sh"
  done

  # Ömür sınırı: sonsuz yaşayan süreç LVE limitlerinde birikir. Süre dolunca
  # çıkıyoruz, launcher bir sonraki cron turunda yeniden açıyor.
  if [ $(expr $(date +%s) - $START) -ge $LIFE ]; then break; fi
  sleep 2
done
exit 0
`;
}

/**
 * Launcher — cron bunu DOĞRUDAN çağırıyor (PHP araya girmeden).
 *
 * Tek işi: worker ayakta mı diye bakmak, değilse `setsid` ile ayırıp
 * başlatmak. Hızlı çıkıyor, yani cron'u meşgul etmiyor.
 */
function launcherScript(home) {
  return `#!/bin/sh
# cpanel-next launcher v${WORKER_VERSION}
DIR="${home}/${WORKER_DIR}"
LOG="$DIR/worker.log"

# pgrep deseninde ilk harf köşeli parantezde: pgrep kendi komut satırını
# eşleştirmesin diye. Klasik ve gerekli.
# Sürüm damgası değiştiyse çalışan worker zaten kendini bitiriyor. Yine de
# donmuş bir süreç kalırsa (kalp atışı 3 dk'dan eski) burada öldürülüyor.
NOW=$(date +%s)
B=$(cat "$DIR/worker.beat" 2>/dev/null || echo 0)
if [ "$(expr "$NOW" - "$B" 2>/dev/null || echo 9999)" -gt 180 ]; then
  pkill -f "[c]panel-next-worker/worker.sh" 2>/dev/null
fi

if pgrep -f "[c]panel-next-worker/worker.sh" >/dev/null 2>&1 ; then
  exit 0
fi

echo "$(date '+%F %T') worker baslatiliyor" >> "$LOG"
cd "$DIR" || exit 1
setsid /bin/sh "$DIR/worker.sh" >> "$LOG" 2>&1 < /dev/null &

sleep 2
if pgrep -f "[c]panel-next-worker/worker.sh" >/dev/null 2>&1 ; then
  echo "$(date '+%F %T') worker acildi" >> "$LOG"
else
  echo "$(date '+%F %T') worker ACILAMADI" >> "$LOG"
fi

# Log şişmesin.
tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null
exit 0
`;
}

/**
 * İş betiği sarmalayıcısı.
 *
 * `cn_progress` ile ilerleme, `CN_OUT` ile çıktı biriktiriliyor. Betik ne
 * olursa olsun sonunda durum dosyasını yazıyor — hata hâlinde bile, yoksa
 * istemci sonsuza kadar bekler.
 */
export function wrapJob(id, body, home, { tolerant = false } = {}) {
  /*
   * ⚠ BİTİŞ DURUMU `trap` İLE YAZILIYOR.
   *
   * Eskiden `${body}`'den SONRAKİ satırdaydı ve şu hataya yol açıyordu:
   * gövde `exit` çağırırsa betik orada bitiyor, durum dosyası hiç
   * yazılmıyor ve istemci tarafındaki `pollResult` işin bittiğini asla
   * göremeyip 25 DAKİKALIK zaman aşımına kadar dönüyordu.
   *
   * Terminal bunu sıradan hâle getirdi (kullanıcı `exit` yazabilir) ama
   * hata her zaman vardı: `cn_fail` çağırmadan `exit` eden herhangi bir
   * gövde aynı şekilde askıda kalıyordu.
   *
   * `trap ... EXIT` betik nasıl biterse bitsin çalışıyor.
   */
  const finish = tolerant
    /*
     * HOŞGÖRÜLÜ KİP — terminal için.
     *
     * Kullanıcının komutunun sıfırdan farklı dönmesi NORMAL (`ls /yok`,
     * `grep` eşleşme bulamadı). Bunu iş hatası saymak, terminali her
     * başarısız komutta kırmızı bir hata kutusu gösterir hâle getirirdi.
     * Gerçek çıkış kodu zaten çıktının içindeki işaretlerde taşınıyor
     * (bkz. shell/session.mjs) ve orada gösteriliyor.
     */
    ? `printf '{"progress":100,"step":"done","done":true,"ok":true}' > "$STATUS"`
    : `if [ "$CN_CODE" = "0" ]; then
    printf '{"progress":100,"step":"done","done":true,"ok":true}' > "$STATUS"
  else
    printf '{"progress":100,"step":"error","done":true,"ok":false,"error":"cikis kodu %s"}' "$CN_CODE" > "$STATUS"
  fi`;

  return `#!/bin/sh
# cpanel-next job ${id}
STATUS="${home}/${RESULTS}/${id}.json"
CANCEL="${home}/${WORKER_DIR}/cancel/${id}"

# Durum yazıldı mı? cn_fail ve iptal kendi durumlarını yazıyor; trap onların
# üstüne yazmamalı, yoksa gerçek hata mesajı kaybolur.
CN_DONE=0
cn_finish() {
  CN_CODE=$?
  # Gövde kendi bitiş kancasını tanımladıysa (terminal oturumu işaretlerini
  # böyle yazıyor) ONU DA çağırıyoruz. Gövdenin kendi trap'ini kurması, tek
  # EXIT trap'i yüzünden bunu ezip durum dosyasının hiç yazılmamasına yol
  # açıyordu — canlıda görüldü.
  command -v cn_marks >/dev/null 2>&1 && cn_marks "$CN_CODE"
  [ "$CN_DONE" = "1" ] && return 0
  ${finish}
}
trap cn_finish EXIT

# İptal ADIM ARALARINDA denetleniyor — bilerek. Bir install-modules veya
# create çağrısını ortasından kesmek yarım kurulmuş bir uygulama bırakır;
# adım sınırı, durmanın güvenli olduğu tek yer.
cn_progress() {
  if [ -f "$CANCEL" ]; then
    rm -f "$CANCEL"
    CN_DONE=1
    printf '{"progress":100,"step":"cancelled","done":true,"ok":false,"cancelled":true,"error":"iptal edildi"}' > "$STATUS"
    exit 1
  fi
  printf '{"progress":%s,"step":"%s","done":false}' "$1" "$2" > "$STATUS"
}
cn_fail() {
  CN_DONE=1
  printf '{"progress":100,"step":"error","done":true,"ok":false,"error":"%s"}' "$1" > "$STATUS"
  exit 1
}

cn_progress 3 "Baslatildi"

${body}
`;
}

/* ------------------------------------------------------------------ kurulum */

/** Worker dosyaları ve kalıcı cron yerinde mi. Gerekirse kurar. */
export async function ensureWorker(ctx) {
  const home = `/home/${ctx.client.user}`;
  const installed = await remote
    .readFile(ctx.client, WORKER_DIR, 'worker.version')
    .catch(() => null);

  const filesPresent =
    (await remote.exists(ctx.client, `${WORKER_DIR}/worker.sh`)) &&
    (await remote.exists(ctx.client, `${WORKER_DIR}/launcher.sh`));

  if (String(installed ?? '').trim() !== WORKER_VERSION || !filesPresent) {
    for (const d of [WORKER_DIR, JOBS, RUNNING, RESULTS, `${WORKER_DIR}/cancel`]) {
      await remote.mkdirp(ctx.client, d);
    }
    await remote.saveFile(ctx.client, WORKER_DIR, 'worker.sh', workerScript(home));
    await remote.saveFile(ctx.client, WORKER_DIR, 'launcher.sh', launcherScript(home));
    // Sürüm dosyası EN SON: çalışan eski worker bunu görüp emekli oluyor,
    // ve o ana kadar yeni betikler zaten diskte hazır.
    await remote.saveFile(ctx.client, WORKER_DIR, 'worker.version', `${WORKER_VERSION}\n`);
  }

  await ensureCron(ctx, home);
  return true;
}

/**
 * Kalıcı watchdog cron'u.
 *
 * ⚠ Crontab'ı KABUKTAN düzenlemiyoruz. `crontab -l | grep -v X | crontab -`
 * kalıbı, `crontab -l` boş çıktığında tüm crontab'ı siler; üretimde 93
 * hesabın 93'ünde tam olarak bu olmuştu. Buradaki tek yazma işlemi API2
 * `Cron::add_line` ve yalnızca satır YOKSA çalışıyor.
 */
async function ensureCron(ctx, home) {
  const command = `/bin/sh ${home}/${WORKER_DIR}/launcher.sh`;

  const listed = await ctx.client.api2('Cron', 'listcron', {}).catch(() => null);
  const rows = Array.isArray(listed?.data) ? listed.data : Object.values(listed?.data ?? {});

  const isOurs = (r) => String(r.command ?? '').includes(`${WORKER_DIR}/`);
  const correct = rows.filter((r) => String(r.command ?? '').includes('launcher.sh'));
  if (correct.length) return false;

  /*
   * Eski sürümden kalan satırları temizle (worker.sh'yi doğrudan çağıranlar).
   *
   * ⚠ `Cron::remove_line` `linekey` DEĞİL, satır NUMARASI alıyor — ve bir satır
   * silinince sonrakilerin numarası kayıyor. Bu yüzden YÜKSEKTEN ALÇAĞA
   * siliyoruz. Numarayı da önbelleğe almıyoruz; liste hemen yukarıda alındı.
   */
  const stale = rows
    .map((r, i) => ({ r, line: i + 1 }))
    .filter(({ r }) => isOurs(r))
    .sort((a, b) => b.line - a.line);

  for (const { line } of stale) {
    await ctx.client.api2('Cron', 'remove_line', { line }).catch(() => {});
  }

  await ctx.client.api2('Cron', 'add_line', {
    command,
    /*
     * Dakikada bir. Launcher yalnızca bir `pgrep` yapıp çıkıyor, maliyeti yok
     * denecek kadar az. Beş dakikada bir olsaydı worker öldüğünde (veya ilk
     * kurulumda) beş dakikaya kadar beklenirdi.
     */
    minute: '*',
    hour: '*',
    day: '*',
    month: '*',
    weekday: '*',
  });
  return true;
}

/** Worker şu an canlı mı (kalp atışı taze mi). */
export async function isWorkerAlive(ctx) {
  const beat = await remote.readFile(ctx.client, WORKER_DIR, 'worker.beat').catch(() => null);
  if (!beat) return false;
  const seconds = Number(String(beat).trim());
  if (!Number.isFinite(seconds)) return false;
  return Date.now() - seconds * 1000 < BEAT_FRESH_MS;
}

/* ---------------------------------------------------------------- çalıştırma */

/**
 * Bir kabuk betiğini worker üzerinden çalıştırır.
 *
 * Worker canlıysa iş ~2 saniyede alınır. Canlı değilse tek seferlik cron ile
 * uyandırılıyor — o durumda eski davranışa (bir dakikaya kadar) düşülüyor,
 * ama bu yalnızca ilk çalıştırmada veya worker öldüyse oluyor.
 */
export async function execViaWorker(ctx, body, {
  onProgress,
  onStart,
  timeout = 25 * 60_000,
  label = 'job',
  fast = false,
  tolerant = false,
} = {}) {
  const home = `/home/${ctx.client.user}`;
  const id = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

  /*
   * ⚠ HIZLI KİP — TERMİNAL İÇİN. Ölçülerek eklendi.
   *
   * Normal yolda her komut ~14 ARDIŞIK cPanel çağrısı yapıyor:
   *   4 → ensureWorker (sürüm dosyası, iki `exists`, cron listesi)
   *   1 → kalp atışı
   *   1 → işi yaz
   *   2 → durum yoklaması
   *   1 → çıktıyı oku
   *   6 → temizlik (3 silme, her biri doğrulama listesiyle)
   *
   * Deploy için sorun değil (dakikalar süren bir işin yanında kaybolur) ama
   * terminalde her `ls` için 5-10 saniye demekti. Hızlı kip ikisini kesiyor:
   *
   *   · `ensureWorker` sonucu ctx'te önbelleğe alınıyor. Kurulum oturum
   *     başına bir kez gerçekten gerekli; sonrası aynı cevabı almak için
   *     ödenen dört tur.
   *   · Temizlik BEKLENMİYOR. Sonuç zaten okundu; geride kalan üç küçük
   *     dosyanın silinmesini kullanıcının beklemesi için bir sebep yok.
   */
  if (fast && ctx.capabilities?.workerReady) {
    // kurulum atlanıyor
  } else {
    await ensureWorker(ctx);
    if (ctx.capabilities) ctx.capabilities.workerReady = true;
  }

  const alive = await isWorkerAlive(ctx);
  await remote.saveFile(ctx.client, JOBS, `${id}.sh`, wrapJob(id, body, home, { tolerant }));

  // Canlı dinleyici varsa iş ~2 sn içinde alınır. Yoksa bir sonraki cron
  // turu bekleniyor (en fazla 60 sn) — uyandırmaya çalışmıyoruz çünkü
  // arka plan süreci bu kutuda hayatta kalmıyor (ölçüldü).
  if (!alive) onProgress?.(t('worker.waiting'), 0);
  onStart?.(id);

  return pollResult(ctx, id, { onProgress, timeout, label, detachCleanup: fast });
}

async function pollResult(ctx, id, { onProgress, timeout, label, detachCleanup = false }) {
  /*
   * Temizlik üç silme = üç `fileop` + üç doğrulama listesi, yani altı tur.
   * Hızlı kipte bunu BEKLEMİYORUZ: sonuç çoktan elimizde, geride kalan
   * küçük dosyaların silinmesi kullanıcının komutunu geciktirmemeli.
   * Hata yutuluyor — temizlik başarısızlığı komutun sonucunu değiştirmez.
   */
  const runCleanup = () => (detachCleanup
    ? void cleanup(ctx, id).catch(() => {})
    : cleanup(ctx, id));

  const deadline = Date.now() + timeout;
  let lastStep = '';
  let waited = 0;

  while (Date.now() < deadline) {
    /*
     * Worker canlıyken iş ~2 saniyede alınıyor.
     *
     * ⚠ TERMİNALDE İLK YOKLAMA ÇOK GEÇ KALIYORDU. 1500 ms + worker'ın 2 sn'lik
     * döngüsü, `ls` gibi anında biten bir komutta bile en az 3.5 saniye
     * demekti — kullanıcı ekranda "Baslatildi" görüp bekliyordu. Hızlı kipte
     * ilk on saniye 600 ms'de bir yokluyoruz; uzun süren işlerde aralık
     * kendiliğinden açılıyor, yani boşa çağrı birikmiyor.
     */
    const delay = detachCleanup
      ? (waited < 10_000 ? 600 : waited < 60_000 ? 2000 : 3000)
      : (waited < 30_000 ? 1500 : 3000);
    await sleep(delay);
    waited += delay;

    const status = await remote.readJson(ctx.client, RESULTS, `${id}.json`).catch(() => null);
    if (!status) continue;

    // Son durum adımları ("done"/"error") ilerleme değil, sonuçtur; ekrana
    // ilerleme satırı olarak düşerlerse gürültü yapıyorlar.
    if (status.step && status.step !== lastStep && !status.done) {
      lastStep = status.step;
      onProgress?.(status.step, status.progress ?? 0);
    }

    if (status.done) {
      const out = await remote.readFile(ctx.client, RESULTS, `${id}.out`).catch(() => '');
      await runCleanup();
      if (!status.ok) {
        /*
         * ⚠ ÇIKTININ SON SATIRLARI HATANIN İÇİNE KONUYOR.
         *
         * Eskiden `err.output` doldurulup hiç gösterilmiyordu: kullanıcı
         * "Laravel başarısız: APP_KEY" görüyor, komutun ne dediğini
         * göremiyordu. Sunucuda ne olduğunu söyleyen tek yer o çıktıydı.
         */
        const tail = String(out ?? '').trimEnd().split('\n').slice(-8).join('\n');
        const err = new UserError(
          status.cancelled
            ? t('worker.cancelled', { label })
            : t('cron.failed', { label, error: status.error || t('cron.unknownError') }),
          tail || undefined
        );
        err.output = out;
        err.cancelled = Boolean(status.cancelled);
        throw err;
      }
      return { ok: true, output: String(out ?? '') };
    }
  }

  await cleanup(ctx, id);
  throw new UserError(t('cron.timeout', { label, minutes: Math.round(timeout / 60000) }));
}

async function cleanup(ctx, id) {
  for (const p of [`${RESULTS}/${id}.json`, `${RESULTS}/${id}.out`, `${JOBS}/${id}.sh`]) {
    await remote.remove(ctx.client, p, { required: false }).catch(() => {});
  }
}

/**
 * Çalışan bir işi iptal eder.
 *
 * Bayrak dosyası bırakılıyor; iş bir sonraki ADIM SINIRINDA görüp duruyor.
 * Süreci öldürmüyoruz — bağımlılık kurulumunun ortasında kesilen bir uygulama
 * yarım kalır ve geri getirmesi zordur.
 */
export async function cancelJob(ctx, id) {
  await remote.mkdirp(ctx.client, `${WORKER_DIR}/cancel`);
  await remote.saveFile(ctx.client, `${WORKER_DIR}/cancel`, id, `${new Date().toISOString()}\n`);
  return true;
}

/** Kabuk komutunu iş gövdesine güvenle gömer. */
export function step(command, { progress = null, label = null } = {}) {
  const lines = [];
  if (progress !== null) {
    lines.push(`cn_progress ${Number(progress)} ${shq(label ?? 'Calisiyor')}`);
  }
  lines.push(command);
  return lines.join('\n');
}

/** Tek tırnaklı kabuk alıntısı. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
