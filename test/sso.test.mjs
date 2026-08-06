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

test('form cPanel’in kendi giriş adresine gidiyor', () => {
  const r = page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.match(r.html, /action="https:\/\/srv\.example\.com:2083\/login\/"/);
  assert.match(r.html, /method="POST"/);
});

test('CSP form-action YALNIZCA o cPanel kökenine izin veriyor', () => {
  // Sayfanın tek işi bu; başka bir kökene gönderim yapamamalı.
  const r = page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.equal(r.formAction, 'https://srv.example.com:2083');
});

test('phpMyAdmin hedefi ve veritabanı goto_uri’ye taşınıyor', () => {
  const r = page(stateWith(), `profile=${HOST}&target=phpmyadmin&db=bimtest_shop`);
  assert.equal(attr(r.html, 'goto_uri'), '/3rdparty/phpMyAdmin/index.php?db=bimtest_shop');
});

test('Dosya Yöneticisi hedefi MUTLAK yol taşıyor', () => {
  const r = page(stateWith(), `profile=${HOST}&target=files&dir=bimnext`);
  assert.match(attr(r.html, 'goto_uri'), /filemanager\/index\.html\?dir=%2Fhome%2Fbimtest%2Fbimnext$/);
});

test('cPanel ana sayfası için goto_uri hiç yok', () => {
  const r = page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.equal(attr(r.html, 'goto_uri'), null);
});

test('API TOKEN sayfaya hiç girmiyor', () => {
  // Şifre girmek zorunda, ama token'ın burada hiçbir işi yok.
  const r = page(stateWith(), `profile=${HOST}&target=phpmyadmin`);
  assert.doesNotMatch(r.html, /SECRET-TOKEN/);
});

test('şifredeki HTML karakterleri kaçırılıyor', () => {
  // Kaçırılmasaydı `"` değeri erken kapatır ve form sessizce bozulurdu.
  const r = page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.equal(attr(r.html, 'pass'), 'p&lt;a&gt;s&quot;s&amp;1');
  assert.doesNotMatch(r.html, /value="p<a>/);
});

test('kullanıcı adı da forma giriyor', () => {
  assert.equal(attr(page(stateWith(), `profile=${HOST}&target=cpanel`).html, 'user'), 'bimtest');
});

test('şifre kasada yoksa cPanel giriş sayfasına yönlendiriliyor', () => {
  // Sessizce başarısız olmuyor: kullanıcı yine hedefe varıyor, sadece
  // şifresini cPanel'e kendisi giriyor.
  const r = page(stateWith({ password: null }), `profile=${HOST}&target=phpmyadmin`);
  assert.equal(r.formAction, null);
  assert.doesNotMatch(r.html, /<form/);
  assert.match(r.html, /login\/\?user=bimtest&amp;goto_uri=%2F3rdparty/);
});

test('kasa kilitliyse sayfa üretilmiyor', () => {
  const r = page({ locked: true, unlocked: new Map(), sessions: new Map() }, `profile=${HOST}`);
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.html, /<form/);
});

test('bilinmeyen hesap için sayfa üretilmiyor', () => {
  const r = page(stateWith(), 'profile=yok.example.com&target=cpanel');
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.html, /<form/);
});

test('JavaScript kapalıysa görünür bir düğme kalıyor', () => {
  const r = page(stateWith(), `profile=${HOST}&target=cpanel`);
  assert.match(r.html, /<noscript>[\s\S]*type="submit"/);
});

test('form gönderimden sonra DOM’dan siliniyor', () => {
  // Geri tuşuyla dönüldüğünde şifre kaynakta kalmasın.
  assert.match(page(stateWith(), `profile=${HOST}&target=cpanel`).html, /removeChild\(f\)/);
});

test('hesabın teması kullanılıyor', () => {
  const state = stateWith();
  state.sessions.set(HOST, { probeResult: { theme: 'paper_lantern' } });
  const r = page(state, `profile=${HOST}&target=files&dir=x`);
  assert.match(attr(r.html, 'goto_uri'), /^\/frontend\/paper_lantern\//);
});
