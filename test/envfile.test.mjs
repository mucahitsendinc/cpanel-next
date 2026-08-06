import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, upsertEnv, removeEnv, maskValue } from '../lib/envfile.mjs';

/*
 * Bu dosya kullanıcının SUNUCUDAKİ `.env` dosyasını yeniden yazıyor. Yanlış
 * bir kaçış ya da kaybolan bir satır, yayındaki uygulamanın veritabanına
 * bağlanamaması demek. Testler bu yüzden "koruyor mu" sorusuna odaklı.
 */

test('temel ayrıştırma', () => {
  const env = parseEnv('A=1\nB=hello world\n');
  assert.deepEqual(env, { A: '1', B: 'hello world' });
});

test('yorumlar ve boş satırlar atlanır', () => {
  assert.deepEqual(parseEnv('# not\n\nA=1\n  # girintili not\n'), { A: '1' });
});

test('export öneki tanınır', () => {
  assert.deepEqual(parseEnv('export A=1\n'), { A: '1' });
});

test('tırnaklar sökülür', () => {
  assert.deepEqual(parseEnv('A="x y"\nB=\'z\'\n'), { A: 'x y', B: 'z' });
});

test('tırnaksız değerdeki satır sonu yorumu değere girmez', () => {
  assert.deepEqual(parseEnv('A=1 # yorum\n'), { A: '1' });
});

test('tırnak İÇİNDEKİ # yorum değildir', () => {
  assert.deepEqual(parseEnv('A="a#b"\n'), { A: 'a#b' });
});

/* --------------------------------------------------------------- upsert */

test('var olan anahtar yerinde güncellenir, sıra korunur', () => {
  const { content, updated, added } = upsertEnv('A=1\nB=2\nC=3\n', { B: '9' });
  assert.equal(content, 'A=1\nB=9\nC=3\n');
  assert.deepEqual(updated, ['B']);
  assert.deepEqual(added, []);
});

test('yeni anahtar sona eklenir', () => {
  const { content, added } = upsertEnv('A=1\n', { B: '2' });
  assert.equal(content, 'A=1\n\nB=2\n');
  assert.deepEqual(added, ['B']);
});

test('yorumlar ve biçim KORUNUR', () => {
  const before = '# uygulama ayarları\nA=1\n\n# veritabanı\nDATABASE_URL=old\n';
  const { content } = upsertEnv(before, { DATABASE_URL: 'new' });
  assert.equal(content, '# uygulama ayarları\nA=1\n\n# veritabanı\nDATABASE_URL=new\n');
});

test('aynı değer yazılırsa dosya değişmez', () => {
  const { content, updated, unchanged } = upsertEnv('A=1\n', { A: '1' });
  assert.equal(content, 'A=1\n');
  assert.deepEqual(updated, []);
  assert.deepEqual(unchanged, ['A']);
});

test('boş dosyaya yazılabilir', () => {
  assert.equal(upsertEnv('', { A: '1' }).content, 'A=1\n');
  assert.equal(upsertEnv(null, { A: '1' }).content, 'A=1\n');
});

test('sondaki yeni satır eksikse satırlar birleşmez', () => {
  const { content } = upsertEnv('A=1', { B: '2' });
  assert.equal(content, 'A=1\n\nB=2\n');
});

test('export önekli satır güncellenirken öneki korur', () => {
  assert.equal(upsertEnv('export A=1\n', { A: '2' }).content, 'export A=2\n');
});

/* ---------------------------------------------------------------- kaçış */

test('boşluklu değer tırnaklanır', () => {
  assert.equal(upsertEnv('', { A: 'x y' }).content, 'A="x y"\n');
});

test('$ kaçırılır — dotenv-expand değeri boşa çevirmesin', () => {
  const { content } = upsertEnv('', { P: 'a$bc' });
  assert.equal(content, 'P="a\\$bc"\n');
  assert.equal(parseEnv(content).P, 'a$bc');
});

test('gidiş-dönüş: özel karakterli şifreler bozulmadan geri okunur', () => {
  const values = ['a b', 'a#b', 'a"b', "a'b", 'a$b', 'a\\b', 'mysql://u:p@h:3306/d', ''];
  for (const v of values) {
    const { content } = upsertEnv('', { X: v });
    assert.equal(parseEnv(content).X, v, JSON.stringify(v));
  }
});

test('boş değer tırnaklanır — çıplak `X=` bazı ayrıştırıcılarda satırı yutuyor', () => {
  assert.equal(upsertEnv('', { X: '' }).content, 'X=""\n');
});

/* ---------------------------------------------------------------- silme */

test('anahtar silinir, gerisi kalır', () => {
  const { content, changed } = removeEnv('A=1\nB=2\n', 'A');
  assert.equal(content, 'B=2\n');
  assert.equal(changed, true);
});

test('olmayan anahtarı silmek dosyayı değiştirmez', () => {
  const { content, changed } = removeEnv('A=1\n', 'Z');
  assert.equal(content, 'A=1\n');
  assert.equal(changed, false);
});

/* -------------------------------------------------------------- maskeleme */

test('sır içeren anahtarlar maskelenir', () => {
  const masked = maskValue('DATABASE_URL', 'mysql://u:secret@h/db');
  assert.doesNotMatch(masked, /secret/);
  assert.match(maskValue('DB_PASSWORD', 'hunter2'), /^h.*2$/);
  assert.equal(maskValue('MY_SECRET', 'abc'), '••••');
});

test('sır olmayan anahtarlar olduğu gibi görünür', () => {
  assert.equal(maskValue('NODE_ENV', 'production'), 'production');
  assert.equal(maskValue('NEXT_PUBLIC_URL', 'https://x.com'), 'https://x.com');
});
