import { normalizeApps } from '../probe.mjs';
import { UserError } from '../ui.mjs';
import { t } from '../i18n/index.mjs';
import { execViaWorker, shq } from '../shell/worker.mjs';
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
    cleanModules = false,
    hooks = {},
    onProgress,
    onStart,
  } = spec;

  const user = ctx.client.user;
  const home = `/home/${user}`;
  const root = remote.rel(existingAppRoot || appRoot);
  const target = `${home}/${remote.rel(appRoot)}`;

  /*
   * Uygulamayı ve Node sürümünü İSTEMCİDE çözüyoruz.
   *
   * Eskiden bu iş sunucudaki PHP betiğinde, elle JSON ayrıştırarak yapılıyordu.
   * Oysa `node-selector.json` Fileman ile zaten okunabiliyor; burada okuyup
   * değerleri betiğe gömmek hem çok daha basit hem de kabukta JSON ayrıştırma
   * derdini tamamen ortadan kaldırıyor.
   */
  const selector = await remote.readJson(ctx.client, '.cl.selector', 'node-selector.json').catch(() => null);
  let foundRoot = null;
  let version = nodeVersion ? String(nodeVersion) : null;
  if (selector && typeof selector === 'object') {
    if (selector[root]) foundRoot = root;
    else {
      for (const [key, data] of Object.entries(selector)) {
        if (key.split('/').pop() === root.split('/').pop()) {
          foundRoot = key;
          version = version ?? String(data?.nodejs_version ?? '');
          break;
        }
      }
    }
    if (foundRoot && !version) version = String(selector[foundRoot]?.nodejs_version ?? '');
  }
  if (!version) version = '22';

  const SEL = SELECTOR;
  const lines = [];
  const push = (pct, label, cmd) => {
    lines.push(`cn_progress ${pct} ${shq(label)}`);
    if (cmd) lines.push(cmd);
  };

  lines.push(`APPDIR=${shq(target)}`);
  lines.push(`cd "$APPDIR" 2>/dev/null || cn_fail "uygulama dizini yok: $APPDIR"`);

  if (!isNew && foundRoot) {
    push(20, 'Uygulama durduruluyor',
      `${SEL} stop --json --interpreter nodejs --user ${user} --app-root ${shq(foundRoot)} 2>&1 || true`);
  }

  if (!foundRoot) {
    // ⚠ `--user` BİLEREK VERİLMİYOR: bazı hesaplarda create --user ile hata
    // veriyor ve komut zaten kullanıcı bağlamında koşuyor.
    push(40, 'Node.js uygulamasi olusturuluyor',
      `${SEL} create --json --interpreter nodejs --domain ${shq(domain)} --app-root ${shq(remote.rel(appRoot))} ` +
      `--app-uri / --version ${shq(version)} --app-mode production --startup-file ${shq(startupFile)} --env-vars '{}' 2>&1`);
    lines.push(`[ -d ${shq(`${home}/nodevenv/${remote.rel(appRoot)}`)} ] || cn_fail "cloudlinux-selector create basarisiz"`);
    foundRoot = remote.rel(appRoot);
  }

  if (cleanModules) {
    push(50, 'node_modules siliniyor', `rm -rf "$APPDIR/node_modules" 2>&1 || true`);
  }

  // --- HOOK: npm install ÖNCESİ ---
  for (const cmd of hooks.preInstall ?? []) {
    push(55, `Hook (kurulum oncesi): ${short(cmd)}`, `sh -c ${shq(cmd)} 2>&1 || cn_fail ${shq(`preInstall basarisiz: ${cmd}`)}`);
  }

  push(65, 'Bagimliliklar kuruluyor',
    `${SEL} install-modules --json --interpreter nodejs --user ${user} --app-root ${shq(foundRoot)} 2>&1`);
  lines.push(`[ -e "$APPDIR/node_modules" ] || cn_fail "node_modules olusmadi - install-modules basarisiz"`);

  // --- HOOK: npm install SONRASI (migration vb.) ---
  for (const cmd of hooks.postInstall ?? []) {
    push(75, `Hook (kurulum sonrasi): ${short(cmd)}`, hookLine(cmd, home, foundRoot, version));
  }

  push(88, 'Uygulama baslatiliyor',
    `${SEL} start --json --interpreter nodejs --user ${user} --app-root ${shq(foundRoot)} 2>&1 || true`);
  lines.push(`mkdir -p "$APPDIR/tmp" && touch "$APPDIR/tmp/restart.txt"`);

  // --- HOOK: uygulama BAŞLADIKTAN sonra ---
  for (const cmd of hooks.postStart ?? []) {
    push(95, `Hook (baslatma sonrasi): ${short(cmd)}`, hookLine(cmd, home, foundRoot, version));
  }

  const result = await execViaWorker(ctx, lines.join('\n'), {
    label: t('cron.appLabel'),
    onProgress: (step, pct) => onProgress?.(step, pct),
    onStart,
    timeout: 25 * 60_000,
  });

  ctx.client.log(result.output);
  return result;
}

/**
 * Hook komutunu, uygulamanın Node sürümü PATH'te olacak şekilde çalıştırır.
 *
 * `npx prisma migrate` gibi komutlar `node`/`npx` bulamazsa patlar; CloudLinux
 * bunları venv içine koyuyor. Venv'in bin dizinini PATH'in başına ekliyoruz.
 */
function hookLine(cmd, home, appRoot, version) {
  const bin = `${home}/nodevenv/${appRoot}/${version}/bin`;
  return `PATH=${shq(bin)}:$PATH sh -c ${shq(cmd)} 2>&1 || cn_fail ${shq(`hook basarisiz: ${cmd}`)}`;
}

function short(cmd) {
  const s = String(cmd).replace(/\s+/g, ' ').trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/* --------------------------------------------------- tekil işlemler (yedek) */

export async function createApp(ctx, spec) {
  await applyAll(ctx, { ...spec, isNew: true });
  return findApp(ctx, { path: spec.appRoot, name: spec.name, domain: spec.domain });
}

export async function installDeps(ctx, app, { onProgress } = {}) {
  const root = remote.rel(app.path);
  return execViaWorker(
    ctx,
    `cn_progress 50 'Bagimliliklar kuruluyor'\n${SELECTOR} install-modules --json --interpreter nodejs --user ${ctx.client.user} --app-root ${shq(root)} 2>&1`,
    { label: t('cron.depsLabel'), onProgress }
  );
}

export async function stop(ctx, app, { onProgress } = {}) {
  const root = remote.rel(app.path);
  return execViaWorker(
    ctx,
    `cn_progress 50 'Durduruluyor'\n${SELECTOR} stop --json --interpreter nodejs --user ${ctx.client.user} --app-root ${shq(root)} 2>&1`,
    { label: t('cron.stopLabel'), onProgress }
  );
}

export async function start(ctx, app, { onProgress } = {}) {
  const root = remote.rel(app.path);
  return execViaWorker(
    ctx,
    `cn_progress 50 'Baslatiliyor'\n${SELECTOR} start --json --interpreter nodejs --user ${ctx.client.user} --app-root ${shq(root)} 2>&1`,
    { label: t('cron.startLabel'), onProgress }
  );
}

/**
 * Uygulamayı kaldırır.
 *
 * `cloudlinux-selector destroy` kaydı siler ve venv'i kaldırır; docroot'taki
 * Passenger bloğunu da o temizliyor. Uygulama DOSYALARI ayrı bir karar:
 * `deleteFiles` verilmedikçe klasör olduğu gibi kalıyor, çünkü çoğu zaman
 * istenen "yayından kaldır", "her şeyi sil" değil.
 */
export async function destroyApp(ctx, app, { deleteFiles = false, onProgress } = {}) {
  const root = remote.rel(app.path);
  const home = `/home/${ctx.client.user}`;
  const lines = [
    `cn_progress 20 'Uygulama durduruluyor'`,
    `${SELECTOR} stop --json --interpreter nodejs --user ${ctx.client.user} --app-root ${shq(root)} 2>&1 || true`,
    `cn_progress 50 'Kayit siliniyor'`,
    `${SELECTOR} destroy --json --interpreter nodejs --user ${ctx.client.user} --app-root ${shq(root)} 2>&1 || true`,
  ];
  if (deleteFiles) {
    // Ev dizininin kendisini asla silmeyelim: boş app-root felakete yol açar.
    lines.push(
      `cn_progress 80 'Dosyalar siliniyor'`,
      `[ -n ${shq(root)} ] && rm -rf ${shq(`${home}/${root}`)} 2>&1 || true`
    );
  }
  await execViaWorker(ctx, lines.join('\n'), { label: t('apps.deleteLabel'), timeout: 10 * 60_000, onProgress });
  return { destroyed: root, filesDeleted: deleteFiles };
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
