import https from 'node:https';
import http from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { t } from './i18n/index.mjs';

/**
 * Düşük seviye HTTP katmanı.
 *
 * `fetch` yerine `node:https` kullanıyoruz çünkü üç şeye ihtiyacımız var ve
 * global fetch üçünü de vermiyor: (1) sertifika doğrulamasını istek bazında
 * gevşetebilmek — paylaşımlı hostlarda sunucu adı ile sertifika sık sık
 * uyuşmuyor, (2) yükleme ilerlemesi, (3) gerçek zaman aşımı.
 */

export class HttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 60_000,
    rejectUnauthorized = true,
    onUploadProgress = null,
    maxRedirects = 0,
    signal = null,
  } = options;

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        rejectUnauthorized,
        servername: target.hostname,
      },
      (res) => {
        // Yönlendirme: cPanel girişi 302'lerle ilerliyor, gerektiğinde izliyoruz.
        if (maxRedirects > 0 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          const cookies = mergeCookies(headers.Cookie, res.headers['set-cookie']);
          resolve(
            request(next, {
              ...options,
              method: res.statusCode === 303 ? 'GET' : method,
              body: res.statusCode === 303 ? null : body,
              headers: { ...headers, ...(cookies ? { Cookie: cookies } : {}) },
              maxRedirects: maxRedirects - 1,
            })
          );
          return;
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            setCookie: res.headers['set-cookie'] || [],
            buffer: Buffer.concat(chunks),
            get text() {
              return Buffer.concat(chunks).toString('utf8');
            },
            url: target.toString(),
          });
        });
        res.on('error', reject);
      }
    );

    req.setTimeout(timeout, () => {
      req.destroy(
        new HttpError(t('cpanel.timeout', { seconds: Math.round(timeout / 1000), host: target.host }), { url })
      );
    });
    req.on('error', reject);

    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error(t('cpanel.aborted')));
      } else {
        signal.addEventListener('abort', () => req.destroy(new Error(t('cpanel.aborted'))), { once: true });
      }
    }

    if (!body) {
      req.end();
      return;
    }

    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      req.end(body);
      return;
    }

    // Akış: ilerleme bildirimi için baytları sayarak geçiriyoruz.
    let sent = 0;
    const total = Number(headers['Content-Length'] || 0);
    body.on('data', (chunk) => {
      sent += chunk.length;
      if (onUploadProgress) onUploadProgress({ sent, total });
    });
    body.on('error', reject);
    body.pipe(req);
  });
}

function mergeCookies(existing, setCookie) {
  const jar = new Map();
  for (const pair of String(existing || '').split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) jar.set(k, v.join('='));
  }
  for (const raw of setCookie || []) {
    const [pair] = String(raw).split(';');
    const [k, ...v] = pair.trim().split('=');
    if (k) jar.set(k, v.join('='));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export { mergeCookies };

/**
 * multipart/form-data gövdesi kurar.
 *
 * Kendi elimizle kuruyoruz çünkü dosyayı belleğe almadan akıtmak istiyoruz —
 * paylaşımlı hosting kullanıcısının makinesinde 200 MB'lık bir zip'i RAM'e
 * almak gereksiz, ve `--max-old-space-size` sınırına takılabilir.
 */
export function buildMultipart(fields = {}, files = []) {
  const boundary = `----cpanelnext${randomBytes(16).toString('hex')}`;
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push({
      kind: 'buffer',
      data: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8'
      ),
    });
  }

  for (const file of files) {
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`;
    parts.push({ kind: 'buffer', data: Buffer.from(header, 'utf8') });
    if (file.path) {
      parts.push({ kind: 'file', path: file.path, size: fs.statSync(file.path).size });
    } else {
      parts.push({ kind: 'buffer', data: file.buffer });
    }
    parts.push({ kind: 'buffer', data: Buffer.from('\r\n', 'utf8') });
  }

  parts.push({ kind: 'buffer', data: Buffer.from(`--${boundary}--\r\n`, 'utf8') });

  const length = parts.reduce(
    (sum, part) => sum + (part.kind === 'file' ? part.size : part.data.length),
    0
  );

  async function* generate() {
    for (const part of parts) {
      if (part.kind === 'buffer') {
        yield part.data;
      } else {
        for await (const chunk of fs.createReadStream(part.path, { highWaterMark: 256 * 1024 })) {
          yield chunk;
        }
      }
    }
  }

  return {
    boundary,
    length,
    stream: () => Readable.from(generate()),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
