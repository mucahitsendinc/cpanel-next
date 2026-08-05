import * as remote from './remote.mjs';
import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * Bakım modu.
 *
 * SORUN: uygulama durdurulduğunda ziyaretçi ham bir Passenger hatası görüyor.
 * Docroot'a `index.html` koymak İŞE YARAMAZ — docroot'ta Passenger
 * yapılandırması var, yani Apache her isteği Node uygulamasına devrediyor ve
 * statik dosyaya hiç bakmıyor.
 *
 * ÇÖZÜM: docroot `.htaccess`'ine, Passenger bloğunun ÜSTÜNE bir kural
 * ekliyoruz. Kural bir bayrak dosyasının varlığına bakıyor:
 *
 *   bayrak varsa  → 503 + bakım sayfası (Passenger'a hiç ulaşılmaz)
 *   bayrak yoksa  → kural hiç eşleşmez, uygulama normal çalışır
 *
 * Böylece bakım modunu açıp kapatmak tek bir dosya oluşturup silmek oluyor;
 * `.htaccess`'e her deploy'da dokunmak gerekmiyor.
 *
 * ⚠ CloudLinux'un yazdığı `# DO NOT REMOVE. CLOUDLINUX PASSENGER ...` bloğuna
 * ASLA dokunulmuyor — kendi bloğumuz onun üstüne ekleniyor.
 */

const BEGIN = '# cpanel-next maintenance BEGIN';
const END = '# cpanel-next maintenance END';
const FLAG = '.cpanel-next-maintenance';
const PAGE = 'cpanel-next-maintenance.html';

/*
 * 503 döndürmek bilinçli: arama motorları bunu geçici sayar, 404/500 gibi
 * kalıcı bir sorun sanmaz.
 *
 * ⚠ YALNIZCA evrensel yönergeler. Test kutusu LiteSpeed çalıştırıyor ve
 * Apache 2.4'e özgü `<If "-f ...">` ifade sözdizimi orada desteklenmiyor —
 * konsaydı bütün siteyi 500'e düşürebilirdi. `RewriteCond`/`RewriteRule` ve
 * `ErrorDocument` ikisinde de çalışıyor.
 */
const BLOCK = `${BEGIN}
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteCond %{DOCUMENT_ROOT}/${FLAG} -f
RewriteCond %{REQUEST_URI} !=/${PAGE}
RewriteRule ^ - [R=503,L]
</IfModule>
ErrorDocument 503 /${PAGE}
${END}`;

/** Docroot mutlak gelebilir; Fileman ev dizinine göreli yol bekliyor. */
function docrootRel(client, docroot) {
  const p = String(docroot || '').replace(/\/+$/, '');
  const home = `/home/${client.user}/`;
  if (p.startsWith(home)) return p.slice(home.length);
  return remote.rel(p);
}

/**
 * Sayfayı ve `.htaccess` kuralını kurar — bakım modunu AÇMAZ.
 *
 * Bunu deploy'un başında, build'den önce yapıyoruz. Sebebi ölçüldü:
 * LiteSpeed `.htaccess`'i kendi takviminde yeniden okuyor ve kuralı yazdıktan
 * 3 saniye sonra hâlâ görmemişti. Build birkaç dakika sürdüğü için kuralı
 * erken yazmak, durdurma anında hazır olmasını sağlıyor.
 *
 * Bayrak dosyasının kendisi ANINDA etkili (ölçüldü: <1 sn), çünkü
 * `RewriteCond -f` her istekte değerlendiriliyor.
 */
export async function installMaintenanceRule(client, docroot, { domain, html } = {}) {
  const dir = docrootRel(client, docroot);
  if (!dir) return false;
  await remote.saveFile(client, dir, PAGE, html ?? renderPage({ domain }));
  return ensureHtaccessBlock(client, dir);
}

/** Bakım modunu açar. Kural zaten kurulu olmalı (bkz. installMaintenanceRule). */
export async function enableMaintenance(client, docroot, { domain, html } = {}) {
  const dir = docrootRel(client, docroot);
  if (!dir) return false;

  // Sayfa ve kural yoksa burada da kuruyoruz; ama o durumda LiteSpeed'in
  // kuralı görmesi gecikebilir.
  await installMaintenanceRule(client, docroot, { domain, html });
  await remote.saveFile(client, dir, FLAG, `${new Date().toISOString()}\n`);
  return true;
}

export async function disableMaintenance(client, docroot) {
  const dir = docrootRel(client, docroot);
  if (!dir) return false;
  // Yalnızca bayrağı siliyoruz. Kural ve sayfa yerinde kalıyor — bayrak
  // yokken tamamen etkisizler ve her deploy'da `.htaccess`'i yeniden
  // düzenlemek, Passenger bloğuna dokunma riskini boşuna tekrarlardı.
  return remote.remove(client, `${dir}/${FLAG}`, { required: false });
}

export async function isMaintenanceOn(client, docroot) {
  const dir = docrootRel(client, docroot);
  return remote.exists(client, `${dir}/${FLAG}`);
}

/**
 * Kuralı `.htaccess`'in BAŞINA ekler (varsa dokunmaz).
 *
 * Başa eklemek şart: Passenger bloğu isteği uygulamaya devrediyor, bizim
 * kuralımız ondan sonra gelirse hiç çalışmaz.
 */
async function ensureHtaccessBlock(client, dir) {
  const exists = await remote.exists(client, `${dir}/.htaccess`);

  /*
   * ⚠ Dosya VARSA ama okunamıyorsa YAZMIYORUZ.
   *
   * Önceki hâli okuma hatasını boş içerik sayıyordu ve dosyayı yalnızca kendi
   * bloğumuzla eziyordu — yani geçici bir API hatası, docroot'taki Passenger
   * yapılandırmasını (ve PHP handler'ını) yok edip siteyi indirebilirdi.
   * Bilmediğimiz bir içeriğin üzerine yazmaktansa bakım sayfasından vazgeçmek
   * her zaman daha doğru.
   */
  let current = '';
  if (exists) {
    current = await remote.readFile(client, dir, '.htaccess').catch(() => null);
    if (current === null || current === undefined) {
      throw new UserError(t('maintenance.htaccessUnreadable', { dir }));
    }
  }

  if (current.includes(BEGIN)) return false;
  await remote.saveFile(client, dir, '.htaccess', `${BLOCK}\n\n${current}`);
  return true;
}

/** Bakım sayfası — tek dosya, dış kaynak yok, koyu/açık temaya uyumlu. */
export function renderPage({ domain = '' } = {}) {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Yenileniyor…</title>
<style>
:root{
  --bg:#0b0d12; --card:#12151d; --fg:#eef1f7; --dim:#8992a6;
  --accent:#5aa2ff; --accent2:#7ee0c0; --line:#232838;
}
@media(prefers-color-scheme:light){
  :root{--bg:#f4f6fa;--card:#fff;--fg:#161a22;--dim:#5f6879;--accent:#0b6bcb;--accent2:#0f9b76;--line:#e2e7f0}
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{
  background:var(--bg);color:var(--fg);display:grid;place-items:center;padding:24px;
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  overflow:hidden;
}
/* Arkada yavaşça dönen yumuşak ışık — sayfa "canlı" hissettirsin. */
body::before{
  content:"";position:fixed;inset:-40vmax;z-index:0;
  background:
    radial-gradient(38vmax 38vmax at 30% 35%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 60%),
    radial-gradient(30vmax 30vmax at 70% 65%, color-mix(in srgb, var(--accent2) 18%, transparent), transparent 60%);
  animation:drift 18s ease-in-out infinite alternate;
  filter:blur(8px);
}
@keyframes drift{from{transform:translate3d(-3%,-2%,0) rotate(0deg)}to{transform:translate3d(3%,2%,0) rotate(12deg)}}
.card{
  position:relative;z-index:1;max-width:520px;width:100%;
  background:color-mix(in srgb, var(--card) 88%, transparent);
  border:1px solid var(--line);border-radius:18px;padding:38px 34px;
  box-shadow:0 24px 60px rgba(0,0,0,.28);
  backdrop-filter:blur(14px);text-align:center;
}
.spinner{width:44px;height:44px;margin:0 auto 22px;position:relative}
.spinner span{
  position:absolute;inset:0;border-radius:50%;
  border:3px solid transparent;border-top-color:var(--accent);
  animation:spin 1.1s cubic-bezier(.5,.1,.5,.9) infinite;
}
.spinner span:nth-child(2){inset:7px;border-top-color:var(--accent2);animation-duration:1.6s;animation-direction:reverse}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:23px;margin:0 0 10px;letter-spacing:-.4px;font-weight:650}
p{margin:0 0 8px;color:var(--dim);font-size:15px}
.domain{
  display:inline-block;margin:14px 0 4px;padding:6px 14px;border-radius:999px;
  border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 60%, transparent);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--fg);
}
.bar{height:3px;border-radius:3px;background:var(--line);overflow:hidden;margin:24px 0 6px}
.bar i{display:block;height:100%;width:35%;border-radius:3px;
  background:linear-gradient(90deg,var(--accent),var(--accent2));animation:slide 1.8s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}
.status{font-size:12.5px;color:var(--dim);min-height:18px}
.foot{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--dim)}
a{color:var(--accent);text-decoration:none;font-weight:550}
a:hover{text-decoration:underline}
@media(prefers-reduced-motion:reduce){
  body::before,.spinner span,.bar i{animation:none}
}
</style>
</head>
<body>
  <div class="card">
    <div class="spinner"><span></span><span></span></div>
    <h1>Site yenileniyor</h1>
    <p>Yeni sürüm yayına alınıyor. Genellikle birkaç dakika sürer.</p>
    ${domain ? `<div class="domain">${escapeHtml(domain)}</div>` : ''}
    <div class="bar"><i></i></div>
    <div class="status" id="s">hazır olduğunda bu sayfa kendiliğinden açılacak</div>
    <div class="foot">
      <a href="https://muco.tr" target="_blank" rel="noreferrer">deploymanager</a> ile yayınlanıyor
    </div>
  </div>
<script>
/*
 * SANİYEDE BİR yoklama.
 *
 * Bakım modundayken sunucu her isteğe 503 dönüyor. 503 dönmemeye başladığı
 * an uygulama ayağa kalkmış demektir; sayfayı hemen yeniliyoruz. Sabit
 * aralıklı kör yenileme yerine bu, biter bitmez tepki veriyor.
 *
 * Kendi adresimizi yokluyoruz ama HEAD ile ve önbelleği atlayarak; aksi
 * hâlde tarayıcı eski 503'ü tekrar tekrar okurdu.
 */
(function () {
  var el = document.getElementById('s');
  var tries = 0;
  function check() {
    tries++;
    fetch(location.pathname + '?_=' + Date.now(), { method: 'HEAD', cache: 'no-store' })
      .then(function (r) {
        if (r.status !== 503) { el.textContent = 'hazır, açılıyor…'; location.reload(); return; }
        el.textContent = 'yayına alınıyor… (' + tries + ' sn)';
      })
      .catch(function () { el.textContent = 'sunucuya ulaşılamıyor, tekrar denenecek…'; });
  }
  setInterval(check, 1000);
  check();
})();
</script>
</body>
</html>
`;
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

export { FLAG, PAGE, BEGIN, END };
