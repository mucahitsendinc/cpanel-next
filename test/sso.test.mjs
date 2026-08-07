import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ssoPage } from '../lib/ui-server/sso.mjs';
import { setLocale } from '../lib/i18n/index.mjs';

setLocale('en');

/*
 * Bu sayfa kullanıcının cPanel ŞİFRESİNİ taşıyor. Buradaki her test, o
 * şifrenin gitmemesi gereken bir yere gitmediğini ya da bir kaçış hatası
 * yüzünden HTML'i kırmadığını doğruluyor.
 */

const HOST = 'srv.example.com';
const account = {
  name: HOST, host: HOST, port: 2083, user: 'bimtest',
  password: 'p<a>s"s&1', token: 'SECRET-TOKEN',
};

const stateWith = (overrides = {}) => ({
  locked: false,
  unlocked: new Map([[HOST, { ...account, ...overrides }]]),
  sessions: new Map(),
});

const page = (state, query) => ssoPage(state, new URL(`http://127.0.0.1/sso?${query}`));
const attr = (html, name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? null;

test('form cPanel’in kendi giriş adresine gidiyor', async () => {
  const r = await page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.match(r.html, /action="https:\/\/srv\.example\.com:2083\/login\/"/);
  assert.match(r.html, /method="POST"/);
});

test('CSP form-action YALNIZCA o cPanel kökenine izin veriyor', async () => {
  // Sayfanın tek işi bu; başka bir kökene gönderim yapamamalı.
  const r = await page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.equal(r.formAction, 'https://srv.example.com:2083');
});

test('phpMyAdmin hedefi ve veritabanı goto_uri’ye taşınıyor', async () => {
  const r = await page(stateWith(), `profile=${HOST}&target=phpmyadmin&db=bimtest_shop`);
  assert.equal(attr(r.html, 'goto_uri'), '/3rdparty/phpMyAdmin/index.php?db=bimtest_shop');
});

test('Dosya Yöneticisi hedefi MUTLAK yol taşıyor', async () => {
  const r = await page(stateWith(), `profile=${HOST}&target=files&dir=bimnext`);
  assert.match(attr(r.html, 'goto_uri'), /filemanager\/index\.html\?dir=%2Fhome%2Fbimtest%2Fbimnext$/);
});

test('cPanel ana sayfası için goto_uri hiç yok', async () => {
  const r = await page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.equal(attr(r.html, 'goto_uri'), null);
});

test('API TOKEN sayfaya hiç girmiyor', async () => {
  // Şifre girmek zorunda, ama token'ın burada hiçbir işi yok.
  const r = await page(stateWith(), `profile=${HOST}&target=phpmyadmin`);
  assert.doesNotMatch(r.html, /SECRET-TOKEN/);
});

test('şifredeki HTML karakterleri kaçırılıyor', async () => {
  // Kaçırılmasaydı `"` değeri erken kapatır ve form sessizce bozulurdu.
  const r = await page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.equal(attr(r.html, 'pass'), 'p&lt;a&gt;s&quot;s&amp;1');
  assert.doesNotMatch(r.html, /value="p<a>/);
});

test('kullanıcı adı da forma giriyor', async () => {
  const r = await page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.equal(attr(r.html, 'user'), 'bimtest');
});

test('şifre kasada yoksa cPanel giriş sayfasına yönlendiriliyor', async () => {
  // Sessizce başarısız olmuyor: kullanıcı yine hedefe varıyor, sadece
  // şifresini cPanel'e kendisi giriyor.
  const r = await page(stateWith({ password: null }), `profile=${HOST}&target=phpmyadmin`);
  assert.equal(r.formAction, null);
  assert.doesNotMatch(r.html, /<form/);
  assert.match(r.html, /login\/\?user=bimtest&amp;goto_uri=%2F3rdparty/);
});

test('kasa kilitliyse sayfa üretilmiyor', async () => {
  const r = await page({ locked: true, unlocked: new Map(), sessions: new Map() }, `profile=${HOST}`);
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.html, /<form/);
});

test('bilinmeyen hesap için sayfa üretilmiyor', async () => {
  const r = await page(stateWith(), 'profile=yok.example.com&target=cpanel');
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.html, /<form/);
});

test('JavaScript kapalıysa görünür bir düğme kalıyor', async () => {
  const r = await page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.match(r.html, /<noscript>[\s\S]*type="submit"/);
});

test('form gönderimden sonra DOM’dan siliniyor', async () => {
  // Geri tuşuyla dönüldüğünde şifre kaynakta kalmasın.
  const r = await page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.match(r.html, /removeChild\(f\)/);
});

test('hesabın teması kullanılıyor', async () => {
  const state = stateWith();
  state.sessions.set(HOST, { probeResult: { theme: 'paper_lantern' } });
  const r = await page(state, `profile=${HOST}&target=files&dir=x`);
  assert.match(attr(r.html, 'goto_uri'), /^\/frontend\/paper_lantern\//);
});

/* --------------------------------------------------------------- webmail */

test('webmail cPanel ŞİFRESİ OLMADAN da çalışıyor', async () => {
  /*
   * Bu, cPanel'e otomatik girişten farklı bir mekanizma:
   * `Session::create_webmail_session_for_mail_user` token ile çalışıyor ve
   * posta kutusunun kendi şifresini istemiyor. Bu yüzden kasada cPanel şifresi
   * saklı olmasa bile webmail açılabilmeli.
   */
  const state = stateWith({ password: null });
  state.session = async () => ({
    client: {
      host: HOST,
      uapi: async (mod, fn, params) => {
        assert.equal(`${mod}::${fn}`, 'Session::create_webmail_session_for_mail_user');
        assert.equal(params.login, 'info');
        assert.equal(params.domain, 'site.com');
        return { hostname: 'srv.example.com', token: '/cpsess123', session: 'user:ABC,def' };
      },
    },
  });

  const r = await page(state, `profile=${HOST}&target=webmail&email=info%40site.com`);
  assert.equal(r.formAction, 'https://srv.example.com:2096');
  assert.match(r.html, /action="https:\/\/srv\.example\.com:2096\/cpsess123\/login"/);
  assert.equal(attr(r.html, 'session'), 'user:ABC,def');
  // cPanel şifresi bu akışa hiç girmiyor.
  assert.equal(attr(r.html, 'pass'), null);
  assert.equal(attr(r.html, 'user'), null);
});

test('webmail oturumu üretilemezse sayfa üretilmiyor', async () => {
  const state = stateWith();
  state.session = async () => ({ client: { host: HOST, uapi: async () => ({}) } });
  const r = await page(state, `profile=${HOST}&target=webmail&email=info%40site.com`);
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.html, /<form/);
});

test('sso terminal hedefini tanıyor', async () => {
  /*
   * Terminal düğmesi /sso üzerinden otomatik girişle açılıyor. Hedef
   * tanınmazsa `gotoFor` null döner ve kullanıcı sessizce cPanel ANA
   * SAYFASINA düşer — düğme çalışıyor görünür ama yanlış yere gider.
   */
  const r = await page(stateWith(), `profile=${HOST}&target=terminal`);
  assert.match(attr(r.html, 'goto_uri') ?? '', /terminal\/index\.html/);
});

test('tanınmayan hedef cPanel ana sayfasına düşüyor', async () => {
  const r = await page(stateWith(), `profile=${HOST}&target=uydurma`);
  assert.equal(attr(r.html, 'goto_uri'), null);
});
