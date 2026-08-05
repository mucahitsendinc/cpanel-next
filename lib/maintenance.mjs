import * as remote from './remote.mjs';

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
  let current = '';
  try {
    current = (await remote.readFile(client, dir, '.htaccess')) ?? '';
  } catch {
    current = '';
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
:root{--bg:#0f1115;--fg:#e6e8ee;--dim:#8b93a5;--accent:#4ea1ff;--line:#2a2f3a}
@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--fg:#1b1f27;--dim:#666e7d;--accent:#0b6bcb;--line:#dfe3ea}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;background:var(--bg);color:var(--fg);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:24px}
.card{max-width:520px;text-align:center}
.dot{width:10px;height:10px;border-radius:50%;background:var(--accent);display:inline-block;
  margin-right:8px;animation:p 1.4s ease-in-out infinite}
@keyframes p{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
h1{font-size:22px;margin:0 0 10px;letter-spacing:-.3px}
p{margin:0 0 8px;color:var(--dim)}
.domain{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:var(--fg)}
.foot{margin-top:26px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--dim)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
</style>
<script>
// Uygulama ayağa kalkınca sayfa kendini yeniler; bayrak silindiği an
// istek artık 503 almaz ve site geri gelir.
setTimeout(function(){ location.reload(); }, 15000);
</script>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>Site yenileniyor</h1>
    <p>Yeni sürüm yayına alınıyor. Bu işlem genellikle birkaç dakika sürer.</p>
    ${domain ? `<p class="domain">${escapeHtml(domain)}</p>` : ''}
    <p>Sayfa hazır olduğunda kendiliğinden yenilenecek.</p>
    <div class="foot">
      <a href="https://muco.tr" target="_blank" rel="noreferrer">deploymanager</a> ile yayınlanıyor
    </div>
  </div>
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
