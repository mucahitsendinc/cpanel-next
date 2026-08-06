import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HT_BLOCK,
  HT_BEGIN,
  HT_END,
  LARAVEL_PRESERVE,
  LARAVEL_EXCLUDES,
  MERGED_DIRS,
  MANIFEST_LIMIT,
  publicManifest,
  stalePublicFiles,
  vendorDecision,
  buildEnvPatch,
  artisanPlan,
  normalizeSettings,
} from '../lib/laravel.mjs';
import { mergeMarked, removeMarked } from '../lib/htaccess.mjs';

/* ------------------------------------------------------------- .htaccess */

/*
 * Bu blok, kaynak kodun internete açılmasıyla açılmaması arasındaki tek
 * fark. Laravel belge kökünün İÇİNE kuruluyor — yani `.env`, `app/` ve
 * `vendor/` fiziksel olarak yayına açık bir dizinin altında.
 */

test('yönlendirme sonsuz döngüye girmiyor — public/ için erken çıkış var', () => {
  const rules = HT_BLOCK.split('\n').filter((l) => l.startsWith('RewriteRule'));
  assert.equal(rules[0], 'RewriteRule ^public/ - [L]');
  assert.equal(rules[1], 'RewriteRule ^(.*)$ public/$1 [L]');
});

test('her istek public/ içine alınıyor', () => {
  assert.match(HT_BLOCK, /RewriteRule \^\(\.\*\)\$ public\/\$1 \[L\]/);
});

test('mod_rewrite kapalıyken bile hassas dosyalar reddediliyor', () => {
  assert.match(HT_BLOCK, /FilesMatch/);
  for (const pattern of ['\\.env', 'composer', 'artisan']) {
    assert.match(HT_BLOCK, new RegExp(pattern.replace(/\\\\/g, '\\\\')));
  }
});

test('dizin listeleme kapalı', () => {
  assert.match(HT_BLOCK, /^Options -Indexes$/m);
});

test('LiteSpeed’in desteklemediği <If> sözdizimi YOK', () => {
  // Test kutusu LiteSpeed; Apache 2.4'e özgü ifade sözdizimi orada bütün
  // siteyi 500'e düşürüyor.
  assert.doesNotMatch(HT_BLOCK, /<If\s/);
});

test('blok kendi işaretleri arasında', () => {
  assert.ok(HT_BLOCK.startsWith(HT_BEGIN));
  assert.ok(HT_BLOCK.endsWith(HT_END));
});

test('blok mevcut .htaccess’in ÜSTÜNE ekleniyor, gerisi korunuyor', () => {
  const current = '# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN\nfoo\n';
  const next = mergeMarked(current, { begin: HT_BEGIN, end: HT_END, block: HT_BLOCK });
  assert.ok(next.indexOf(HT_BEGIN) < next.indexOf('CLOUDLINUX'));
  assert.ok(next.includes(current));
});

test('aynı blok ikinci kez yazılmıyor', () => {
  const once = mergeMarked('x\n', { begin: HT_BEGIN, end: HT_END, block: HT_BLOCK });
  assert.equal(mergeMarked(once, { begin: HT_BEGIN, end: HT_END, block: HT_BLOCK }), null);
});

test('blok sökülebiliyor ve geri kalan dosya bozulmuyor', () => {
  const current = mergeMarked('# host kuralı\nRedirect 301 /a /b\n',
    { begin: HT_BEGIN, end: HT_END, block: HT_BLOCK });
  const cleaned = removeMarked(current, { begin: HT_BEGIN, end: HT_END });
  assert.doesNotMatch(cleaned, /cpanel-next laravel/);
  assert.match(cleaned, /Redirect 301 \/a \/b/);
});

/* -------------------------------------------------------------- koruma */

test('belge kökünün altyapı dosyaları temizlikten muaf', () => {
  // .well-known silinirse AutoSSL sertifikayı yenileyemez; .htaccess silinirse
  // bakım kuralı ve hostun yönlendirmeleri gider.
  for (const name of ['.well-known', '.htaccess', 'cgi-bin', '.env', 'storage']) {
    assert.ok(LARAVEL_PRESERVE.includes(name), name);
  }
});

test('node_modules ve storage pakete girmiyor', () => {
  assert.ok(LARAVEL_EXCLUDES.includes('node_modules/**'));
  assert.ok(LARAVEL_EXCLUDES.includes('storage/**'));
});

test('storage:link sembolik bağı paketlenmiyor', () => {
  assert.ok(LARAVEL_EXCLUDES.includes('public/storage/**'));
});

/* ---------------------------------------------- kod siliniyor, veri duruyor */

test('public ve storage toptan silinmiyor', () => {
  assert.deepEqual(MERGED_DIRS, ['public', 'storage']);
});

test('kod dizinleri koruma listesinde DEĞİL — silinip yeniden açılıyorlar', () => {
  // Yerelde silinen bir controller sunucuda yaşamaya devam etmemeli.
  for (const dir of ['app', 'config', 'routes', 'database', 'resources', 'bootstrap']) {
    assert.equal(LARAVEL_PRESERVE.includes(dir), false, dir);
    assert.equal(MERGED_DIRS.includes(dir), false, dir);
  }
});

test('manifesto yalnızca public/ yollarını tutuyor', () => {
  const m = publicManifest(['app/x.php', 'public/index.php', 'public/build/a.js', 'artisan']);
  assert.deepEqual(m, ['public/build/a.js', 'public/index.php']);
});

test('çok büyük public/ için manifesto tutulmuyor', () => {
  const many = Array.from({ length: MANIFEST_LIMIT + 1 }, (_, i) => `public/img/${i}.jpg`);
  assert.equal(publicManifest(many), null);
});

test('budama YALNIZCA bizim gönderdiğimiz dosyalara dokunuyor', () => {
  const previous = ['public/index.php', 'public/build/eski.js'];
  const current = ['public/index.php', 'public/build/yeni.js'];
  assert.deepEqual(stalePublicFiles(previous, current), ['public/build/eski.js']);
});

test('sunucuda üretilmiş dosyalar budanamaz — hiçbir manifestoda yoklar', () => {
  // Kullanıcı yüklemesi ne eski ne yeni manifestoda; fark kümesine giremez.
  const stale = stalePublicFiles(['public/index.php'], ['public/index.php']);
  assert.deepEqual(stale, []);
  assert.equal(stalePublicFiles(['public/index.php'], []).includes('public/uploads/foto.jpg'), false);
});

test('public/storage bağının altı asla budanmıyor', () => {
  const stale = stalePublicFiles(
    ['public/storage/a.jpg', 'public/storage', 'public/eski.css'],
    []
  );
  assert.deepEqual(stale, ['public/eski.css']);
});

test('önceki manifesto yoksa hiçbir şey budanmıyor', () => {
  assert.deepEqual(stalePublicFiles(null, ['public/a.js']), []);
  assert.deepEqual(stalePublicFiles(undefined, ['public/a.js']), []);
});

/* -------------------------------------------------------------- vendor */

test('auto: lock aynıysa vendor GÖNDERİLMEZ', () => {
  const d = vendorDecision({ mode: 'auto', localHash: 'abc', remoteHash: 'abc' });
  assert.deepEqual(d, { ship: false, install: false, reason: 'unchanged' });
});

test('auto: lock değiştiyse gönderilir', () => {
  assert.equal(vendorDecision({ mode: 'auto', localHash: 'abc', remoteHash: 'xyz' }).ship, true);
});

test('auto: ilk kurulumda daima gönderilir', () => {
  assert.equal(vendorDecision({ mode: 'auto', first: true, localHash: 'a', remoteHash: 'a' }).ship, true);
});

test('auto: karşılaştıracak özet yoksa GÖNDERİR — atlamaz', () => {
  // Bilinmezlikte "göndermemek", sunucuda eski ya da hiç olmayan bir vendor
  // bırakmak demek. Şüphede olan taraf gönderme yönünde olmalı.
  assert.equal(vendorDecision({ mode: 'auto', localHash: null, remoteHash: 'a' }).ship, true);
  assert.equal(vendorDecision({ mode: 'auto', localHash: 'a', remoteHash: null }).ship, true);
});

test('always her zaman gönderir, server hiç göndermez', () => {
  assert.equal(vendorDecision({ mode: 'always', localHash: 'a', remoteHash: 'a' }).ship, true);
  const server = vendorDecision({ mode: 'server', first: true });
  assert.equal(server.ship, false);
  assert.equal(server.install, true);
});

/* ------------------------------------------------------------ .env yaması */

test('APP_DEBUG true ise false yapılıyor', () => {
  const p = buildEnvPatch({ current: { APP_DEBUG: 'true' } });
  assert.equal(p.APP_DEBUG, 'false');
});

test('APP_DEBUG zaten false ise dosyaya dokunulmuyor', () => {
  assert.equal(buildEnvPatch({ current: { APP_DEBUG: 'false' } }).APP_DEBUG, undefined);
});

test('forceDebugOff kapalıysa APP_DEBUG’a karışılmıyor', () => {
  const p = buildEnvPatch({ current: { APP_DEBUG: 'true' }, forceDebugOff: false });
  assert.equal(p.APP_DEBUG, undefined);
});

test('APP_URL ilk kurulumda domainden yazılıyor', () => {
  assert.equal(buildEnvPatch({ domain: 'magaza.site.com', first: true }).APP_URL,
    'https://magaza.site.com');
});

test('var olan APP_URL güncellemede EZİLMİYOR', () => {
  // Kullanıcı CDN ya da özel bir adres yazmış olabilir.
  const p = buildEnvPatch({ domain: 'a.com', current: { APP_URL: 'https://cdn.b.com' } });
  assert.equal(p.APP_URL, undefined);
});

test('veritabanı bilgileri yazılıyor, localhost 127.0.0.1 oluyor', () => {
  const p = buildEnvPatch({
    db: { host: 'localhost', port: 3306, database: 'u_shop', user: 'u_shop', password: 'x' },
  });
  assert.equal(p.DB_CONNECTION, 'mysql');
  assert.equal(p.DB_HOST, '127.0.0.1');
  assert.equal(p.DB_DATABASE, 'u_shop');
  assert.equal(p.DB_PASSWORD, 'x');
});

test('şifresi bilinmeyen kullanıcıda DB_PASSWORD yazılmıyor', () => {
  // Var olan bir kullanıcıyı seçtiğimizde şifresi BİZDE YOK; boş yazmak
  // çalışan bir bağlantıyı bozardı.
  const p = buildEnvPatch({ db: { host: 'h', database: 'd', user: 'u', password: null } });
  assert.equal('DB_PASSWORD' in p, false);
  assert.equal(p.DB_USERNAME, 'u');
});

test('veritabanı seçilmediyse .env’de DB satırlarına dokunulmuyor', () => {
  assert.deepEqual(buildEnvPatch({ current: { APP_DEBUG: 'false' } }), {});
});

/* -------------------------------------------------------------- artisan */

test('migrate none ise hiç migration koşmuyor', () => {
  const cmds = artisanPlan({ migrate: 'none' }).map((s) => s.cmd).join(' ');
  assert.doesNotMatch(cmds, /migrate/);
});

test('fresh-seed yalnızca açıkça istendiğinde', () => {
  assert.match(artisanPlan({ migrate: 'fresh-seed' }).map((s) => s.cmd).join(' '),
    /migrate:fresh --seed --force/);
});

test('migration daima --force ile koşuyor — üretimde soru sorulamaz', () => {
  for (const mode of ['migrate', 'migrate-seed', 'fresh-seed']) {
    for (const step of artisanPlan({ migrate: mode })) {
      if (/migrate|db:seed/.test(step.cmd)) assert.match(step.cmd, /--force/, step.cmd);
    }
  }
});

test('dizinler HER artisan komutundan önce açılıyor', () => {
  /*
   * Canlıda öğrenilen sıra: `storage/**` ve `bootstrap/cache/**` pakete
   * girmiyor, yani ilk kurulumda o dizinler yok. Laravel HERHANGİ bir artisan
   * komutunda önce bootstrap oluyor ve oralara yazamazsa daha başlarken
   * ölüyor — ilk kurulum "APP_KEY" adımında bu yüzden patlamıştı.
   */
  for (const opts of [{ keyGenerate: true }, { migrate: 'fresh-seed' }, { optimize: true }]) {
    const steps = artisanPlan(opts);
    const firstArtisan = steps.findIndex((x) => /artisan/.test(x.cmd));
    const mkdir = steps.findIndex((x) => /mkdir -p storage/.test(x.cmd));
    assert.equal(mkdir, 0, JSON.stringify(opts));
    if (firstArtisan !== -1) assert.ok(mkdir < firstArtisan, JSON.stringify(opts));
  }
});

test('storage/app/public da açılıyor — storage:link onu bekliyor', () => {
  assert.match(artisanPlan({}).find((x) => /mkdir/.test(x.cmd)).cmd, /storage\/app\/public/);
});

test('önbellek önce temizlenip sonra kuruluyor', () => {
  const labels = artisanPlan({ optimize: true }).map((s) => s.label);
  assert.ok(labels.indexOf('config:clear') < labels.indexOf('config:cache'));
});

test('route:cache ölümcül değil — closure rotalarında patlıyor', () => {
  const step = artisanPlan({ optimize: true }).find((x) => x.label === 'route:cache');
  assert.equal(step.fatal, false);
});

test('storage:link ölümcül değil — zaten varsa hata veriyor', () => {
  assert.equal(artisanPlan({}).find((x) => x.label === 'storage:link').fatal, false);
});

test('key:generate yalnızca istendiğinde', () => {
  assert.equal(artisanPlan({}).some((x) => /key:generate/.test(x.cmd)), false);
  assert.equal(artisanPlan({ keyGenerate: true }).some((x) => /key:generate/.test(x.cmd)), true);
});

test('verilen php ikilisi kullanılıyor', () => {
  const cmds = artisanPlan({ php: '/opt/cpanel/ea-php82/root/usr/bin/php', optimize: true });
  assert.ok(cmds.every((c) => !/\bartisan\b/.test(c.cmd) || c.cmd.startsWith('/opt/cpanel/ea-php82')));
});

/* -------------------------------------------------------------- ayarlar */

test('ilk kurulumun varsayılanı fresh-seed, güncellemenin migrate', () => {
  assert.equal(normalizeSettings({}, { first: true }).migrate, 'fresh-seed');
  assert.equal(normalizeSettings({}, { first: false }).migrate, 'migrate');
});

test('güncelleme migration’ı kapatılabiliyor', () => {
  assert.equal(normalizeSettings({ migrate: 'none' }).migrate, 'none');
});

test('geçersiz değer sessizce kabul edilmiyor', () => {
  const r = normalizeSettings({ migrate: 'frsh-seed' });
  assert.equal(r.migrate, 'migrate');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /migrate/);
});

test('varsayılanlar güvenli tarafta', () => {
  const r = normalizeSettings({});
  assert.equal(r.forceDebugOff, true);
  assert.equal(r.vendor, 'auto');
  assert.equal(r.optimize, true);
});

test('kapatmak açıkça false yazmayı gerektiriyor', () => {
  assert.equal(normalizeSettings({ forceDebugOff: false }).forceDebugOff, false);
  assert.equal(normalizeSettings({ forceDebugOff: 0 }).forceDebugOff, true);
});
