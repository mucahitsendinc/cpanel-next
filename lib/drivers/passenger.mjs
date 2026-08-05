import { normalizeApps } from '../probe.mjs';
import { UserError } from '../ui.mjs';
import { t } from '../i18n/index.mjs';
import { request } from '../http.mjs';

/**
 * Stok cPanel Application Manager sürücüsü — saf UAPI.
 *
 * cPanel 66+ (yalnız `ensure_deps` 80+). CloudLinux gerektirmiyor; hostun
 * `ea-*-mod_passenger` kurmuş ve `passengerapps` özelliğini açmış olması yeter.
 *
 * Bu sürücünün tamamı token'la (T1) çalışır: shell yok, cron yok, tarayıcı yok.
 */
export const id = 'passenger';
export const label = 'cPanel Application Manager';

export const capabilities = {
  perAppNodeVersion: false, // cPanel: "yeni uygulamalar en yeni Node sürümünü kullanır"
  envVars: true,
  restart: false, // API'de restart YOK — tmp/restart.txt ile yapılıyor
  destroy: false, // unregister yalnız kaydı siler, dosyaları silmez
};

export async function detect(ctx) {
  return ctx.probeResult?.hasPassengerApps === true;
}

export async function listApps(ctx) {
  const raw = await ctx.client.uapi('PassengerApps', 'list_applications', {});
  return normalizeApps(raw);
}

export async function findApp(ctx, { name, path: appPath, domain }) {
  const apps = await listApps(ctx);
  return (
    apps.find((a) => name && a.name === name) ||
    apps.find((a) => appPath && normalizePath(a.path) === normalizePath(appPath)) ||
    apps.find((a) => domain && a.domain === domain) ||
    null
  );
}

/**
 * Uygulamayı KAYDEDER.
 *
 * ⚠ cPanel'in kendi ifadesiyle: "This function only registers an application.
 * It does not create the application. You must create an application before
 * you register the application." Yani dosyalar ÖNCE yerinde olmalı — çağrı
 * sırası: yükle → çıkart → kaydet.
 */
export async function createApp(ctx, spec) {
  const { name, appRoot, domain, baseUri = '/', mode = 'production', env = {} } = spec;

  if (ctx.probeResult?.maxApps !== undefined && ctx.probeResult?.maxApps !== null) {
    const max = ctx.probeResult.maxApps;
    if (max !== 'unlimited') {
      const current = (await listApps(ctx)).length;
      if (current >= Number(max)) {
        throw new UserError(t('driver.quotaFull', { current, max }), t('driver.quotaFullHint'));
      }
    }
  }

  const params = {
    name,
    path: appRoot, // ev dizinine GÖRELİ — mutlak yol değil
    domain,
    base_uri: baseUri,
    deployment_mode: mode,
    enabled: 1, // Apache yapılandırmasını da üretir
    ...envParams(env),
  };

  await ctx.client.uapiPost('PassengerApps', 'register_application', params);
  return findApp(ctx, { name });
}

export async function editApp(ctx, name, changes = {}) {
  const params = { name };
  if (changes.newName) params.new_name = changes.newName;
  if (changes.appRoot) params.path = changes.appRoot;
  if (changes.domain) params.domain = changes.domain;
  if (changes.baseUri) params.base_uri = changes.baseUri;
  if (changes.mode) params.deployment_mode = changes.mode;
  if (changes.enabled !== undefined) params.enabled = changes.enabled ? 1 : 0;
  if (changes.env) {
    params.clear_envvars = 1;
    Object.assign(params, envParams(changes.env));
  }
  return ctx.client.uapiPost('PassengerApps', 'edit_application', params);
}

export async function stop(ctx, app, { onProgress } = {}) {
  return ctx.client.uapiPost('PassengerApps', 'disable_application', { name: app.name });
}

export async function start(ctx, app, { onProgress } = {}) {
  return ctx.client.uapiPost('PassengerApps', 'enable_application', { name: app.name });
}

/**
 * `npm install` karşılığı — shell olmadan.
 *
 * `ensure_deps` bir arka plan görevi başlatıyor ve `{task_id, sse_url}`
 * döndürüyor. SSE akışını sonuna kadar okumak, işin bitmesini beklemenin en
 * temiz yolu; akış kurulamazsa `UserTasks::retrieve` ile yokluyoruz.
 */
export async function installDeps(ctx, app, { onProgress, timeout = 900_000 } = {}) {
  const appPath = app.path.startsWith('/') ? app.path : `/home/${ctx.client.user}/${app.path}`;
  const started = await ctx.client.uapiPost('PassengerApps', 'ensure_deps', {
    app_path: appPath,
    type: 'npm',
  });

  const taskId = started?.task_id ?? started?.taskid ?? null;
  const sseUrl = started?.sse_url ?? null;

  if (sseUrl) {
    try {
      await followSse(ctx, sseUrl, { onProgress, timeout });
      return { taskId, via: 'sse' };
    } catch (err) {
      ctx.client.log(`sse stream failed (${err.message}), falling back to polling`);
    }
  }

  if (taskId) {
    await pollUserTask(ctx, taskId, { onProgress, timeout });
    return { taskId, via: 'poll' };
  }

  // Ne görev kimliği ne akış geldiyse iş muhtemelen eşzamanlı bitti.
  return { taskId: null, via: 'sync' };
}

async function followSse(ctx, sseUrl, { onProgress, timeout }) {
  const url = sseUrl.startsWith('http')
    ? sseUrl
    : `${ctx.client.origin}${ctx.client.prefix}${sseUrl.startsWith('/') ? '' : '/'}${sseUrl}`;

  const res = await request(url, {
    headers: { ...ctx.client.authHeaders(), Accept: 'text/event-stream' },
    rejectUnauthorized: !ctx.client.insecure,
    timeout,
  });

  const text = res.text;
  if (onProgress) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) onProgress(line.slice(5).trim());
    }
  }
  if (/error|failed/i.test(text) && !/0 errors/i.test(text)) {
    ctx.client.log(`ensure_deps output contains an error trace: ${text.slice(-300)}`);
  }
  return text;
}

async function pollUserTask(ctx, taskId, { onProgress, timeout }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(3000);
    let tasks;
    try {
      tasks = await ctx.client.uapi('UserTasks', 'retrieve', {});
    } catch {
      return; // görev listesi okunamıyorsa bekleyip devam etmek yanlış olur
    }
    const list = Array.isArray(tasks) ? tasks : Object.values(tasks || {});
    const mine = list.find((t) => String(t.id ?? t.task_id) === String(taskId));
    if (!mine) return; // listeden düştü = bitti
    if (onProgress && mine.status) onProgress(String(mine.status));
    if (/complete|finished|success/i.test(String(mine.status || ''))) return;
    if (/fail|error/i.test(String(mine.status || ''))) {
      throw new UserError(t('driver.depsFailed', { message: mine.message || mine.status }));
    }
  }
  throw new UserError(t('driver.depsTimeout'));
}

/**
 * Uygulamayı kaldırır.
 *
 * ⚠ cPanel'in kendi ifadesiyle `unregister_application` "yalnızca kaydı
 * siler, uygulamayı SİLMEZ". Dosyaları kaldırmak ayrı bir iş ve yalnızca
 * açıkça istendiğinde yapılıyor.
 */
export async function destroyApp(ctx, app, { deleteFiles = false, onProgress } = {}) {
  await ctx.client.uapiPost('PassengerApps', 'disable_application', { name: app.name }).catch(() => {});
  await ctx.client.uapiPost('PassengerApps', 'unregister_application', { name: app.name });

  if (deleteFiles) {
    const root = String(app.path ?? '').replace(/^\/+|\/+$/g, '');
    if (root) {
      await ctx.client.api2('Fileman', 'fileop', {
        op: 'unlink',
        sourcefiles: `/${root}`,
        doubledecode: '0',
      });
    }
  }
  return { destroyed: app.name, filesDeleted: deleteFiles };
}

/**
 * Yeniden başlatma.
 *
 * ⚠ `PassengerApps`'te restart fonksiyonu YOK. Passenger `tmp/restart.txt`
 * dosyasının zaman damgası değişince yeniden başlar — ama iki kısıt var:
 * `PassengerStatThrottleRate` (varsayılan 10 sn) ve dosyanın YALNIZCA bir
 * istek geldiğinde kontrol edilmesi. Bu yüzden yazdıktan sonra bekleyip
 * uygulamaya bir istek atıyoruz; yoksa "yeniden başlattım" demek yalan olur.
 */
export async function restart(ctx, app, { url = null, wait = 11_000 } = {}) {
  const appPath = app.path.replace(/^\/+|\/+$/g, '');
  await touchRestartFile(ctx, appPath);
  await sleep(wait);
  if (url) {
    try {
      await request(url, { timeout: 60_000, rejectUnauthorized: false, maxRedirects: 3 });
    } catch {
      /* isteğin amacı spawn'ı tetiklemek; hata burada anlamlı değil */
    }
  }
}

async function touchRestartFile(ctx, appPath) {
  const content = `${new Date().toISOString()}\n`;
  try {
    await ctx.client.uapiPost('Fileman', 'save_file_content', {
      dir: `${appPath}/tmp`,
      file: 'restart.txt',
      content,
      from_charset: 'UTF-8',
      to_charset: 'UTF-8',
    });
    return;
  } catch (err) {
    ctx.client.log(`could not write restart.txt (${err.message}), creating tmp/`);
  }

  // tmp/ yoksa oluştur. UAPI'de mkdir yok; API2 fileop kullanıyoruz.
  await ctx.client.api2('Fileman', 'mkdir', { path: appPath, name: 'tmp' });
  await ctx.client.uapiPost('Fileman', 'save_file_content', {
    dir: `${appPath}/tmp`,
    file: 'restart.txt',
    content,
    from_charset: 'UTF-8',
    to_charset: 'UTF-8',
  });
}

/**
 * `envvar_name` / `envvar_value` KONUMSAL eşleşen tekrarlı parametrelerdir:
 *   ?envvar_name=A&envvar_value=1&envvar_name=B&envvar_value=2
 * Her `envvar_name` için bir `envvar_value` göndermek zorunlu; sıralar eşleşir.
 */
function envParams(env) {
  const names = Object.keys(env || {});
  if (!names.length) return {};
  return {
    envvar_name: names,
    envvar_value: names.map((n) => String(env[n])),
  };
}

function normalizePath(p) {
  return String(p || '').replace(/^\/+|\/+$/g, '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
