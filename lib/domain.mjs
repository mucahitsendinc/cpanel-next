import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * Hesabın içindeki domainler.
 *
 * cPanel SUNUCUSUNUN adı (giriş yaptığımız `sunucu.hosting.com`) ile hesabın
 * içindeki domainler bambaşka şeylerdir. Tek bir cPanel hesabında şunların
 * hepsi birden bulunabilir:
 *
 *   main    → hesabın ana domaini            (docroot: public_html)
 *   addon   → hesaba eklenmiş ayrı domain    (docroot: genellikle public_html/<ad>)
 *   sub     → subdomain                       (docroot: serbest)
 *   parked  → ana domaine yönlenen takma ad  (kendi docroot'u yok)
 *
 * Bu yüzden kullanıcıya domain YAZDIRMIYORUZ, hesapta gerçekten ne varsa onu
 * LİSTELİYORUZ. Docroot'u da her zaman API'den okuyoruz: addon domainlerin
 * docroot'u `/home/<user>/<domain>` DEĞİLDİR, varsaymak sessiz hataya yol açar.
 */

export async function listDomains(client) {
  const domains = [];

  // `domains_data` en zengin kaynak: tür + belge kökü birlikte geliyor.
  try {
    const data = await client.uapi('DomainInfo', 'domains_data', { format: 'hash' });
    collectFromDomainsData(data, domains);
    if (domains.length) return dedupe(domains);
  } catch {
    /* eski sürümlerde yok; aşağıdaki yola düşüyoruz */
  }

  // Yedek: list_domains (tür var, docroot yok) + listsubdomains (docroot var).
  try {
    const list = await client.uapi('DomainInfo', 'list_domains', {});
    if (list?.main_domain) {
      domains.push({ domain: list.main_domain, type: 'main', docroot: null });
    }
    for (const d of list?.addon_domains || []) domains.push({ domain: d, type: 'addon', docroot: null });
    for (const d of list?.sub_domains || []) domains.push({ domain: d, type: 'sub', docroot: null });
    for (const d of list?.parked_domains || []) domains.push({ domain: d, type: 'parked', docroot: null });
  } catch (err) {
    throw new UserError(t('domain.listFailed', { error: err.message }), t('domain.listFailedHint'));
  }

  // Subdomain docroot'larını tamamla.
  try {
    const subs = await client.uapi('SubDomain', 'listsubdomains', {});
    const rows = Array.isArray(subs) ? subs : Object.values(subs || {});
    for (const row of rows) {
      const full = row.domain ?? row.subdomain;
      const hit = domains.find((d) => d.domain === full);
      const docroot = row.dir ?? row.documentroot ?? row.reldir ?? null;
      if (hit) hit.docroot = hit.docroot ?? docroot;
      else if (full) domains.push({ domain: full, type: 'sub', docroot });
    }
  } catch {
    /* docroot'suz devam edebiliriz; kullanım anında tekrar sorulur */
  }

  return dedupe(domains);
}

function collectFromDomainsData(data, out) {
  if (!data) return;

  const push = (entry, type) => {
    if (!entry) return;
    const domain = typeof entry === 'string' ? entry : entry.domain;
    if (!domain) return;
    out.push({
      domain,
      type,
      docroot: typeof entry === 'string' ? null : entry.documentroot ?? entry.docroot ?? null,
      phpVersion: typeof entry === 'string' ? null : entry.phpversion ?? null,
    });
  };

  push(data.main_domain, 'main');
  for (const e of data.addon_domains || []) push(e, 'addon');
  for (const e of data.sub_domains || []) push(e, 'sub');
  for (const e of data.parked_domains || []) push(e, 'parked');
}

function dedupe(list) {
  const seen = new Map();
  for (const item of list) {
    const key = String(item.domain).toLowerCase();
    const existing = seen.get(key);
    // Docroot'u dolu olan kaydı tercih et.
    if (!existing || (!existing.docroot && item.docroot)) seen.set(key, { ...item, domain: key });
  }
  return [...seen.values()].sort((a, b) => {
    const rank = { main: 0, addon: 1, sub: 2, parked: 3 };
    return (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || a.domain.localeCompare(b.domain);
  });
}

/* --------------------------------------------------------------- çözümleme */

/**
 * Bir domain adını hesabın gerçekliğiyle eşler.
 *
 * Dört sonuç: mevcut (main/addon/sub) · yeni subdomain açılabilir · park
 * edilmiş (yayın yapılamaz) · hesapta yok.
 */
export async function resolveDomain(client, input, cached = null) {
  const want = normalize(input);
  if (!want) throw new UserError(t('domain.empty'));

  const domains = cached ?? (await listDomains(client));
  const hit = domains.find((d) => d.domain === want);

  if (hit) {
    if (hit.type === 'parked') {
      return {
        kind: 'parked',
        domain: want,
        domains,
        reason: t('domain.parked'),
      };
    }
    return {
      kind: 'existing',
      type: hit.type,
      domain: want,
      docroot: hit.docroot,
      domains,
    };
  }

  // Üst bölge hesapta mı? `a.b.example.com` için `b.example.com` ve
  // `example.com` sırayla denenir; ilk bulunan kök alınır.
  const parts = want.split('.');
  for (let i = 1; i < parts.length - 1; i += 1) {
    const parent = parts.slice(i).join('.');
    const parentHit = domains.find((d) => d.domain === parent && d.type !== 'parked');
    if (parentHit) {
      return {
        kind: 'new-subdomain',
        domain: want,
        subLabel: parts.slice(0, i).join('.'),
        rootDomain: parent,
        docroot: want, // ev dizinine göreli; cPanel bunu böyle bekliyor
        domains,
      };
    }
  }

  return { kind: 'not-found', domain: want, domains };
}

/**
 * Subdomain oluşturur.
 *
 * `dir` ev dizinine görelidir. Docroot'u domain adıyla aynı tutuyoruz
 * (`/home/<user>/<tam.domain>`) — uygulama klasörü BURASI DEĞİL; Next kaynağı
 * belge kökünün içine konmaz, ayrı bir app-root klasöründe durur.
 */
export async function createSubdomain(client, { subLabel, rootDomain, dir }) {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(subLabel)) {
    throw new UserError(t('domain.invalidLabel', { label: subLabel }));
  }
  await client.uapiPost('SubDomain', 'addsubdomain', {
    domain: subLabel,
    rootdomain: rootDomain,
    dir,
  });
  return { domain: `${subLabel}.${rootDomain}`, docroot: dir };
}

/**
 * Subdomain siler.
 *
 * ⚠ API2 — UAPI'de `SubDomain::delsubdomain` YOK. cPanel 11.136'da UAPI
 * karşılığının hiçbir adı (`delsubdomain`, `del_subdomain`, `deletesubdomain`,
 * `Domains::delete_domain`) bulunmuyor; canlı sunucuda hepsi denendi, yalnızca
 * API2 biçimi çalışıyor.
 */
export async function deleteSubdomain(client, domain) {
  return client.api2('SubDomain', 'delsubdomain', { domain: normalize(domain) });
}

export function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

const KNOWN_TYPES = ['main', 'addon', 'sub', 'parked'];
export const TYPE_LABEL = new Proxy(
  {},
  {
    get: (_, key) =>
      KNOWN_TYPES.includes(String(key)) ? t(`domain.types.${String(key)}`) : undefined,
  }
);
