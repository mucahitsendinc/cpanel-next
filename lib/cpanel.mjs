import { request, buildMultipart, HttpError } from './http.mjs';
import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * cPanel istemcisi — iki kimlik kipi, tek arayüz.
 *
 *   token   : Authorization: cpanel <user>:<TOKEN>   → https://host:2083/execute/…
 *   session : Cookie: cpsession=…                    → https://host:2083/cpsessNNN/execute/…
 *
 * İkisinin aynı sınıfta olması bilinçli. Token'ın yetmediği yerde (API2,
 * CloudLinux uçları, `apitokens` özelliği kapalı hesaplar) yalnızca kimlik
 * kipi değişiyor; çağıran kod aynı kalıyor.
 */
export class CpanelClient {
  constructor({ host, port = 2083, user, token, session = null, insecure = false, verbose = false }) {
    if (!host) throw new UserError(t('cpanel.noHost'), t('cpanel.loginHint'));
    this.host = String(host).replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    this.port = Number(port) || 2083;
    this.user = user;
    this.token = token;
    this.session = session;
    this.insecure = insecure;
    this.verbose = verbose;
  }

  get origin() {
    return `https://${this.host}:${this.port}`;
  }

  /** Oturum kipinde URL'ler `/cpsessNNNNNNNNNN` önekiyle gider. */
  get prefix() {
    return this.session?.cpsess ? `/${this.session.cpsess}` : '';
  }

  get mode() {
    return this.session ? 'session' : 'token';
  }

  /** Aynı sunucu için oturum kipli bir kopya. Token'lı istemci bozulmaz. */
  withSession(session) {
    return new CpanelClient({
      host: this.host,
      port: this.port,
      user: this.user,
      token: this.token,
      session,
      insecure: this.insecure,
      verbose: this.verbose,
    });
  }

  authHeaders() {
    if (this.session) {
      return { Cookie: this.session.cookie };
    }
    if (!this.token) {
      throw new UserError(t('cpanel.noToken'), t('cpanel.noTokenHint'));
    }
    return { Authorization: `cpanel ${this.user}:${this.token}` };
  }

  /**
   * `--verbose` izleri.
   *
   * Bunlar KASTEN çevrilmiyor: hata ayıklama çıktısı, hata raporlarında ve
   * arama sonuçlarında tek bir dilde olmalı ki eşleşsin. Kullanıcıya dönük
   * her metin i18n'den geçer, bu izler geçmez.
   */
  log(...args) {
    if (this.verbose) console.error('  ›', ...args);
  }

  /* ------------------------------------------------------------------ UAPI */

  async uapi(module, func, params = {}, { method = 'GET', timeout = 60_000 } = {}) {
    const query = toSearchParams(params);
    const base = `${this.origin}${this.prefix}/execute/${module}/${func}`;
    const url = method === 'GET' ? `${base}?${query}` : base;

    this.log(`UAPI ${method} ${module}::${func}`);

    const res = await request(url, {
      method,
      headers: {
        ...this.authHeaders(),
        Accept: 'application/json',
        ...(method === 'POST'
          ? {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(query),
            }
          : {}),
      },
      body: method === 'POST' ? query : null,
      rejectUnauthorized: !this.insecure,
      timeout,
    });

    return unwrapUapi(res, `${module}::${func}`, this);
  }

  /** Büyük gövdeler (save_file_content gibi) GET'te URL sınırını aşar — POST şart. */
  uapiPost(module, func, params = {}, opts = {}) {
    return this.uapi(module, func, params, { ...opts, method: 'POST' });
  }

  /**
   * multipart yükleme. Yalnızca `Fileman::upload_files` için kullanılıyor.
   *
   * ⚠ Bu fonksiyon WHM proxy'sinden çağrılamaz (cPanel spesifikasyonu açıkça
   * yazıyor) — bizim yolumuz zaten doğrudan cPanel, sorun değil.
   */
  async uapiUpload(module, func, fields = {}, files = [], { onProgress, timeout = 900_000 } = {}) {
    const url = `${this.origin}${this.prefix}/execute/${module}/${func}`;
    const form = buildMultipart(fields, files);

    this.log(`UAPI UPLOAD ${module}::${func} (${form.length} bayt)`);

    const res = await request(url, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        Accept: 'application/json',
        'Content-Type': form.contentType,
        'Content-Length': form.length,
      },
      body: form.stream(),
      rejectUnauthorized: !this.insecure,
      timeout,
      onUploadProgress: onProgress,
    });

    return unwrapUapi(res, `${module}::${func}`, this);
  }

  /* ------------------------------------------------------------------ API2 */

  /**
   * cPanel API 2 — UAPI karşılığı OLMAYAN işlevler için (Cron, Fileman::fileop).
   *
   * ⚠ Token ile API2'nin çalışıp çalışmadığı cPanel dokümanlarında hiçbir yerde
   * belgeli değil; token'lar resmen yalnız UAPI için tanımlı. Uçta 401/403
   * alırsak bunu ayırt edilebilir bir hata olarak fırlatıyoruz ki çağıran
   * oturum kipine düşebilsin.
   */
  async api2(module, func, params = {}) {
    const query = toSearchParams({
      cpanel_jsonapi_user: this.user,
      cpanel_jsonapi_apiversion: '2',
      cpanel_jsonapi_module: module,
      cpanel_jsonapi_func: func,
      ...params,
    });
    const url = `${this.origin}${this.prefix}/json-api/cpanel?${query}`;

    this.log(`API2 ${module}::${func}`);

    const res = await request(url, {
      headers: { ...this.authHeaders(), Accept: 'application/json' },
      rejectUnauthorized: !this.insecure,
      timeout: 60_000,
    });

    if (res.status === 401 || res.status === 403) {
      const err = new UserError(
        t('cpanel.api2Rejected', { label: `${module}::${func}`, status: res.status }),
        t('cpanel.api2RejectedHint')
      );
      err.code = 'API2_AUTH';
      throw err;
    }

    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      const err = new UserError(
        t('cpanel.api2Unexpected', { label: `${module}::${func}`, status: res.status }),
        res.text.slice(0, 200)
      );
      err.code = 'API2_PARSE';
      throw err;
    }

    const result = data.cpanelresult ?? data;
    if (result.error) throw new UserError(`${module}::${func}: ${result.error}`);
    if (result.event && Number(result.event.result) !== 1) {
      throw new UserError(
        `${module}::${func}: ${result.event.reason || t('cpanel.requestFailed', { label: `${module}::${func}`, status: 0 })}`
      );
    }
    return result;
  }

  /* -------------------------------------------------------------- kısayollar */

  /** Hesabın bu özelliğe erişimi var mı. Sabit özellik adı varsaymak yerine sor. */
  async hasFeature(name) {
    try {
      const data = await this.uapi('Features', 'has_feature', { name });
      return Boolean(Number(data?.feature ?? data));
    } catch {
      return false;
    }
  }

  async whoami() {
    return this.uapi('Variables', 'get_user_information', {});
  }
}

function toSearchParams(params) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    // envvar_name / envvar_value gibi konumsal eşleşen tekrarlı parametreler:
    // dizi verildiğinde aynı adı birden çok kez yazmak ZORUNDAYIZ.
    if (Array.isArray(value)) {
      for (const item of value) sp.append(key, String(item));
    } else {
      sp.append(key, String(value));
    }
  }
  return sp.toString();
}

export { toSearchParams };

function unwrapUapi(res, label, client) {
  if (res.status === 401 || res.status === 403) {
    throw new UserError(
      t('cpanel.authRejected', { label, status: res.status }),
      client.mode === 'token' ? t('cpanel.authRejectedToken') : t('cpanel.authRejectedSession')
    );
  }

  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    // cPanel giriş sayfasına yönlendirdiyse HTML döner — bu, kimliğin
    // kabul edilmediğinin en yaygın işareti.
    if (/<html/i.test(res.text)) {
      throw new UserError(
        t('cpanel.htmlResponse', { label, status: res.status }),
        t('cpanel.htmlResponseHint')
      );
    }
    throw new HttpError(t('cpanel.parseFailed', { label, status: res.status }), {
      status: res.status,
      body: res.text.slice(0, 500),
    });
  }

  if (Array.isArray(data.errors) && data.errors.length) {
    const message = data.errors.join(', ');
    const err = new UserError(`${label}: ${message}`);
    // Host özelliği kapatmışsa bu mesaj birebir geliyor; çağıran ayırt edebilsin.
    if (/do not have the feature/i.test(message)) err.code = 'FEATURE_DISABLED';
    throw err;
  }

  if (data.status !== undefined && Number(data.status) !== 1) {
    throw new UserError(t('cpanel.requestFailed', { label, status: data.status }));
  }

  return data.data ?? data;
}
