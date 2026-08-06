import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.mjs';
import { createState } from './state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Yerel yönetim arayüzü sunucusu.
 *
 * BU SUNUCU cPANEL TOKEN'I TUTUYOR. Yani tarayıcıdan gelen bir istek, gerçek
 * bir hesapta dosya silebilir. Güvenlik burada sonradan eklenen bir katman
 * değil, ilk yazılan şey:
 *
 *  1. Yalnızca 127.0.0.1'e bağlanır. Dışarıdan erişilemez.
 *  2. `Host` başlığı doğrulanır. DNS REBINDING gerçek bir saldırıdır: kötü
 *     niyetli bir site kendi alan adını 127.0.0.1'e çözdürüp tarayıcınıza
 *     bu sunucuya istek attırabilir. Host beklediğimiz değer değilse istek
 *     hiç işlenmez.
 *  3. Her API çağrısı `X-CN-Token` başlığı ister. Özel başlık gerektirmek,
 *     form/img/script gibi basit çapraz-köken isteklerini otomatik olarak
 *     eler (CSRF koruması).
 *  4. `Origin` varsa bizim kökenimiz olmalı.
 *  5. cPanel token'ı TARAYICIYA HİÇ GÖNDERİLMEZ. Sunucu bellekte tutar.
 *  6. Kasa açıldıktan sonra belirli bir süre işlem olmazsa kendini kilitler.
 *
 * CORS başlığı bilerek YOKTUR: tarayıcı çapraz-köken okumayı kendisi engeller.
 */

const IDLE_LOCK_MS = 15 * 60_000;

export async function startServer({ port = 0, lang = null, verbose = false } = {}) {
  const sessionToken = randomBytes(24).toString('hex');
  const state = createState({ lang, verbose, idleLockMs: IDLE_LOCK_MS });

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, { sessionToken, state });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: err?.message ?? 'internal error' }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Yalnızca loopback. '0.0.0.0' olsaydı aynı ağdaki herkes token'ınızla
    // hesabınızı yönetebilirdi.
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/?t=${sessionToken}`;

  /**
   * Tarayıcı kapanana kadar bekler.
   *
   * Sayfa hiç açılmadıysa beklemeye devam eder (kullanıcı adresi elle
   * açabilir); bir kez açıldıktan sonra kalp atışı kesilirse çıkar.
   */
  const waitUntilClosed = () =>
    new Promise((resolve) => {
      const tick = setInterval(() => {
        if (state.shouldExit()) {
          clearInterval(tick);
          resolve();
        }
      }, 2000);
      tick.unref?.();
    });

  return {
    server,
    port: actualPort,
    url,
    sessionToken,
    state,
    waitUntilClosed,
    close: () =>
      new Promise((resolve) => {
        state.dispose();
        server.close(resolve);
      }),
  };
}

async function route(req, res, { sessionToken, state }) {
  const host = String(req.headers.host ?? '');
  const port = String(req.socket.localPort);

  // (2) DNS rebinding savunması — Host beklediğimiz loopback adı olmalı.
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (!allowedHosts.has(host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: unexpected Host header');
    return;
  }

  const url = new URL(req.url, `http://${host}`);

  /* ---- statik: tek dosyalık arayüz ------------------------------------- */
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!safeEqual(url.searchParams.get('t') ?? '', sessionToken)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden: missing or invalid session token');
      return;
    }
    const html = fs
      .readFileSync(path.join(HERE, 'app.html'), 'utf8')
      .replace('__SESSION_TOKEN__', sessionToken)
      .replace('__LANG__', state.lang);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // Sayfanın kendisi dışında hiçbir yere bağlanmasın.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  /* ---- otomatik giriş --------------------------------------------------- */
  /*
   * cPanel'e OTURUM AÇARAK yönlendirme.
   *
   * Neden ayrı bir sayfa: cPanel'e giriş yapmanın tek yolu, tarayıcının kendi
   * giriş formuna POST etmesi ve `cpsession` çerezini ALMASI. Bizim sunucumuz
   * 127.0.0.1'de, cPanel başka bir köken — o çerezi kullanıcının tarayıcısına
   * bizim yazmamız mümkün değil. cPanel'in API'si de yardımcı olmuyor:
   * spesifikasyon `Session::create_temp_user` için birebir "geçerli bir cPanel
   * oturum kimliği gerektirir… aksi hâlde WHM API 1 `create_user_session`
   * kullanmalısınız" diyor. WHM ise bu aracın kapsamı dışında.
   *
   * Bu yüzden burada kendi kendine gönderilen bir form üretiliyor: şifre
   * kasadan çözülüp forma konuyor, tarayıcı cPanel'e POST ediyor, çerezi
   * alıyor ve `goto_uri` ile hedefe düşüyor.
   *
   * ⚠ CSP burada AYRI: sayfanın tek işi başka bir kökene form göndermek, o
   * yüzden `form-action` açıkça o kökene izin veriyor — ve başka hiçbir şeye.
   */
  if (url.pathname === '/sso') {
    if (!safeEqual(url.searchParams.get('t') ?? '', sessionToken)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden: missing or invalid session token');
      return;
    }

    const { ssoPage } = await import('./sso.mjs');
    const page = await ssoPage(state, url);
    res.writeHead(page.status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
        `form-action ${page.formAction ?? "'none'"}`,
      // Yerel jetonun cPanel'e sızmaması için: bu sayfanın adresi jetonu
      // taşıyor ve hedef başka bir köken.
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(page.html);
    return;
  }

  /* ---- API ------------------------------------------------------------- */
  if (url.pathname.startsWith('/api/')) {
    /*
     * (3) Özel başlık zorunlu — CSRF'i yapısal olarak keser: tarayıcı,
     * çapraz-köken bir form/img/script isteğine özel başlık ekleyemez.
     *
     * TEK İSTİSNA: SSE. `EventSource` API'si başlık göndermeye izin vermiyor,
     * bu yüzden olay akışı jetonu sorgudan alır. Bu kabul edilebilir çünkü
     * (a) yalnızca OKUMA yapan bir uç, (b) jeton zaten sayfanın kendi
     * adresinde, (c) `Referrer-Policy: no-referrer` ile dışarı sızmıyor,
     * (d) sunucu yalnızca 127.0.0.1'de.
     */
    const isEventStream = /^\/api\/jobs\/[^/]+\/events$/.test(url.pathname);
    const presented = isEventStream
      ? (url.searchParams.get('t') ?? '')
      : String(req.headers['x-cn-token'] ?? '');

    if (!safeEqual(presented, sessionToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // (4) Origin varsa bizim olmalı.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'bad origin' }));
      return;
    }

    state.touch();
    await handleApi(req, res, url, state);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

/** Jeton karşılaştırması sabit zamanlı olmalı. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
