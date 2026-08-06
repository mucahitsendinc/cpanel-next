import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Masaüstü kabuğu.
 *
 * Bu dosya YENİ BİR UYGULAMA DEĞİL, var olanın penceresi. `deploymanager ui`
 * zaten 127.0.0.1'de bir sunucu açıp tarayıcıyı ona yönlendiriyordu; burada
 * aynı sunucu Electron'un ana sürecinde başlıyor ve bir pencerede
 * gösteriliyor. Arayüz kodu, API'ler, güvenlik katmanları — hepsi aynı.
 *
 * Yani masaüstü sürümünün kendi iş mantığı yok ve olmamalı: iki ön yüzün
 * ayrışması, birinde düzeltilen bir davranışın diğerinde kalması demek olurdu.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Sunucu, pencere hazır olmadan da ayakta kalsın diye modül kapsamında. */
let server = null;
let window = null;

/*
 * TEK ÖRNEK.
 *
 * İkinci bir kopya ikinci bir sunucu ve ikinci bir kasa açardı; aynı
 * `config.json`a iki süreç yazmaya kalkarsa kayıt bozulabilir. İkinci
 * çalıştırma var olan pencereyi öne getiriyor.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(start).catch(fatal);
}

async function start() {
  /*
   * Sunucu `app-lib/` içinden geliyor — derleme öncesi `sync.mjs` tarafından
   * üst dizinden kopyalanıyor (bkz. o dosyadaki gerekçe: `file:..` symlink'i
   * uygulamanın kendi kendini paketlemesine yol açıyordu).
   *
   * Yol `file://` olarak veriliyor: ESM `import()` çıplak yolları paket adı
   * sanıyor ve asar arşivinin içinde bu fark ediyor.
   */
  const { startServer } = await import(new URL('./app-lib/ui-server/server.mjs', import.meta.url).href);

  server = await startServer({ port: 0 });

  window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'cpanel-next',
    backgroundColor: '#0e1014',
    // Sayfa yüklenene kadar boş beyaz bir pencere göstermemek için.
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      /*
       * ⚠ Sayfa bir WEB SAYFASI olarak kalıyor.
       *
       * `nodeIntegration` kapalı, `contextIsolation` açık: arayüz koduna
       * Node yetkisi verilmiyor. Sayfanın sunucuyla konuşma yolu zaten
       * mevcut HTTP API'si ve o API oturum jetonu istiyor. Masaüstü sürüm
       * olduk diye o katmanı atlamak, tarayıcıda olmayan bir saldırı yüzeyi
       * açardı.
       */
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  /*
   * Sayfaya HANGİ KABUKTA olduğunu söylüyoruz.
   *
   * Aynı HTML hem tarayıcıda hem burada çalışıyor. Pencere sürükleme alanı ve
   * trafik ışıklarına bırakılan boşluk YALNIZCA masaüstünde anlamlı; tarayıcıda
   * uygulanırsa sol üstte sebepsiz bir boşluk oluşur.
   *
   * Sorgu parametresiyle geçiyoruz çünkü sayfa `sandbox: true` ile ve preload
   * olmadan çalışıyor — araya bir köprü koymak bu bilgi için fazla olurdu.
   */
  const shellUrl = `${server.url}&shell=${process.platform === 'darwin' ? 'mac' : 'other'}`;
  await window.loadURL(shellUrl);

  /*
   * DIŞ BAĞLANTILAR SİSTEM TARAYICISINDA.
   *
   * phpMyAdmin, Dosya Yöneticisi, cPanel ve yayınlanan sitenin kendisi — hepsi
   * dışarıya gidiyor. Bunları uygulama penceresinde açmak iki şeyi bozardı:
   * kullanıcının cPanel oturumu KENDİ tarayıcısında yaşıyor, ve gezinme
   * uygulamayı bir tarayıcıya dönüştürüp geri dönüş yolu bırakmazdı.
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(server.url.split('?')[0])) return; // kendi sayfamız
    event.preventDefault();
    shell.openExternal(url);
  });

  window.on('closed', () => {
    window = null;
  });

  buildMenu();
}

/**
 * Menü — macOS'ta ŞART.
 *
 * Electron'da varsayılan menü yoksa Cmd+C / Cmd+V hiç çalışmıyor: kopyala-
 * yapıştır menü rollerine bağlı. Şifre ve bağlantı dizesi kopyalanan bir
 * araçta bu, sessiz ama can sıkıcı bir kusur olurdu.
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Görünüm',
      submenu: [
        { role: 'reload' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/*
 * Pencere kapanınca uygulama da kapanıyor — macOS'ta bile.
 *
 * macOS geleneği "pencere kapansa da uygulama açık kalır"; burada uymuyoruz
 * çünkü arka planda cPanel token'ı tutan bir sunucu çalışıyor ve kullanıcının
 * görmediği bir süreç o token'ı bellekte tutmaya devam etmemeli.
 */
app.on('window-all-closed', () => app.quit());

app.on('before-quit', async () => {
  if (server) await server.close().catch(() => {});
});

function fatal(err) {
  dialog.showErrorBox('cpanel-next', String(err?.stack ?? err));
  app.quit();
}

export { HERE };
