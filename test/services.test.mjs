import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import * as email from '../lib/email.mjs';
import * as ftp from '../lib/ftp.mjs';
import { changePassword } from '../lib/account.mjs';
import { downloadDir, stampName, MAX_BYTES, isInsideDownloads } from '../lib/download.mjs';
import { mergePath, FALLBACKS } from '../lib/userpath.mjs';
import { setLocale } from '../lib/i18n/index.mjs';

setLocale('en');

/** Sahte istemci: çağrıları kaydeder, hazır cevapları döner. */
function fake(responses = {}) {
  const calls = [];
  const handle = async (module, func, params) => {
    calls.push({ call: `${module}::${func}`, params });
    const v = responses[func];
    if (v instanceof Error) throw v;
    if (v === undefined) return {};
    return v;
  };
  return {
    calls,
    user: 'bimtest',
    host: 'srv.example.com',
    uapi: handle,
    uapiPost: handle,
  };
}

/* ------------------------------------------------------------------ e-posta */

test('e-posta listesi normalleştiriliyor', async () => {
  const c = fake({
    list_pops_with_disk: [
      { email: 'info@site.com', _diskused: 1024, _diskquota: '250', suspended_login: 0 },
      { email: 'satis@site.com', _diskused: 0, _diskquota: 'unlimited' },
    ],
  });
  const rows = await email.listAccounts(c);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].domain, 'site.com');
  assert.equal(rows[0].quota, 250);
  // "unlimited" bir sayı değil; arayüz bunu ayrı göstermeli.
  assert.equal(rows[1].quota, null);
});

test('ana hesap gibi @ içermeyen satırlar eleniyor', async () => {
  const c = fake({ list_pops_with_disk: [{ email: 'bimtest', _diskused: 5 }] });
  assert.deepEqual(await email.listAccounts(c), []);
});

test('e-posta açarken şifre verilmezse üretiliyor ve bir kez dönüyor', async () => {
  const c = fake();
  const r = await email.createAccount(c, { user: 'info', domain: 'site.com' });
  assert.equal(r.email, 'info@site.com');
  assert.ok(r.password && r.password.length >= 24);
  const call = c.calls.find((x) => x.call === 'Email::add_pop');
  assert.equal(call.params.email, 'info');
  assert.equal(call.params.domain, 'site.com');
});

test('kullanıcının verdiği şifre geri DÖNDÜRÜLMÜYOR', async () => {
  // Kendi yazdığı şifreyi ekranda tekrar göstermenin bir faydası yok, riski var.
  const r = await email.createAccount(fake(), { user: 'a', domain: 'b.com', password: 'gizli' });
  assert.equal(r.password, null);
});

test('geçersiz yerel kısım reddediliyor', async () => {
  for (const bad of ['', 'a b', 'ç', 'a@b', '-x']) {
    await assert.rejects(() => email.createAccount(fake(), { user: bad, domain: 's.com' }));
  }
});

test('adres yerel kısım ve domain olarak ayrılıyor', () => {
  assert.deepEqual(email.splitEmail('info@site.com'), ['info', 'site.com']);
  // Yerel kısımda @ olan adresler nadirdir ama vardır: son @ ayırıcıdır.
  assert.deepEqual(email.splitEmail('a@b@site.com'), ['a@b', 'site.com']);
  assert.throws(() => email.splitEmail('info'));
  assert.throws(() => email.splitEmail('info@'));
});

test('kota okuması sınırsızı null yapıyor', () => {
  assert.equal(email.quotaOf('unlimited'), null);
  assert.equal(email.quotaOf('0'), null);
  assert.equal(email.quotaOf(null), null);
  assert.equal(email.quotaOf('500 MB'), 500);
});

/* ---------------------------------------------------------------------- FTP */

test('FTP hesabı açarken NOKTA korunuyor', async () => {
  // cPanel varsayılanı `disallowdot=1` ve `deploy.bot` sessizce `deploybot`
  // oluyor; kullanıcı sonra bağlanamıyor ve sebebini göremiyor.
  const c = fake();
  await ftp.createAccount(c, { user: 'deploy.bot', dir: 'uploads' });
  assert.equal(c.calls[0].params.disallowdot, '0');
});

test('FTP ev dizini GÖRELİ gidiyor', async () => {
  const c = fake();
  await ftp.createAccount(c, { user: 'x', dir: '/home/bimtest/uploads' });
  // Mutlak yol bazı sürümlerde /home/user/home/user/... üretiyor.
  assert.doesNotMatch(c.calls[0].params.homedir, /^\/home/);
});

test('FTP silme ev dizinini SİLMİYOR', async () => {
  const c = fake();
  await ftp.deleteAccount(c, 'x');
  // `destroy` gönderilseydi hesabın ev dizini de silinirdi ve varsayılan ev
  // dizini uygulamanın kendisi olabiliyor.
  assert.equal('destroy' in c.calls[0].params, false);
});

test('FTP giriş adı kullanıcı@sunucu biçiminde', () => {
  assert.equal(ftp.loginName('deploy', 'site.com'), 'deploy@site.com');
  assert.equal(ftp.loginName('deploy@site.com', 'x.com'), 'deploy@site.com');
});

test('FTP sunucu bilgisi alınamazsa çökmüyor', async () => {
  const c = fake({ get_ftp_daemon_info: new Error('feature disabled') });
  const info = await ftp.serverInfo(c, { host: 'srv.example.com' });
  assert.equal(info.enabled, false);
  assert.equal(info.host, 'srv.example.com');
  assert.equal(info.port, 21);
});

/* ------------------------------------------------------------------- şifre */

test('cPanel şifresi değiştirmek ESKİ şifreyi gerektiriyor', async () => {
  await assert.rejects(() => changePassword(fake(), { newPassword: 'x' }));
  await assert.rejects(() => changePassword(fake(), { oldPassword: 'x' }));
});

test('aynı şifre reddediliyor', async () => {
  await assert.rejects(() => changePassword(fake(), { oldPassword: 'a', newPassword: 'a' }));
});

test('enablemysql GÖNDERİLMİYOR', async () => {
  // Gönderilseydi MySQL kullanıcılarının şifresi de değişir ve yayındaki her
  // uygulamanın DB_PASSWORD'ü bir anda geçersiz olurdu.
  const c = fake();
  await changePassword(c, { oldPassword: 'a', newPassword: 'b' });
  assert.equal('enablemysql' in c.calls[0].params, false);
  assert.equal(c.calls[0].params.enabledigest, 0);
});

/* ---------------------------------------------------------------- indirme */

test('indirme klasörü oluşturuluyor ve ev dizininin altında', () => {
  const dir = downloadDir();
  assert.ok(dir.startsWith(os.homedir()));
  assert.equal(path.basename(dir), 'cpanel-next');
});

test('dosya adı damgalanıyor — aynı yedek birbirini ezmiyor', () => {
  const a = stampName('shop', '.sql.gz');
  assert.match(a, /^shop-\d{14}\.sql\.gz$/);
});

test('boyut sınırı makul', () => {
  assert.equal(MAX_BYTES, 200 * 1024 * 1024);
});

test('"klasörde göster" yalnızca indirme klasörünü açabiliyor', () => {
  const base = downloadDir();
  assert.equal(isInsideDownloads(path.join(base, 'shop.sql.gz')), true);
  assert.equal(isInsideDownloads(base), true);
  // Yerel makinede süreç başlatan bir uç; serbest yol kabul etseydi bu bir
  // "her şeyi aç" aracı olurdu.
  assert.equal(isInsideDownloads('/etc/passwd'), false);
  assert.equal(isInsideDownloads(path.join(os.homedir(), '.ssh')), false);
});

test('yol kaçışı normalleştirme ile engelleniyor', () => {
  const escape = path.join(downloadDir(), '..', '..', '.ssh', 'id_rsa');
  assert.equal(isInsideDownloads(escape), false);
});

test('benzer isimli komşu klasör içeri sayılmıyor', () => {
  // `…/cpanel-next-gizli` yolu `…/cpanel-next` ile başlıyor ama ALTINDA değil.
  assert.equal(isInsideDownloads(downloadDir() + '-gizli/x'), false);
});

/* --------------------------------------------------------------- PATH */

test('PATH birleştirmede sıra korunuyor, yinelenen atılıyor', () => {
  const always = () => true;
  assert.equal(mergePath('/a:/b', '/b:/c', always), '/a:/b:/c');
});

test('var olmayan dizinler PATH’e girmiyor', () => {
  // Var olmayan bir dizin PATH'i uzatıp her komut aramasını yavaşlatır.
  const onlyA = (d) => d === '/a';
  assert.equal(mergePath('/a:/yok', onlyA), '/a');
});

test('sondaki eğik çizgi yinelenme sayılıyor', () => {
  const always = () => true;
  assert.equal(mergePath('/a/:/a', always), '/a');
});

test('boş ve tanımsız girdiler çökmüyor', () => {
  const always = () => true;
  assert.equal(mergePath(null, undefined, '', always), '');
});

test('mevcut PATH önce geliyor — terminalden açan kendi ortamını görür', () => {
  const always = () => true;
  assert.match(mergePath('/kendi', '/kabuk', always), /^\/kendi:/);
});

test('yedek liste npm’in bulunabileceği yerleri içeriyor', () => {
  // `spawn npm ENOENT` hatası tam olarak bu dizin PATH'te olmadığı için oldu.
  assert.ok(FALLBACKS.includes('/usr/local/bin'));
  assert.ok(FALLBACKS.includes('/opt/homebrew/bin'));
});
