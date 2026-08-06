import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setLocale } from '../lib/i18n/index.mjs';

setLocale('en');

/*
 * Ana şifreyi değiştirmek, saklanan HER sırrı yeni anahtarla yeniden
 * mühürlemek demek. Yarıda kalan bir değişiklik, yarısı eski yarısı yeni
 * anahtarla şifrelenmiş — yani bir daha hiç açılamayacak — bir kasa bırakır.
 * Buradaki testler o güvenceyi bağlıyor.
 */

/*
 * ⚠ `CPANEL_NEXT_HOME` modül yüklenirken BİR KEZ okunuyor (`paths.mjs`), yani
 * test başına ayrı bir ev dizini vermek mümkün değil — sorgu parametresiyle
 * modülü tazelemek de `paths.mjs`'i tazelemiyor. Bu yüzden tek bir ev dizini
 * kullanıp aralarda yapılandırma dosyasını siliyoruz.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
process.env.CPANEL_NEXT_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const config = await import('../lib/config.mjs');
const vault = await import('../lib/vault.mjs');

async function freshVault() {
  fs.rmSync(path.join(HOME, 'config.json'), { force: true });
  return { home: HOME, config, vault };
}

test('ana şifre değişiyor ve token yeni şifreyle açılıyor', async () => {
  const { config, vault } = await freshVault();
  const { meta, key } = vault.createVault('eski');
  config.saveProfile('srv.example.com', {
    host: 'srv.example.com', port: 2083, user: 'bimtest',
    tokenEnc: vault.sealToken(key, 'TOKEN-123'),
  }, { vaultMeta: meta });

  const r = config.changeMasterPassword('eski', 'yeni');
  assert.equal(r.resealed, 1);

  const after = config.loadGlobalConfig();
  const newKey = vault.unlockVault(after.vault, 'yeni');
  assert.equal(vault.openToken(newKey, after.profiles['srv.example.com'].tokenEnc), 'TOKEN-123');
});

test('eski şifre artık açmıyor', async () => {
  const { config, vault } = await freshVault();
  const { meta, key } = vault.createVault('eski');
  config.saveProfile('h', { host: 'h', user: 'u', tokenEnc: vault.sealToken(key, 'T') }, { vaultMeta: meta });

  config.changeMasterPassword('eski', 'yeni');
  const after = config.loadGlobalConfig();
  assert.throws(() => vault.unlockVault(after.vault, 'eski'));
});

test('yanlış eski şifre HİÇBİR ŞEYİ değiştirmiyor', async () => {
  const { config, vault } = await freshVault();
  const { meta, key } = vault.createVault('dogru');
  config.saveProfile('h', { host: 'h', user: 'u', tokenEnc: vault.sealToken(key, 'T') }, { vaultMeta: meta });
  const before = JSON.stringify(config.loadGlobalConfig());

  assert.throws(() => config.changeMasterPassword('yanlis', 'yeni'));
  // Dosya bir bayt bile değişmemeli: yarım bir yeniden mühürleme kasayı
  // sonsuza kadar açılamaz hâle getirirdi.
  assert.equal(JSON.stringify(config.loadGlobalConfig()), before);
});

test('cPanel şifresi de yeniden mühürleniyor', async () => {
  // Otomatik giriş açıksa kasada token'ın yanında cPanel şifresi de var;
  // biri yeniden mühürlenip diğeri unutulursa otomatik giriş sessizce bozulur.
  const { config, vault } = await freshVault();
  const { meta, key } = vault.createVault('eski');
  config.saveProfile('h', {
    host: 'h', user: 'u',
    tokenEnc: vault.sealToken(key, 'T'),
    passwordEnc: vault.sealToken(key, 'cpanel-sifresi'),
  }, { vaultMeta: meta });

  config.changeMasterPassword('eski', 'yeni');
  const after = config.loadGlobalConfig();
  const newKey = vault.unlockVault(after.vault, 'yeni');
  assert.equal(vault.openToken(newKey, after.profiles.h.passwordEnc), 'cpanel-sifresi');
  assert.equal(vault.openToken(newKey, after.profiles.h.tokenEnc), 'T');
});

test('birden çok hesabın hepsi taşınıyor', async () => {
  const { config, vault } = await freshVault();
  const { meta, key } = vault.createVault('eski');
  for (const n of ['a.com', 'b.com', 'c.com']) {
    config.saveProfile(n, { host: n, user: 'u', tokenEnc: vault.sealToken(key, `T-${n}`) },
      { vaultMeta: meta });
  }

  const r = config.changeMasterPassword('eski', 'yeni');
  assert.equal(r.resealed, 3);

  const after = config.loadGlobalConfig();
  const newKey = vault.unlockVault(after.vault, 'yeni');
  for (const n of ['a.com', 'b.com', 'c.com']) {
    assert.equal(vault.openToken(newKey, after.profiles[n].tokenEnc), `T-${n}`);
  }
});

test('kasa hiç yoksa açık bir hata veriyor', async () => {
  const { config } = await freshVault();
  assert.throws(() => config.changeMasterPassword('a', 'b'), /vault|kasa/i);
});

test('profil verileri (host, kullanıcı) korunuyor', async () => {
  const { config, vault } = await freshVault();
  const { meta, key } = vault.createVault('eski');
  config.saveProfile('h', {
    host: 'h', port: 2087, user: 'bimtest', tokenName: 'cpanel-next-mac',
    tokenEnc: vault.sealToken(key, 'T'),
  }, { vaultMeta: meta });

  config.changeMasterPassword('eski', 'yeni');
  const p = config.loadGlobalConfig().profiles.h;
  assert.equal(p.port, 2087);
  assert.equal(p.user, 'bimtest');
  assert.equal(p.tokenName, 'cpanel-next-mac');
});
