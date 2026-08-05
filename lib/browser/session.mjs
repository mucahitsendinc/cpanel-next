import { request, mergeCookies } from '../http.mjs';
import { UserError } from '../ui.mjs';
import { t } from '../i18n/index.mjs';

/**
 * cPanel oturumu açar ve `cpsess` güvenlik jetonunu döndürür.
 *
 * İKİ YOL, bu sırayla:
 *
 *   1. HTTP  — cPanel'in `/login/?login_only=1` ucu JSON döndürür ve içinde
 *      `security_token` (yani `/cpsessNNNNNNNNNN`) gelir. Tarayıcı gerekmez.
 *      Kullanıcıların büyük çoğunluğu burada biter.
 *   2. Tarayıcı — WAF, özel giriş sayfası, CAPTCHA ya da tanımadığımız bir 2FA
 *      akışı HTTP yolunu tıkarsa headless Chromium devreye girer.
 *
 * Bu sıralama bilinçli: Chromium ~150 MB ve çoğu kullanıcının ona hiç
 * ihtiyacı olmayacak. İndirme, gerçekten gerektiği ana ertelenir.
 */

export async function login({ host, port = 2083, user, password, totp = null, insecure = false, verbose = false, allowBrowser = true, onBrowserNeeded = null }) {
  try {
    return await loginViaHttp({ host, port, user, password, totp, insecure, verbose });
  } catch (err) {
    if (err instanceof UserError && err.code === 'BAD_CREDENTIALS') throw err;
    if (!allowBrowser) throw err;
    if (verbose) console.error('  › http login failed, falling back to browser:', err.message);
    if (onBrowserNeeded) await onBrowserNeeded(err);
    return loginViaBrowser({ host, port, user, password, totp, insecure, verbose });
  }
}

/* ------------------------------------------------------------------- HTTP */

export async function loginViaHttp({ host, port, user, password, totp, insecure, verbose }) {
  const origin = `https://${host}:${port}`;
  const body = new URLSearchParams({
    user,
    pass: password,
    goto_uri: '/',
    login_theme: 'cpanel',
  });
  // 2FA alan adı sürümden sürüme değişebiliyor; ikisini birden gönderiyoruz,
  // fazlalık parametreyi cPanel yok sayıyor. Tanımadığımız bir akış çıkarsa
  // tarayıcı yolu zaten devralıyor.
  if (totp) {
    body.set('tfa_token', String(totp));
    body.set('tfatoken', String(totp));
  }

  const payload = body.toString();
  const res = await request(`${origin}/login/?login_only=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
      Accept: 'application/json',
    },
    body: payload,
    rejectUnauthorized: !insecure,
    timeout: 45_000,
  });

  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new UserError(t('auth.noJson', { status: res.status }), t('auth.noJsonHint'));
  }

  if (Number(data.status) !== 1) {
    const message = String(data.message || data.errors || t('auth.loginRejected'));
    if (/two.?factor|2fa|security code/i.test(message)) {
      const err = new UserError(t('auth.tfaRequired'), t('auth.tfaEnterCode'));
      err.code = 'TFA_REQUIRED';
      throw err;
    }
    const err = new UserError(t('auth.loginFailed', { message }));
    // Yanlış şifreyi tarayıcıyla tekrar denemek anlamsız — ve hesabı kilitler.
    if (/invalid|incorrect|failed/i.test(message)) err.code = 'BAD_CREDENTIALS';
    throw err;
  }

  const securityToken = String(data.security_token || '').replace(/^\//, '');
  if (!/^cpsess\d+$/.test(securityToken)) {
    throw new UserError(t('auth.noSecurityToken'));
  }

  const cookie = mergeCookies('', res.setCookie);
  if (verbose) console.error(`  › session opened: ${securityToken}`);

  return { cookie, cpsess: securityToken, origin, host, port, via: 'http' };
}

/* --------------------------------------------------------------- tarayıcı */

export async function loginViaBrowser({ host, port, user, password, totp, insecure, verbose }) {
  const { launchChromium } = await import('./ensure.mjs');
  const origin = `https://${host}:${port}`;

  const browser = await launchChromium({ insecure });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: insecure });
    const page = await context.newPage();
    await page.goto(`${origin}/login/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Jupiter ve Paper Lantern aynı alan adlarını kullanıyor; tema farkı
    // yalnızca görselde. Yine de ikisini de deneyecek biçimde geniş seçici.
    await page.fill('input[name="user"], #user', user);
    await page.fill('input[name="pass"], #pass', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
      page.click('button[type="submit"], input[type="submit"], #login_submit'),
    ]);

    if (totp) {
      const tfa = page.locator('input[name="tfa_token"], input[name="tfatoken"], #tfa_token');
      if (await tfa.count()) {
        await tfa.first().fill(String(totp));
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
          page.click('button[type="submit"], input[type="submit"]'),
        ]);
      }
    }

    const match = page.url().match(/\/(cpsess\d+)\//);
    if (!match) {
      const visible = await page.locator('body').innerText().catch(() => '');
      throw new UserError(t('auth.browserLoginFailed'), visible.slice(0, 200) || t('auth.browserLoginHint'));
    }

    const cookies = await context.cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (verbose) console.error(`  › session opened (browser): ${match[1]}`);

    return { cookie, cpsess: match[1], origin, host, port, via: 'browser', _context: context, _browser: browser };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/** Tarayıcı açıldıysa kapat. HTTP oturumunda hiçbir şey yapmaz. */
export async function closeSession(session) {
  if (session?._browser) {
    await session._browser.close().catch(() => {});
  }
}
