import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deepLink,
  cpanelHome,
  phpMyAdmin,
  fileManager,
  apiTokens,
  absolutePath,
  DEFAULT_THEME,
} from '../lib/cpanel-links.mjs';

const ACC = { host: 'srv.example.com', port: 2083, user: 'bimtest' };

test('derin bağlantı cPanel giriş sayfasına gider', () => {
  const u = new URL(deepLink(ACC, '/x/y'));
  assert.equal(u.origin, 'https://srv.example.com:2083');
  assert.equal(u.pathname, '/login/');
  assert.equal(u.searchParams.get('goto_uri'), '/x/y');
  assert.equal(u.searchParams.get('user'), 'bimtest');
});

test('hedef yoksa yalnızca giriş sayfası', () => {
  const u = new URL(cpanelHome(ACC));
  assert.equal(u.searchParams.get('goto_uri'), null);
});

test('kullanıcı adı yoksa parametre de yok', () => {
  const u = new URL(deepLink({ host: 'h' }, '/x'));
  assert.equal(u.searchParams.get('user'), null);
  assert.equal(u.port, '2083');
});

test('phpMyAdmin: hesap ve tek veritabanı', () => {
  assert.equal(
    new URL(phpMyAdmin(ACC)).searchParams.get('goto_uri'),
    '/3rdparty/phpMyAdmin/index.php'
  );
  assert.equal(
    new URL(phpMyAdmin(ACC, { database: 'bimtest_shop' })).searchParams.get('goto_uri'),
    '/3rdparty/phpMyAdmin/index.php?db=bimtest_shop'
  );
});

test('Dosya Yöneticisi göreli yolu MUTLAK yola çevirir', () => {
  // cPanel göreli `dir` verildiğinde sessizce ev dizinini açıyor: hata yok,
  // sadece yanlış klasör. Bu yüzden çeviri burada zorunlu.
  const u = new URL(fileManager(ACC, { dir: 'bimnext' }));
  assert.equal(
    u.searchParams.get('goto_uri'),
    `/frontend/${DEFAULT_THEME}/filemanager/index.html?dir=%2Fhome%2Fbimtest%2Fbimnext`
  );
});

test('Dosya Yöneticisi mutlak yolu olduğu gibi kullanır', () => {
  const u = new URL(fileManager(ACC, { dir: '/home/bimtest/x/y' }));
  assert.match(u.searchParams.get('goto_uri'), /dir=%2Fhome%2Fbimtest%2Fx%2Fy$/);
});

test('tema sabit değil — hesabın teması kullanılır', () => {
  const u = new URL(fileManager(ACC, { dir: 'a', theme: 'paper_lantern' }));
  assert.match(u.searchParams.get('goto_uri'), /^\/frontend\/paper_lantern\//);
});

test('tema boş gelirse varsayılana düşer, bozuk yol üretmez', () => {
  for (const theme of [null, '', undefined]) {
    const u = new URL(fileManager(ACC, { dir: 'a', theme }));
    assert.match(u.searchParams.get('goto_uri'), new RegExp(`^/frontend/${DEFAULT_THEME}/`));
  }
});

test('token ekranı bağlantısı', () => {
  assert.match(new URL(apiTokens(ACC)).searchParams.get('goto_uri'), /security\/api_tokens/);
});

test('mutlak yol birleştirme sondaki eğik çizgiyi yutar', () => {
  assert.equal(absolutePath('u', 'app/'), '/home/u/app');
  assert.equal(absolutePath('u', '/abs/path/'), '/abs/path');
  assert.equal(absolutePath('u', '/app'), '/app');
});

test('hiçbir bağlantı kimlik bilgisi TAŞIMAZ', () => {
  // "token" kelimesini aramak yetmez: api_tokens ekranının YOLUNDA da geçiyor.
  // Asıl soru, bağlantının bir sır TAŞIYIP taşımadığı — yani sorgu dizesinde
  // `user` ve `goto_uri` dışında bir alan olup olmadığı.
  const urls = [
    cpanelHome(ACC),
    phpMyAdmin(ACC, { database: 'd' }),
    fileManager(ACC, { dir: 'x' }),
    apiTokens(ACC),
  ];
  for (const raw of urls) {
    const u = new URL(raw);
    assert.deepEqual([...u.searchParams.keys()].sort(), raw.includes('goto_uri') ? ['goto_uri', 'user'] : ['user']);
    assert.equal(u.username, '');
    assert.equal(u.password, '');
  }
});

test('terminal bağlantısı doğru sayfaya gidiyor', async () => {
  const { terminal } = await import('../lib/cpanel-links.mjs');
  const url = terminal({ host: 'sunucu.com', port: 2083, user: 'ali' });
  assert.match(url, /^https:\/\/sunucu\.com:2083\/login\/\?/);
  // goto_uri KODLANMIŞ olmalı: ham eğik çizgiler cPanel'de yönlendirmeyi bozuyor.
  assert.match(url, /goto_uri=%2Ffrontend%2Fjupiter%2Fterminal%2Findex\.html/);
  assert.match(url, /user=ali/);
});
