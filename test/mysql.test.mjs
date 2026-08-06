import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withPrefix,
  stripPrefix,
  validateName,
  buildDatabaseUrl,
  generatePassword,
  phpMyAdminUrl,
  getRestrictions,
  getServerInfo,
  listDatabases,
  listUsers,
} from '../lib/mysql.mjs';
import { setLocale } from '../lib/i18n/index.mjs';

setLocale('en');

/* ------------------------------------------------------------------ önek */

test('önek yoksa ad olduğu gibi kalır', () => {
  assert.equal(withPrefix('', 'shop'), 'shop');
  assert.equal(withPrefix(null, 'shop'), 'shop');
});

test('önek eklenir', () => {
  assert.equal(withPrefix('bimtest_', 'shop'), 'bimtest_shop');
});

test('önek İKİ KEZ eklenmez', () => {
  assert.equal(withPrefix('bimtest_', 'bimtest_shop'), 'bimtest_shop');
});

test('baştaki/sondaki boşluk kırpılır', () => {
  assert.equal(withPrefix('u_', '  shop '), 'u_shop');
});

test('stripPrefix yalnızca gerçek öneki söker', () => {
  assert.equal(stripPrefix('u_', 'u_shop'), 'shop');
  assert.equal(stripPrefix('u_', 'other_shop'), 'other_shop');
  assert.equal(stripPrefix('', 'u_shop'), 'u_shop');
});

/* ------------------------------------------------------------------- ad */

test('geçerli adlar kabul edilir', () => {
  for (const n of ['shop', 'shop_2', 'A9', 'u_shop_db']) assert.equal(validateName(n), true, n);
});

test('cPanel\'in kabul etmediği adlar reddedilir', () => {
  // Tire MySQL'de geçerli ama cPanel reddediyor; boşluk, nokta, tırnak ve
  // enjeksiyon denemeleri de burada durmalı.
  for (const n of ['shop-1', 'shop db', 'shop.db', "shop'; DROP", '', '../etc', 'şop']) {
    assert.equal(validateName(n), false, n);
  }
});

/* --------------------------------------------------------------- bağlantı */

test('DATABASE_URL beklenen biçimde', () => {
  assert.equal(
    buildDatabaseUrl({ user: 'u_app', password: 'abc123', host: 'localhost', port: 3306, database: 'u_db' }),
    'mysql://u_app:abc123@127.0.0.1:3306/u_db'
  );
});

test('localhost 127.0.0.1 yapılır — Node ipv6 ::1 çözüp bağlanamıyordu', () => {
  const url = buildDatabaseUrl({ user: 'u', password: 'p', host: 'localhost', database: 'd' });
  assert.match(url, /@127\.0\.0\.1:3306\//);
});

test('uzak MySQL sunucusu olduğu gibi kalır', () => {
  const url = buildDatabaseUrl({ user: 'u', password: 'p', host: 'db.example.com', port: 3307, database: 'd' });
  assert.match(url, /@db\.example\.com:3307\/d$/);
});

test('şifredeki özel karakterler URL\'i bozmaz', () => {
  const url = buildDatabaseUrl({ user: 'u', password: 'a@b/c:d?e#f', host: 'h', database: 'd' });
  // Kodlanmasaydı `@b/c` konak adı sanılır ve bağlantı BAŞKA bir sunucuya giderdi.
  assert.equal(url, 'mysql://u:a%40b%2Fc%3Ad%3Fe%23f@h:3306/d');
  assert.equal(new URL(url).hostname, 'h');
});

/* ---------------------------------------------------------------- şifre */

test('şifre uzunluğu ve alfabesi', () => {
  for (let i = 0; i < 200; i += 1) {
    const p = generatePassword();
    assert.equal(p.length, 24);
    assert.match(p, /^[A-Za-z0-9\-_.~]+$/);
    // Karıştırılan karakterler yok: elle yazılabilmeli.
    assert.doesNotMatch(p, /[0O1lI]/);
  }
});

test('şifre her sınıftan en az bir karakter içerir', () => {
  for (let i = 0; i < 200; i += 1) {
    const p = generatePassword();
    assert.match(p, /[A-Z]/);
    assert.match(p, /[a-z]/);
    assert.match(p, /[2-9]/);
    assert.match(p, /[-_.~]/);
  }
});

test('şifreler tekrar etmiyor', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(generatePassword());
  assert.equal(seen.size, 500);
});

test('istenen uzunluk onurlandırılır', () => {
  assert.equal(generatePassword(40).length, 40);
});

/* ----------------------------------------------------------- phpMyAdmin */

test('phpMyAdmin bağlantısı giriş sayfasına goto_uri ile gider', () => {
  const u = new URL(phpMyAdminUrl({ host: 'srv.example.com', port: 2083, user: 'bimtest' }));
  assert.equal(u.origin, 'https://srv.example.com:2083');
  assert.equal(u.pathname, '/login/');
  assert.equal(u.searchParams.get('user'), 'bimtest');
  assert.equal(u.searchParams.get('goto_uri'), '/3rdparty/phpMyAdmin/index.php');
});

test('veritabanı verilirse doğrudan o veritabanı açılır', () => {
  const u = new URL(phpMyAdminUrl({ host: 'h', database: 'u_shop' }));
  assert.equal(u.searchParams.get('goto_uri'), '/3rdparty/phpMyAdmin/index.php?db=u_shop');
});

test('bağlantıda şifre GEÇMEZ', () => {
  const url = phpMyAdminUrl({ host: 'h', user: 'u', database: 'd' });
  assert.doesNotMatch(url, /pass/i);
});

/* --------------------------------------------------- cPanel cevaplarının okunuşu */

/** Sahte istemci: yalnızca `uapi` ve `user` gerekiyor. */
const fake = (responses) => ({
  user: 'bimtest',
  host: 'srv',
  port: 2083,
  async uapi(module, func) {
    const v = responses[func];
    if (v === undefined) throw new Error(`${module}::${func} yok`);
    if (v instanceof Error) throw v;
    return v;
  },
});

test('prefix null ise ÖNEK YOKTUR — hesap adı uydurulmaz', () => {
  // cPanel spesifikasyonu: "If database prefixing is disabled, this is null."
  // Bunu "cevap gelmedi" sanıp `bimtest_` eklemek, kullanıcının cPanel'de
  // gördüğü adla bizim yazdığımız adın tutmaması demekti.
  return getRestrictions(fake({ get_restrictions: { prefix: null, max_database_name_length: 64 } }))
    .then((r) => {
      assert.equal(r.prefix, '');
      assert.equal(r.known, true);
      assert.equal(withPrefix(r.prefix, 'shop'), 'shop');
    });
});

test('prefix varsa aynen kullanılır', async () => {
  const r = await getRestrictions(fake({ get_restrictions: { prefix: 'bimtest_', max_username_length: 16 } }));
  assert.equal(r.prefix, 'bimtest_');
  assert.equal(r.maxUserLength, 16);
});

test('çağrı başarısızsa tarihsel varsayılana düşülür', async () => {
  const r = await getRestrictions(fake({}));
  assert.equal(r.prefix, 'bimtest_');
  assert.equal(r.known, false);
  assert.equal(r.maxDbLength, 64);
});

test('sunucu bilgisi: port alanı YOK, 3306 varsayılıyor', async () => {
  const r = await getServerInfo(fake({ get_server_information: { host: 'db.example.com', is_remote: 1, version: '8.0.36' } }));
  assert.deepEqual(r, { host: 'db.example.com', port: 3306, version: '8.0.36', isRemote: true });
});

test('sunucu bilgisi alınamazsa localhost', async () => {
  const r = await getServerInfo(fake({}));
  assert.equal(r.host, 'localhost');
  assert.equal(r.isRemote, false);
});

test('veritabanı listesi normalleştirilir', async () => {
  const rows = await listDatabases(fake({
    list_databases: [
      { database: 'bimtest_shop', disk_usage: 673, users: ['bimtest_shop'] },
      { database: 'bimtest_bos', disk_usage: 0, users: [] },
    ],
  }));
  assert.deepEqual(rows, [
    { name: 'bimtest_shop', size: 673, users: ['bimtest_shop'] },
    { name: 'bimtest_bos', size: 0, users: [] },
  ]);
});

test('kullanıcı listesi erişilen veritabanlarını taşır', async () => {
  const rows = await listUsers(fake({
    list_users: [{ user: 'bimtest_shop', shortuser: 'shop', databases: ['bimtest_shop'] }],
  }));
  assert.deepEqual(rows, [{ name: 'bimtest_shop', databases: ['bimtest_shop'] }]);
});

test('tek sonucu dizi yerine nesne döndüren sürümler de okunur', async () => {
  const rows = await listDatabases(fake({ list_databases: { 0: { database: 'a', disk_usage: 1, users: [] } } }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'a');
});
