import fs from 'node:fs';
import { CAPABILITIES_FILE, ensureHomeDir } from './paths.mjs';
import { t } from './i18n/index.mjs';

/**
 * Sunucunun ne yapabildiğini tespit eder.
 *
 * Platform VARSAYMIYORUZ, yetenek SORUYORUZ. Aynı cPanel sürümünde iki host
 * bambaşka yapılandırılmış olabilir: biri Application Manager'ı açık bırakır,
 * öbürü kapatıp CloudLinux Node.js Selector verir, üçüncüsü ikisini birden
 * sunar. Tek doğru cevap, o hesapta gerçekte neyin cevap verdiğidir.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function probe(client, { refresh = false, verbose = false } = {}) {
  const key = `${client.host}:${client.port}:${client.user}`;
  if (!refresh) {
    const cached = readCache(key);
    if (cached) return { ...cached, cached: true };
  }

  const evidence = [];
  const result = {
    key,
    regime: 'unknown',
    hasPassengerApps: false,
    hasWebApp: false,
    apps: [],
    maxApps: null,
    nodeBinary: null,
    evidence,
    checkedAt: new Date().toISOString(),
  };

  // 1) cPanel 138+ WebApp — henüz yayında değil, ama varsa bilmek isteriz.
  try {
    const webapp = await client.uapi('WebApp', 'has_feature', {});
    result.hasWebApp = Boolean(Number(webapp?.has_feature ?? webapp));
    if (result.hasWebApp) evidence.push(t('probe.webappAvailable'));
  } catch {
    /* beklenen: bu sürümde modül yok */
  }

  // 2) Asıl sinyal: PassengerApps cevap veriyor mu, ve verdiği `nodejs` yolu
  //    CloudLinux venv'ine mi işaret ediyor.
  try {
    const list = await client.uapi('PassengerApps', 'list_applications', {});
    result.hasPassengerApps = true;
    result.apps = normalizeApps(list);
    evidence.push(t('probe.passengerResponded', { count: result.apps.length }));

    const venvApp = result.apps.find((a) => a.nodeBinary && a.nodeBinary.includes('/nodevenv/'));
    if (venvApp) {
      result.regime = 'cloudlinux';
      result.nodeBinary = venvApp.nodeBinary;
      evidence.push(t('probe.venvSeen', { path: venvApp.nodeBinary }));
    } else {
      const anyNode = result.apps.find((a) => a.nodeBinary);
      if (anyNode) {
        result.nodeBinary = anyNode.nodeBinary;
        evidence.push(t('probe.nodePath', { path: anyNode.nodeBinary }));
      }
    }
  } catch (err) {
    evidence.push(t('probe.passengerUnavailable', { error: err.message }));
  }

  // 3) Uygulama listesi boşsa venv yolundan karar veremeyiz; ev dizinine bak.
  if (result.regime === 'unknown') {
    if (await pathExists(client, 'nodevenv')) {
      result.regime = 'cloudlinux';
      evidence.push(t('probe.nodevenvDir'));
    } else if (result.hasPassengerApps) {
      result.regime = 'passenger';
      evidence.push(t('probe.assumedStock'));
    }
  }

  // 4) PassengerApps hiç cevap vermediyse özellik gerçekten kapalı mı diye sor.
  if (!result.hasPassengerApps) {
    const enabled = await client.hasFeature('passengerapps');
    evidence.push(enabled ? t('probe.featureOn') : t('probe.featureOff'));
    if (!enabled && (await pathExists(client, 'nodevenv'))) {
      result.regime = 'cloudlinux';
    }
  }

  /*
   * 5) CloudLinux'ta uygulama listesini node-selector.json'dan tamamla.
   *
   * İki kayıt defteri AYRI: cln02'de `PassengerApps::list_applications` 0
   * uygulama dönerken `~/.cl.selector/node-selector.json` içinde kayıtlı bir
   * uygulama vardı. Yani PassengerApps'in boş dönmesi "uygulama yok" demek
   * DEĞİL — CloudLinux tarafına ayrıca bakmak zorundayız.
   */
  if (result.regime === 'cloudlinux' && !result.apps.length) {
    const selector = await readSelector(client);
    if (selector) {
      result.apps = Object.entries(selector).map(([appRoot, d]) => ({
        name: appRoot.split('/').pop(),
        path: appRoot,
        domain: d.domain,
        baseUri: d.app_uri ?? '/',
        mode: d.app_mode ?? 'production',
        enabled: String(d.app_status ?? '') === 'started',
        status: d.app_status,
        nodeVersion: String(d.nodejs_version ?? ''),
        startupFile: d.startup_file,
        envvars: d.env_vars ?? {},
      }));
      evidence.push(t('probe.selectorApps', { count: result.apps.length }));
    }
  }

  try {
    const info = await client.whoami();
    if (info?.maximum_passenger_apps !== undefined) {
      result.maxApps = info.maximum_passenger_apps;
    }
  } catch {
    /* önemsiz */
  }

  if (verbose) for (const line of evidence) console.error('  ›', line);

  writeCache(key, result);
  return result;
}

/**
 * `list_applications` bazı sürümlerde ada göre anahtarlı nesne, bazılarında
 * dizi döndürüyor. İkisini de tek biçime indiriyoruz.
 */
export function normalizeApps(raw) {
  const entries = Array.isArray(raw) ? raw : Object.entries(raw || {}).map(([name, v]) => ({ name, ...v }));
  return entries
    .filter((a) => a && (a.name || a.path))
    .map((a) => ({
      name: a.name,
      path: a.path,
      domain: a.domain,
      baseUri: a.base_uri ?? '/',
      mode: a.deployment_mode ?? 'production',
      enabled: Number(a.enabled ?? 1) === 1,
      envvars: a.envvars ?? {},
      deps: a.deps ?? {},
      nodeBinary: a.nodejs ?? null,
      nodeVersion: extractNodeVersion(a.nodejs),
    }));
}

function extractNodeVersion(binary) {
  if (!binary) return null;
  // /home/u/nodevenv/app/22/bin/node   → 22
  // /opt/cpanel/ea-nodejs22/bin/node   → 22
  const venv = binary.match(/\/nodevenv\/[^/]+\/(\d+)\//);
  if (venv) return venv[1];
  const ea = binary.match(/ea-nodejs(\d+)/);
  if (ea) return ea[1];
  return null;
}

/** CloudLinux'un uygulama kaydı. Okunamazsa null. */
async function readSelector(client) {
  try {
    const data = await client.uapiPost('Fileman', 'get_file_content', {
      dir: '.cl.selector',
      file: 'node-selector.json',
    });
    const raw = data?.content;
    if (!raw) return null;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Ev dizinine göreli bir yol var mı — ucuz kontrol, hata yutulur. */
async function pathExists(client, relPath) {
  try {
    await client.uapi('Fileman', 'get_file_information', { path: relPath });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ cache */

function readCache(key) {
  try {
    const all = JSON.parse(fs.readFileSync(CAPABILITIES_FILE, 'utf8'));
    const entry = all[key];
    if (!entry) return null;
    if (Date.now() - new Date(entry.checkedAt).getTime() > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  ensureHomeDir();
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(CAPABILITIES_FILE, 'utf8'));
  } catch {
    /* ilk yazım */
  }
  // Kanıt satırları önbelleğe GİRMEZ: üretildikleri dilde donarlar ve kullanıcı
  // dili değiştirdiğinde eski dilde geri gelirlerdi. Zaten yalnızca tanılama
  // içindir ve `doctor` her zaman taze sonda atıyor.
  const { evidence, ...cacheable } = value;
  all[key] = cacheable;
  try {
    fs.writeFileSync(CAPABILITIES_FILE, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* önbellek yazılamazsa çalışmaya devam */
  }
}

export function clearCache() {
  try {
    fs.unlinkSync(CAPABILITIES_FILE);
    return true;
  } catch {
    return false;
  }
}
