import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Laravel desteğinin SAF çekirdeği — ağ yok, dosya sistemi yalnızca okuma.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TOPOLOJİ: belge kökü DEĞİŞTİRİLMİYOR
 * ─────────────────────────────────────────────────────────────────────────────
 * cPanel'in `SubDomain::changedocroot` ucu var ve docroot'u `<klasör>/public`
 * yapmak "temiz" çözüm gibi görünüyor. Kullanmıyoruz: docroot değiştirmek
 * ana domainde hiç mümkün değil (WHM ister), addon/subdomain'de de hesabın
 * yapılandırmasını kalıcı olarak değiştiriyor ve araç kaldırıldığında geride
 * bozuk bir vhost bırakabiliyor.
 *
 * Bunun yerine Laravel domainin KENDİ belge kökünün içine kuruluyor ve işi
 * `.htaccess` yapıyor: her istek `public/` içine yönlendiriliyor.
 *
 *   ~/magaza.site.com/          ← belge kökü (dokunulmadı)
 *     .htaccess                 ← bizim blok: her şeyi public/'e al
 *     app/ config/ vendor/ .env ← yönlendirme yüzünden URL'den erişilemez
 *     public/                   ← Laravel'in kendi .htaccess'i burada devralır
 *
 * ⚠ BU DÜZENİN BEDELİ: kaynak dosyalar fiziksel olarak belge kökünün ALTINDA.
 * mod_rewrite kapalıysa ya da `.htaccess` yok sayılıyorsa `.env` internete
 * açılır. Bu yüzden iki savunma var: (1) blok, yönlendirmeye ek olarak
 * hassas dosya adlarını açıkça reddediyor; (2) yayından sonra araç
 * `https://domain/.env` adresini GERÇEKTEN çekip okunabiliyor mu diye
 * bakıyor (bkz. laravel-core.mjs → verifyExposure).
 */

export const HT_BEGIN = '# cpanel-next laravel BEGIN';
export const HT_END = '# cpanel-next laravel END';

/**
 * Belge köküne yazılan yönlendirme bloğu.
 *
 * ⚠ İLK KURAL SONSUZ DÖNGÜYÜ ENGELLİYOR. `.htaccess` dizin bağlamında
 * çalışırken yol öneki sıyrılıyor; ikinci kural tek başına bırakılırsa ikinci
 * geçişte `public/foo` yine eşleşir ve `public/public/foo` üretilir —
 * `LimitInternalRecursion` sınırına kadar. Yaygın olarak paylaşılan tek
 * satırlık sürüm bu yüzden bazı sunucularda 500 veriyor.
 *
 * ⚠ YALNIZCA evrensel yönergeler: test kutusu LiteSpeed ve Apache 2.4'e özgü
 * `<If>` ifade sözdizimi orada desteklenmiyor.
 */
export const HT_BLOCK = `${HT_BEGIN}
Options -Indexes

<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule ^public/ - [L]
RewriteRule ^(.*)$ public/$1 [L]
</IfModule>

<IfModule mod_authz_core.c>
<FilesMatch "^(\\.env.*|composer\\.(json|lock)|package(-lock)?\\.json|artisan|.*\\.(sh|sql|log))$">
Require all denied
</FilesMatch>
</IfModule>
${HT_END}`;

/**
 * PAKETE GİRMEYECEKLER.
 *
 * `node_modules` hiç gitmiyor: ön yüz derlemesi (Vite/Mix) YERELDE koşuyor ve
 * sunucuya yalnızca `public/build` çıktısı gidiyor — Next tarafındaki kuralın
 * aynısı, aynı gerekçeyle (CloudLinux LVE varsayılan 1 GB'ta derleme OOM
 * veriyor).
 *
 * `storage` pakete girmiyor çünkü sunucudaki KORUNUYOR: içinde oturumlar,
 * kayıtlar ve kullanıcı yüklemeleri var. Yalnızca ilk kurulumda iskeleti
 * gidiyor (bkz. firstDeployExtras).
 */
export const LARAVEL_EXCLUDES = [
  'node_modules/**',
  'storage/**',
  'public/storage/**', // `artisan storage:link` sembolik bağı — pakete girmemeli
  'public/hot',
  'bootstrap/cache/**',
  '.git/**',
  'tests/**',
  '.phpunit.result.cache',
  '.editorconfig',
  '.styleci.yml',
  'phpunit.xml',
  'README.md',
];

/**
 * SUNUCUDA SİLİNMEYECEKLER.
 *
 * ⚠ Bu liste, Next tarafındakinden çok daha kritik: uygulama klasörü BELGE
 * KÖKÜNÜN KENDİSİ. Orayı körü körüne temizlemek yalnızca uygulamayı değil,
 * hesabın altyapısını da siler:
 *
 *   .well-known  → AutoSSL doğrulaması; silinirse sertifika yenilenmez
 *   .htaccess    → bakım kuralımız ve hostun kendi yönlendirmeleri burada
 *   cgi-bin      → cPanel'in belge köküne kendi koyduğu dizin
 *   .user.ini    → PHP ayarları (hosting koyuyor)
 *
 * `.env` ve `storage` kullanıcı verisi: `.env` zaten pakete hiç girmiyor,
 * yani silinirse geri gelmez.
 */
/**
 * İKİ KATMANLI TEMİZLİK.
 *
 * Sorun iki taraflı ve tek bir kural ikisini birden çözmüyor:
 *
 *   (a) Yerelde SİLDİĞİM dosya sunucuda kalmamalı. `app/Http/Controllers/
 *       EskiController.php` silindiyse ve biz yalnızca üzerine yazsaydık,
 *       dosya sunucuda sonsuza dek yaşar — hâlâ route'lanabilir, hâlâ
 *       çalışabilir. Bu yüzden KOD dizinleri komple siliniyor.
 *
 *   (b) Sunucuda ÜRETİLEN dosya silinmemeli. `public/uploads`, `storage/logs`,
 *       fatura PDF'leri, kullanıcı görselleri… Bunlar depoda yok, yani
 *       silinirlerse geri gelmezler.
 *
 * KOD dizinleri (silinip yeniden açılıyor): app, bootstrap, config, database,
 * resources, routes, vendor ve kök dosyaları — hepsi `cleanDir`'in normal
 * yoluna giriyor, ayrıca listelenmelerine gerek yok.
 *
 * VERİ dizinleri (asla toptan silinmiyor): aşağıdaki liste.
 *   · `storage` hiç paketlenmiyor, hiç silinmiyor — tamamen kullanıcının.
 *   · `public` paketleniyor AMA silinmiyor: paket üstüne açılıyor, yani
 *     gönderdiğimiz dosyalar tazeleniyor, göndermediklerimiz duruyor.
 *
 * `public` için (a) sorununu MANİFESTO çözüyor: her deploy'da gönderdiğimiz
 * public yollarının listesi sahiplik işaretine yazılıyor. Sonraki deploy'da
 * "geçen sefer BİZİM gönderdiğimiz ama bu sefer göndermediğimiz" dosyalar
 * siliniyor. Bizim hiç göndermediğimiz bir dosya listede olmadığı için asla
 * silinmiyor.
 */
export const MERGED_DIRS = ['public', 'storage'];

export const LARAVEL_PRESERVE = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.backup',
  'storage',
  '.htaccess',
  '.well-known',
  'cgi-bin',
  '.user.ini',
  'php.ini',
  'error_log',
  '.cpanel-next-owner.json',
  '.cpanel-next-history.json',
  '.cpanel-next-maintenance',
  'cpanel-next-maintenance.html',
  'cpanel-next-maintenance.php',
];

/* ------------------------------------------------------ public manifestosu */

/**
 * Manifesto için üst sınır.
 *
 * Görsel ağırlıklı bir `public/` on binlerce dosya olabiliyor; hepsini
 * sahiplik işaretine yazmak dosyayı megabaytlara çıkarır ve her deploy'da
 * yeniden yazılır. Sınır aşılırsa manifesto tutulmuyor ve budama atlanıyor —
 * sessizce değil, uyarıyla.
 */
export const MANIFEST_LIMIT = 3000;

/** Pakete giren dosyalardan `public/` altındakileri süzer. */
export function publicManifest(includedFiles = []) {
  const list = includedFiles
    .map((f) => String(f).replace(/\\/g, '/'))
    .filter((f) => f.startsWith('public/'))
    .sort();
  return list.length > MANIFEST_LIMIT ? null : list;
}

/**
 * Bu deploy'da artık gönderilmeyen, ama GEÇEN SEFER BİZİM gönderdiğimiz
 * public dosyaları.
 *
 * Kesişim değil FARK alıyoruz ve yalnızca önceki manifestodan çıkıyoruz:
 * sunucuda üretilmiş bir dosya hiçbir manifestoda yer almadığı için buraya
 * asla düşemez. Budamanın kullanıcı verisine dokunamaması bu yüzden bir
 * temenni değil, yapısal bir güvence.
 */
export function stalePublicFiles(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current)) return [];
  const now = new Set(current.map((f) => String(f).replace(/\\/g, '/')));
  return previous
    .map((f) => String(f).replace(/\\/g, '/'))
    .filter((f) => f.startsWith('public/') && !now.has(f))
    // `public/storage` sembolik bağı manifestoya hiç girmiyor ama bir kez
    // girdiyse silinmemeli: arkasında kullanıcı yüklemeleri var.
    .filter((f) => !f.startsWith('public/storage/') && f !== 'public/storage');
}

/* --------------------------------------------------------------- vendor */

export const VENDOR_MODES = ['auto', 'always', 'server'];

/**
 * `vendor` bu deploy'da gönderilecek mi?
 *
 * `auto` (varsayılan): yalnızca `composer.lock` DEĞİŞTİYSE. Bağımlılıkları
 * değişmemiş bir güncelleme ~45 MB yerine ~2 MB gidiyor ve sunucudaki
 * `vendor` olduğu yerde kalıyor. Karşılaştırma için lock dosyasının özeti
 * sahiplik işaretinde saklanıyor.
 *
 * @param {'auto'|'always'|'server'} mode
 * @param {string|null} localHash    yereldeki composer.lock özeti
 * @param {string|null} remoteHash   sunucudaki son deploy'un özeti
 * @param {boolean} first            ilk kurulum mu
 */
export function vendorDecision({ mode = 'auto', localHash = null, remoteHash = null, first = false }) {
  if (mode === 'server') return { ship: false, install: true, reason: 'server' };
  if (mode === 'always') return { ship: true, install: false, reason: 'always' };
  if (first) return { ship: true, install: false, reason: 'first' };
  if (!localHash || !remoteHash) return { ship: true, install: false, reason: 'unknown' };
  if (localHash !== remoteHash) return { ship: true, install: false, reason: 'changed' };
  return { ship: false, install: false, reason: 'unchanged' };
}

export function composerLockHash(cwd) {
  const file = path.join(cwd, 'composer.lock');
  if (!fs.existsSync(file)) return null;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------ .env yaması */

/**
 * Sunucudaki `.env` dosyasına yazılacak değerler.
 *
 * ⚠ KURAL: yereldeki `.env` ASLA gönderilmiyor ve sunucudaki dosyaya
 * yalnızca burada üretilen anahtarlar yazılıyor. Geri kalan her satır
 * kullanıcınındır ve olduğu gibi kalır (bkz. envfile.mjs → upsertEnv).
 *
 * `APP_DEBUG` tek başına bir davranış: yayına açık bir Laravel'de `true`
 * olması, hata sayfasında ortam değişkenlerini ve yığın izini herkese
 * göstermek demek. Kapatılabilir olması istendi, ama varsayılan kapalı değil
 * — varsayılanın güvenli olması gerekiyor.
 */
export function buildEnvPatch({
  domain = null,
  db = null,
  forceDebugOff = true,
  current = {},
  first = false,
} = {}) {
  const patch = {};

  if (forceDebugOff && String(current.APP_DEBUG ?? '').toLowerCase() === 'true') {
    patch.APP_DEBUG = 'false';
  }

  // APP_URL yalnızca İLK kurulumda ya da hiç yoksa yazılıyor: kullanıcı
  // sonradan CDN/özel bir adres yazmış olabilir, onu ezmek doğru olmaz.
  if (domain && (first || !current.APP_URL)) {
    patch.APP_URL = `https://${domain}`;
  }

  if (db) {
    patch.DB_CONNECTION = 'mysql';
    /*
     * ⚠ `localhost` OLDUĞU GİBİ YAZILIYOR — 127.0.0.1'e çevrilmiyor.
     *
     * `buildDatabaseUrl` (Next.js/Prisma) bu çevirmeyi bilerek yapıyor: Node'un
     * DNS'i `localhost`u önce `::1` çözüyor ve MySQL orayı dinlemiyor.
     * PHP'de durum TERSİ: `localhost` özel bir değer ve unix soketi üzerinden
     * bağlanıyor — cPanel sunucularında en güvenilir yol bu. `127.0.0.1`
     * yazmak TCP'yi zorluyor ve MySQL yalnızca soketi dinliyorsa
     * (`skip-networking`) bağlantı hiç kurulamıyor.
     *
     * Yani aynı görünen iki alan için doğru cevap farklı; cPanel ne dediyse
     * onu yazıyoruz.
     */
    patch.DB_HOST = db.host;
    patch.DB_PORT = String(db.port ?? 3306);
    patch.DB_DATABASE = db.database;
    patch.DB_USERNAME = db.user;
    if (db.password) patch.DB_PASSWORD = db.password;
  }

  if (first && !current.APP_ENV) patch.APP_ENV = 'production';

  return patch;
}

/* ---------------------------------------------------------------- artisan */

export const MIGRATE_MODES = ['none', 'migrate', 'migrate-seed', 'fresh-seed'];

/**
 * Sunucuda koşacak artisan adımları.
 *
 * Her adım `{ label, cmd, fatal }`. `fatal: false` olanlar başarısız olsa da
 * deploy'u durdurmuyor — `route:cache` kapanış (closure) kullanan rotalarda
 * hata veriyor ve bu, yayını engellemesi gereken bir şey değil.
 *
 * ⚠ `migrate:fresh` BÜTÜN TABLOLARI SİLER. Yalnızca ilk kurulumda ve yalnızca
 * kullanıcı açıkça seçtiğinde; güncellemede asla varsayılan değil.
 */
export function artisanPlan({
  php = 'php',
  migrate = 'none',
  optimize = true,
  keyGenerate = false,
  storageLink = true,
} = {}) {
  const steps = [];
  const artisan = `${php} artisan`;

  /*
   * ⚠ DİZİNLER HER ŞEYDEN ÖNCE.
   *
   * Bu sıra canlıda öğrenildi: ilk kurulumda `key:generate` en başta koşuyordu
   * ve "APP_KEY" adımında patlıyordu. Sebep artisan'ın kendisi değildi —
   * `storage/**` ve `bootstrap/cache/**` pakete GİRMİYOR (sunucudaki korunsun
   * diye), yani ilk kurulumda o dizinler hiç yok. Laravel ise HERHANGİ bir
   * artisan komutunda önce bootstrap oluyor ve `bootstrap/cache` ile
   * `storage/framework` altına yazamazsa daha başlarken ölüyor.
   *
   * Yani ilk artisan komutu ne olursa olsun, dizinler ondan önce açılmalı.
   */
  steps.push({
    label: 'dizinler ve izinler',
    cmd: [
      /*
       * Laravel'in yazacağı dizinler. `storage/**` ve `bootstrap/cache/**`
       * pakete girmiyor (sunucudaki korunsun diye), yani ilk kurulumda
       * hiçbiri yok.
       *
       * `storage/framework/cache/DATA` ayrıca gerekiyor: dosya tabanlı önbellek
       * doğrudan oraya yazıyor ve üst dizinin var olması yetmiyor.
       */
      'mkdir -p storage/framework/cache/data storage/framework/sessions ' +
        'storage/framework/views storage/app/public storage/logs bootstrap/cache',

      /*
       * Paketten çıkan dosyaların izinleri.
       *
       * Zip arşivi kendi kip bitlerini taşıyor ve bunlar yerel makinedeki
       * umask'a göre değişiyor; sunucuda 600 ile açılan bir dosya web
       * sunucusu tarafından okunamıyor ve site 403 veriyor.
       *
       * ⚠ `-exec … +` kullanılıyor, `\;` DEĞİL: 8000 dosyalık bir Laravel
       * projesinde `\;` dosya başına bir süreç açar. `+` toplu çağırır.
       *
       * ⚠ HOŞGÖRÜLÜ ADIMLAR SÜSLÜ PARANTEZ İÇİNDE. İlk hâli `… || true`
       * yazıyordu ve `&&` zinciri sola bağlandığı için o `|| true` ZİNCİRİN
       * TAMAMINI kurtarıyordu: kritik `chmod 775` başarısız olsa bile adım
       * başarılı sayılırdı. `{ …; }` her biri kendi içinde 0 dönüyor, zincir
       * yalnızca gerçekten önemli olan komutlarda kırılıyor.
       *
       * ⚠ `.` de dahil, yani BELGE KÖKÜNÜN kendisi 755 oluyor. Apache suEXEC
       * grup ya da herkese yazılabilir bir belge kökünü servis etmeyi
       * REDDEDİYOR; 775 bırakmak siteyi 500'e düşürürdü.
       */
      '{ find . -type d -exec chmod 755 {} + 2>/dev/null || :; }',
      '{ find . -type f -exec chmod 644 {} + 2>/dev/null || :; }',

      /*
       * Laravel'in YAZDIĞI iki ağaç. 775, PHP web sunucuyla aynı kullanıcı
       * altında koşmuyorsa da (grup aynıysa) çalışsın diye; cPanel'de PHP
       * genelde kullanıcı olarak koşuyor ve 755 de yeterdi, ama 775 iki
       * durumu birden karşılıyor.
       */
      'chmod -R 775 storage bootstrap/cache',

      /*
       * `.env` yalnızca SAHİBİNE.
       *
       * Bu dosyada veritabanı şifresi ve uygulama anahtarı var, ve bizim
       * topolojimizde belge kökünün ALTINDA duruyor. `.htaccess`'in onu
       * gizlemesine güveniyoruz; dosya izni ikinci savunma.
       */
      '{ [ -f .env ] && chmod 600 .env || :; }',
    ].join(' && '),
    fatal: true,
  });

  if (keyGenerate) {
    steps.push({ label: 'APP_KEY', cmd: `${artisan} key:generate --force`, fatal: true });
  }

  /*
   * ⚠ ÖNBELLEK MIGRATION'DAN ÖNCE TEMİZLENİYOR.
   *
   * `config:cache` bir kez koştuysa Laravel `.env`'i ARTIK OKUMUYOR;
   * `bootstrap/cache/config.php` neyse onu kullanıyor. Biz `.env`'e taze
   * veritabanı bilgilerini yazdıktan sonra migration'ı çalıştırıyoruz — eski
   * bir önbellek varsa migration eski (ya da boş) bilgilerle bağlanmaya
   * çalışır ve hata veritabanından gelir, yani kullanıcıyı tamamen yanlış
   * yere baktırır.
   *
   * Temizlik burada; kurma işi migration'dan SONRA.
   */
  steps.push({ label: 'config:clear', cmd: `${artisan} optimize:clear`, fatal: false });

  if (storageLink) {
    steps.push({ label: 'storage:link', cmd: `${artisan} storage:link`, fatal: false });
  }

  if (migrate === 'migrate') {
    steps.push({ label: 'migrate', cmd: `${artisan} migrate --force`, fatal: true });
  } else if (migrate === 'migrate-seed') {
    steps.push({ label: 'migrate', cmd: `${artisan} migrate --force`, fatal: true });
    steps.push({ label: 'seed', cmd: `${artisan} db:seed --force`, fatal: true });
  } else if (migrate === 'fresh-seed') {
    steps.push({ label: 'migrate:fresh', cmd: `${artisan} migrate:fresh --seed --force`, fatal: true });
  }

  // Önbellek KURULUYOR — temizleme adımı migration'dan önce koştu.
  if (optimize) {
    steps.push({ label: 'config:cache', cmd: `${artisan} config:cache`, fatal: true });
    steps.push({ label: 'route:cache', cmd: `${artisan} route:cache`, fatal: false });
    steps.push({ label: 'view:cache', cmd: `${artisan} view:cache`, fatal: false });
  }

  return steps;
}

/**
 * Deploy ayarları — `.cpanel-next.json` → `laravel`.
 *
 * Bilinmeyen değerler sessizce kabul edilmiyor: yazım hatası olan bir
 * `migrate` değeri, migration'ın hiç koşmadığını fark etmeden yayınlamak
 * demekti.
 */
export function normalizeSettings(raw = {}, { first = false } = {}) {
  const warnings = [];
  const pick = (value, allowed, fallback, field) => {
    if (value === undefined || value === null) return fallback;
    if (allowed.includes(value)) return value;
    warnings.push(`laravel.${field}: ${JSON.stringify(value)} → ${fallback}`);
    return fallback;
  };

  return {
    migrate: first
      ? pick(raw.firstMigrate, MIGRATE_MODES, 'fresh-seed', 'firstMigrate')
      : pick(raw.migrate, MIGRATE_MODES, 'migrate', 'migrate'),
    vendor: pick(raw.vendor, VENDOR_MODES, 'auto', 'vendor'),
    forceDebugOff: raw.forceDebugOff !== false,
    optimize: raw.optimize !== false,
    buildAssets: raw.buildAssets !== false,
    warnings,
  };
}

/* --------------------------------------------------------------- tespit */

/** Yerel projeden Laravel bilgisi. `detectProject` bunu kullanıyor. */
export function inspectLaravel(cwd) {
  const out = { version: null, hasEnvExample: false, hasLock: false, assetBuilder: null };

  try {
    const composer = JSON.parse(fs.readFileSync(path.join(cwd, 'composer.json'), 'utf8'));
    const req = { ...(composer.require ?? {}), ...(composer['require-dev'] ?? {}) };
    const raw = req['laravel/framework'];
    if (raw) {
      const m = String(raw).match(/(\d+)(?:\.(\d+))?/);
      out.version = m ? m[0] : String(raw);
    }
  } catch {
    /* composer.json okunamadıysa sürüm bilinmiyor — engel değil */
  }

  out.hasEnvExample = fs.existsSync(path.join(cwd, '.env.example'));
  out.hasLock = fs.existsSync(path.join(cwd, 'composer.lock'));

  if (fs.existsSync(path.join(cwd, 'vite.config.js')) || fs.existsSync(path.join(cwd, 'vite.config.ts'))) {
    out.assetBuilder = 'vite';
  } else if (fs.existsSync(path.join(cwd, 'webpack.mix.js'))) {
    out.assetBuilder = 'mix';
  }

  return out;
}
