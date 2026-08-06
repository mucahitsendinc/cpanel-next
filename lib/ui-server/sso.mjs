import { fileManager, phpMyAdmin, DEFAULT_THEME } from '../cpanel-links.mjs';
import { t } from '../i18n/index.mjs';

/**
 * cPanel'e otomatik giriş sayfası.
 *
 * Ürettiği şey tek bir form: kullanıcının tarayıcısı bunu cPanel'in KENDİ
 * giriş adresine POST ediyor, `cpsession` çerezini alıyor ve `goto_uri` ile
 * hedefe (phpMyAdmin, Dosya Yöneticisi, cPanel ana sayfa) düşüyor.
 *
 * Neden sunucu tarafında değil de tarayıcıda: oturum çerezi KULLANICININ
 * tarayıcısında olmak zorunda. Bizim sunucumuz giriş yapsaydı çerez bizde
 * kalırdı ve kullanıcı yine giriş ekranını görürdü.
 *
 * ŞİFRE bu HTML'in içinde geçiyor — başka türlü olamaz, çünkü POST'u yapan
 * tarayıcı. Sayfa `no-store` ile veriliyor, yalnızca 127.0.0.1'den servis
 * ediliyor, oturum jetonu olmadan açılamıyor ve gönderimden sonra formu DOM'dan
 * siliyor.
 */
export async function ssoPage(state, url) {
  const name = url.searchParams.get('profile') ?? '';
  const target = url.searchParams.get('target') ?? 'cpanel';
  const dir = url.searchParams.get('dir');
  const database = url.searchParams.get('db');

  if (state.locked) return fail(t('sso.locked'));

  const profile = state.unlocked.get(name);
  if (!profile) return fail(t('sso.noProfile', { name }));

  /*
   * WEBMAIL ayrı bir yoldan gidiyor ve cPanel şifresine İHTİYAÇ DUYMUYOR.
   *
   * `Session::create_webmail_session_for_mail_user` token ile çalışıyor ve
   * posta kutusunun kendi şifresini bilmeden tek kullanımlık bir webmail
   * oturumu üretiyor — cPanel arayüzündeki "Check Email" düğmesinin yaptığı
   * şeyin aynısı. Bu yüzden otomatik giriş kapalı olsa bile çalışıyor.
   */
  if (target === 'webmail') {
    const address = url.searchParams.get('email') ?? '';
    try {
      const ctx = await state.session(name);
      const { webmailSession } = await import('../email.mjs');
      const r = await webmailSession(ctx.client, address);
      const origin = new URL(r.url).origin;
      return {
        status: 200,
        formAction: origin,
        html: formPage({
          action: r.url,
          fields: { session: r.session },
          note: t('sso.openingWebmail', { email: address }),
        }),
      };
    } catch (err) {
      return fail(err.message);
    }
  }

  const account = { host: profile.host, port: profile.port, user: profile.user };
  const theme = state.sessions.get(name)?.probeResult?.theme ?? DEFAULT_THEME;
  const goto = gotoFor(target, { account, theme, dir, database });

  /*
   * Şifre yoksa OTOMATİK giriş yapılamıyor — ama kullanıcı yine hedefe
   * gitmeli. cPanel'in giriş sayfasına `goto_uri` ile yönlendiriyoruz:
   * kullanıcı şifresini cPanel'e giriyor ve yine doğru yere düşüyor.
   */
  if (!profile.password) {
    const manual = new URL(`https://${profile.host}:${profile.port}/login/`);
    if (profile.user) manual.searchParams.set('user', profile.user);
    if (goto) manual.searchParams.set('goto_uri', goto);
    return {
      status: 200,
      formAction: null,
      html: redirectPage(manual.toString(), t('sso.noPassword')),
    };
  }

  const action = `https://${profile.host}:${profile.port}/login/`;
  return {
    status: 200,
    formAction: `https://${profile.host}:${profile.port}`,
    html: formPage({
      action,
      user: profile.user,
      pass: profile.password,
      goto,
      note: t('sso.signingIn', { host: profile.host }),
    }),
  };
}

function gotoFor(target, { account, theme, dir, database }) {
  if (target === 'phpmyadmin') {
    return new URL(phpMyAdmin(account, { database })).searchParams.get('goto_uri');
  }
  if (target === 'files') {
    return new URL(fileManager(account, { dir, theme })).searchParams.get('goto_uri');
  }
  return null; // cPanel ana sayfası
}

/* ------------------------------------------------------------------ HTML */

const SHELL = (body, head = '') => `<!doctype html>
<html><head><meta charset="utf-8"><title>cpanel-next</title>${head}
<style>
body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0f1115;color:#e6e8ee;
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme: light){body{background:#f6f7f9;color:#1b1f27}}
.box{text-align:center;max-width:380px;padding:26px}
.spin{width:26px;height:26px;margin:0 auto 16px;border-radius:50%;
  border:2px solid rgba(127,127,127,.3);border-top-color:#4ea1ff;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
a,button{color:#4ea1ff;font:inherit;background:none;border:1px solid rgba(127,127,127,.35);
  border-radius:8px;padding:9px 16px;cursor:pointer;text-decoration:none;display:inline-block;margin-top:14px}
p{margin:0;opacity:.75;font-size:13px}
</style></head><body><div class="box">${body}</div></body></html>`;

/**
 * Kendi kendine gönderilen form.
 *
 * `noscript` için görünür bir düğme var: JavaScript engelliyse sayfa sessizce
 * ölmemeli. Gönderimden sonra form DOM'dan siliniyor — geri tuşuyla sayfaya
 * dönüldüğünde şifre kaynakta durmasın diye.
 */
function formPage({ action, user, pass, goto, note, fields = null }) {
  const field = (n, v) => `<input type="hidden" name="${esc(n)}" value="${esc(v)}">`;
  // `fields` verildiğinde (webmail) kullanıcı/şifre alanları hiç üretilmiyor:
  // o akışta gönderilecek tek şey tek kullanımlık oturum dizesi.
  const inputs = fields
    ? Object.entries(fields).map(([k, v]) => field(k, v)).join('\n')
    : [field('user', user), field('pass', pass), goto ? field('goto_uri', goto) : ''].join('\n');
  return SHELL(
    `<div class="spin"></div>
<p>${esc(note)}</p>
<form id="f" method="POST" action="${esc(action)}">
${inputs}
<noscript><button type="submit">cPanel</button></noscript>
</form>
<script>
var f = document.getElementById('f');
f.submit();
// Geri tuşuyla bu sayfaya dönüldüğünde şifre kaynakta kalmasın.
setTimeout(function () { if (f && f.parentNode) f.parentNode.removeChild(f); }, 1500);
</script>`
  );
}

function redirectPage(href, note) {
  return SHELL(
    `<div class="spin"></div><p>${esc(note)}</p><a href="${esc(href)}">cPanel</a>
<script>location.replace(${JSON.stringify(href)});</script>`
  );
}

function fail(message) {
  return { status: 400, formAction: null, html: SHELL(`<p>${esc(message)}</p>`) };
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
