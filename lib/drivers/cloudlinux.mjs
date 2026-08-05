import { normalizeApps } from '../probe.mjs';
import { UserError } from '../ui.mjs';
import { t } from '../i18n/index.mjs';
import { exec, shellLine } from '../shell/cron-bridge.mjs';
import * as remote from '../remote.mjs';
import { request } from '../http.mjs';

/**
 * CloudLinux Node.js Selector sürücüsü.
 *
 * CloudLinux'un API'si YOKTUR — cPanel'in 96 UAPI modülünün hiçbiri ona
 * dokunmaz. Tek arayüz `/usr/sbin/cloudlinux-selector` CLI'ı. Bu yüzden
 * yazma işlemleri cron köprüsünden (bkz. shell/cron-bridge.mjs) geçiyor.
 *
 * OKUMA işlemleri köprüden GEÇMEZ: `~/.cl.selector/node-selector.json`
 * doğrudan Fileman ile okunabiliyor. Bir listeleme için 60 saniye cron
 * beklemek anlamsız olurdu.
 */
export const id = 'cloudlinux';
export const label = 'CloudLinux Node.js Selector';

export const capabilities = {
  perAppNodeVersion: true,
  envVars: true,
  restart: true,
  destroy: true, // cloudlinux-selector destroy var — ama faz 1'de kullanmıyoruz
};

const SELECTOR = '/usr/sbin/cloudlinux-selector';

export async function detect(ctx) {
  return ctx.probeResult?.regime === 'cloudlinux';
}

/**
 * Uygulamaları listeler — cron kullanmadan.
 *
 * Sıra: probe'un zaten aldığı PassengerApps listesi → node-selector.json →
 * (son çare) cron ile `cloudlinux-selector get`.
 */
export async function listApps(ctx) {
  if (ctx.probeResult?.apps?.length) return ctx.probeResult.apps;

  try {
    const raw = await ctx.client.uapi('PassengerApps', 'list_applications', {});
    const apps = normalizeApps(raw);
    if (apps.length) return apps;
  } catch {
    /* CloudLinux'ta bu modül kapalı olabilir */
  }

  const selector = await remote.readJson(ctx.client, '.cl.selector', 'node-selector.json');
  if (selector && typeof selector === 'object') {
    return Object.entries(selector).map(([appRoot, data]) => ({
      name: appRoot.split('/').pop(),
      path: appRoot,
      domain: data.domain,
      baseUri: data.app_uri ?? '/',
      mode: data.app_mode ?? 'production',
      enabled: String(data.app_status ?? '') === 'started',
      status: data.app_status,
      nodeVersion: String(data.nodejs_version ?? ''),
      startupFile: data.startup_file,
      envvars: data.env_vars ?? {},
    }));
  }

  return [];
}

export async function findApp(ctx, { name, path: appPath, domain }) {
  const apps = await listApps(ctx);
  return (
    apps.find((a) => appPath && remote.rel(a.path) === remote.rel(appPath)) ||
    apps.find((a) => name && a.name === name) ||
    apps.find((a) => domain && a.domain === domain) ||
    null
  );
}

/* ------------------------------------------------------------- tek seferde */

/**
 * Tüm sunucu adımlarını TEK cron turunda yapar.
 *
 * Bunlar ayrı ayrı çağrılsaydı her biri ~60-90 sn cron beklemesi demekti
 * (dur → oluştur → kur → başlat = 4-6 dakika). Tek betikte hepsi ardışık
 * koşuyor; bekleme bir tur.
 */
export async function applyAll(ctx, spec) {
  const {
    appRoot,
    domain,
    startupFile = 'server.js',
    nodeVersion = null,
    isNew,
    existingAppRoot = null,
    onProgress,
  } = spec;

  const user = ctx.client.user;
  const target = `/home/${user}/${remote.rel(appRoot)}`;
  const known = existingAppRoot ? remote.rel(existingAppRoot) : remote.rel(appRoot);

  const php = [];

  php.push(`    $clUser = ${JSON.stringify(user)};`);
  php.push(`    $appRoot = ${JSON.stringify(remote.rel(appRoot))};`);
  php.push(`    $targetDir = ${JSON.stringify(target)};`);
  php.push(`    $nodeVer = ${JSON.stringify(String(nodeVersion ?? ''))};`);

  // Uygulamayı selector kaydında bul; sürümü oradan al.
  php.push(`
    deha_progress(10, 'Uygulama tespit ediliyor');
    $selectorFile = "/home/$clUser/.cl.selector/node-selector.json";
    $foundRoot = null;
    if (file_exists($selectorFile)) {
        $sel = json_decode((string)file_get_contents($selectorFile), true);
        if (is_array($sel)) {
            if (isset($sel[${JSON.stringify(known)}])) {
                $foundRoot = ${JSON.stringify(known)};
                if ($nodeVer === '') { $nodeVer = (string)($sel[$foundRoot]['nodejs_version'] ?? ''); }
            } else {
                foreach ($sel as $r => $d) {
                    if (basename($r) === basename($appRoot)) {
                        $foundRoot = $r;
                        if ($nodeVer === '') { $nodeVer = (string)($d['nodejs_version'] ?? ''); }
                        break;
                    }
                }
            }
        }
    }
    if ($nodeVer === '') { $nodeVer = '22'; }
    $DEHA_OUTPUT .= ($foundRoot ? "Uygulama: $foundRoot (Node $nodeVer)\\n" : "Yeni uygulama: $appRoot\\n");`);

  if (!isNew) {
    php.push(`
    if ($foundRoot) {
        deha_progress(20, 'Uygulama durduruluyor');
        $DEHA_OUTPUT .= (string)@shell_exec("${SELECTOR} stop --json --interpreter nodejs --user $clUser --app-root " . escapeshellarg($foundRoot) . " 2>&1") . "\\n";
    }`);
  }

  // create — YALNIZCA kayıt yoksa.
  // ⚠ `--user` BİLEREK VERİLMİYOR: bazı hesaplarda create --user ile hata
  // veriyor ve komut zaten cPanel kullanıcı bağlamında koşuyor.
  php.push(`
    if (!$foundRoot) {
        deha_progress(45, 'Node.js uygulamasi olusturuluyor');
        $out = (string)@shell_exec("${SELECTOR} create --json --interpreter nodejs --domain " . escapeshellarg(${JSON.stringify(domain)}) . " --app-root " . escapeshellarg($appRoot) . " --app-uri / --version " . escapeshellarg($nodeVer) . " --app-mode production --startup-file " . escapeshellarg(${JSON.stringify(startupFile)}) . " --env-vars '{}' 2>&1");
        $DEHA_OUTPUT .= $out . "\\n";
        $j = json_decode($out, true);
        if (is_array($j) && isset($j['result']) && $j['result'] !== 'success') {
            throw new Exception('cloudlinux-selector create basarisiz: ' . substr($out, 0, 400));
        }
        $foundRoot = $appRoot;
    }`);

  php.push(`
    deha_progress(65, 'Bagimliliklar kuruluyor');
    $DEHA_OUTPUT .= (string)@shell_exec("${SELECTOR} install-modules --json --interpreter nodejs --user $clUser --app-root " . escapeshellarg($foundRoot) . " 2>&1") . "\\n";
    if (!file_exists("$targetDir/node_modules")) {
        throw new Exception('node_modules olusmadi - install-modules basarisiz');
    }`);

  php.push(`
    deha_progress(88, 'Uygulama baslatiliyor');
    $DEHA_OUTPUT .= (string)@shell_exec("${SELECTOR} start --json --interpreter nodejs --user $clUser --app-root " . escapeshellarg($foundRoot) . " 2>&1") . "\\n";
    @mkdir("$targetDir/tmp", 0755, true);
    @touch("$targetDir/tmp/restart.txt");

    deha_progress(95, 'Dogrulaniyor');
    $sel2 = @json_decode((string)@file_get_contents($selectorFile), true);
    $st = (is_array($sel2) && isset($sel2[$foundRoot])) ? (string)$sel2[$foundRoot]['app_status'] : 'bilinmiyor';
    $DEHA_OUTPUT .= "Durum: $st\\n";`);

  const result = await exec(ctx, php.join('\n'), {
    label: t('cron.appLabel'),
    onProgress: (step, pct) => onProgress?.(step, pct),
    timeout: 25 * 60_000,
  });

  ctx.client.log(result.output);
  return result;
}

/* --------------------------------------------------- tekil işlemler (yedek) */

export async function createApp(ctx, spec) {
  await applyAll(ctx, { ...spec, isNew: true });
  return findApp(ctx, { path: spec.appRoot, name: spec.name, domain: spec.domain });
}

export async function installDeps(ctx, app, { onProgress } = {}) {
  const root = remote.rel(app.path);
  return exec(
    ctx,
    shellLine(
      `${SELECTOR} install-modules --json --interpreter nodejs --user ${ctx.client.user} --app-root ${root}`,
      { progress: 50, label: 'Bagimliliklar kuruluyor' }
    ),
    { label: t('cron.depsLabel'), onProgress }
  );
}

export async function stop(ctx, app) {
  const root = remote.rel(app.path);
  return exec(
    ctx,
    shellLine(
      `${SELECTOR} stop --json --interpreter nodejs --user ${ctx.client.user} --app-root ${root}`,
      { progress: 50, label: 'Durduruluyor' }
    ),
    { label: t('cron.stopLabel') }
  );
}

export async function start(ctx, app) {
  const root = remote.rel(app.path);
  return exec(
    ctx,
    shellLine(
      `${SELECTOR} start --json --interpreter nodejs --user ${ctx.client.user} --app-root ${root}`,
      { progress: 50, label: 'Baslatiliyor' }
    ),
    { label: t('cron.startLabel') }
  );
}

/**
 * Yeniden başlatma.
 *
 * CloudLinux'ta `restart` komutu var ve tercih edilir. Ama cron turu 60 sn
 * beklemek demek; oysa `tmp/restart.txt` dokunmak da işi görür. Bu yüzden
 * önce dosyayı yazıyoruz, sonra uygulamaya bir istek atarak spawn'ı
 * tetikliyoruz. Passenger bu dosyayı YALNIZCA istek geldiğinde kontrol eder
 * ve `PassengerStatThrottleRate` (varsayılan 10 sn) ile kısıtlıdır.
 */
export async function restart(ctx, app, { url = null, wait = 11_000 } = {}) {
  const root = remote.rel(app.path);
  try {
    await remote.saveFile(ctx.client, `${root}/tmp`, 'restart.txt', `${new Date().toISOString()}\n`);
  } catch {
    await remote.mkdirp(ctx.client, `${root}/tmp`);
    await remote.saveFile(ctx.client, `${root}/tmp`, 'restart.txt', `${new Date().toISOString()}\n`);
  }
  await sleep(wait);
  if (url) {
    try {
      await request(url, { timeout: 60_000, rejectUnauthorized: false, maxRedirects: 3 });
    } catch {
      /* amaç spawn'ı tetiklemek */
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { UserError };
