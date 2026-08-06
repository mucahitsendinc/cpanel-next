import { randomInt } from 'node:crypto';
import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';
import { phpMyAdmin } from './cpanel-links.mjs';

/**
 * cPanel MySQL yönetimi — saf UAPI (T1).
 *
 * Node uygulaması yayınlamak, veritabanı olmadan yarım bir iş. Kullanıcı
 * aracı bırakıp cPanel'e gidiyor, orada "Create Database", sonra "Create User",
 * sonra "Add User To Database", sonra yetki kutularını işaretliyor, sonra
 * bağlantı dizesini elle kuruyordu. Dört ekran, tek bir sonuç için.
 *
 * cPanel'in bu alanda TAM bir UAPI'si var (CloudLinux Selector'ün aksine),
 * yani burada köprüye, cron'a, tarayıcıya hiç gerek yok.
 *
 * ⚠ ÖNEK (prefix): Çoğu hostta veritabanı ve kullanıcı adları `<hesap>_`
 * önekiyle zorunlu tutulur ve API'ye TAM ad verilmesi gerekir. Önek host
 * ayarına göre kapalı da olabilir — bu yüzden varsaymak yerine
 * `Mysql::get_restrictions` ile soruyoruz.
 */

/* ------------------------------------------------------------------ okuma */

/**
 * Ad kısıtları: önek ve uzunluk sınırları.
 *
 * ⚠ `prefix: null` cPanel'in "ÖNEKLEME KAPALI" cevabıdır — çağrının
 * başarısız olması değil. Bunları karıştırmak, öneksiz bir hesapta adların
 * `bimtest_shop` diye oluşturulması demekti: kullanıcının cPanel'de gördüğü
 * adla bizim yazdığımız ad tutmaz. Bu yüzden "cevap geldi mi" ile "cevap
 * null mı" ayrı ayrı soruluyor.
 *
 * Yalnızca çağrı BAŞARISIZ olduğunda öneki hesap adından türetiyoruz —
 * cPanel'in tarihsel varsayılanı ve hostların ezici çoğunluğu böyle.
 */
export async function getRestrictions(client) {
  let raw = null;
  try {
    raw = await client.uapi('Mysql', 'get_restrictions', {});
  } catch {
    raw = null;
  }
  const known = Boolean(raw && typeof raw === 'object');
  const prefix = known ? (raw.prefix ?? '') : `${client.user}_`;
  return {
    prefix: String(prefix),
    maxDbLength: Number(pick(raw, ['max_database_name_length'], 64)) || 64,
    // cPanel'in örnek değeri 16 — MySQL 5.6'nın klasik kullanıcı adı sınırı.
    // Sunucu söylüyorsa ONA uyuyoruz; söylemiyorsa cömert davranıp cPanel'in
    // kendi hatasını göstermesine izin veriyoruz.
    maxUserLength: Number(pick(raw, ['max_username_length'], 47)) || 47,
    known,
  };
}

/**
 * Bağlantı için sunucu adresi. Uzak MySQL kullanan hostlarda localhost DEĞİL.
 *
 * ⚠ Bu uç PORT DÖNDÜRMÜYOR (cPanel spesifikasyonunda alan yok; yalnızca
 * `host`, `is_remote`, `version`). 3306 varsayıyoruz — cPanel'in kendi
 * `setup_db_and_user` çıktısı da bu değeri veriyor.
 */
export async function getServerInfo(client) {
  let raw = null;
  try {
    raw = await client.uapi('Mysql', 'get_server_information', {});
  } catch {
    raw = null;
  }
  return {
    host: String(pick(raw, ['host'], 'localhost') || 'localhost'),
    port: Number(pick(raw, ['port'], 3306)) || 3306,
    version: pick(raw, ['version'], null),
    isRemote: Boolean(Number(pick(raw, ['is_remote'], 0))),
  };
}

export async function listDatabases(client) {
  const rows = asArray(await client.uapi('Mysql', 'list_databases', {}));
  return rows.map((r) => ({
    name: String(pick(r, ['database', 'db', 'name'], '')),
    size: Number(pick(r, ['disk_usage', 'size'], 0)) || 0,
    users: asArray(r?.users).map((u) => (typeof u === 'string' ? u : String(pick(u, ['user'], '')))),
  })).filter((d) => d.name);
}

export async function listUsers(client) {
  const rows = asArray(await client.uapi('Mysql', 'list_users', {}));
  return rows
    .map((r) =>
      typeof r === 'string'
        ? { name: r, databases: [] }
        : {
            name: String(pick(r, ['user', 'name'], '')),
            // cPanel bu listeyi zaten veriyor; veritabanı tablosundan geriye
            // doğru türetmeye gerek yok.
            databases: asArray(r?.databases).map(String),
          }
    )
    .filter((u) => u.name);
}

/**
 * Veritabanları + kullanıcılar + kısıtlar + sunucu bilgisi, tek çağrıda.
 *
 * Arayüz bu dördünü her zaman birlikte istiyor; dört ayrı tur atmak yerine
 * paralel alıyoruz. Biri patlarsa diğerleri yine gelsin diye `allSettled`.
 */
export async function overview(client) {
  const [dbs, users, restrictions, server] = await Promise.allSettled([
    listDatabases(client),
    listUsers(client),
    getRestrictions(client),
    getServerInfo(client),
  ]);
  if (dbs.status === 'rejected') throw dbs.reason;
  return {
    databases: dbs.value,
    users: users.status === 'fulfilled' ? users.value : [],
    restrictions:
      restrictions.status === 'fulfilled'
        ? restrictions.value
        : { prefix: `${client.user}_`, maxDbLength: 64, maxUserLength: 47, known: false },
    server: server.status === 'fulfilled' ? server.value : { host: 'localhost', port: 3306, isRemote: false },
  };
}

/* ------------------------------------------------------------------ yazma */

export async function createDatabase(client, name) {
  await client.uapiPost('Mysql', 'create_database', { name });
  return name;
}

export async function createUser(client, name, password) {
  await client.uapiPost('Mysql', 'create_user', { name, password });
  return name;
}

/**
 * Yetki ver.
 *
 * cPanel arayüzündeki "ALL PRIVILEGES" kutusunun karşılığı. Daha dar bir küme
 * sunmuyoruz: uygulamanın kendi veritabanında tam yetkisi olması normaldir ve
 * yarım yetkiyle patlayan bir migration, kullanıcıyı bu araçtan değil kendi
 * kodundan şüphelendirir.
 */
export async function grantAll(client, user, database) {
  await client.uapiPost('Mysql', 'set_privileges_on_database', {
    user,
    database,
    privileges: 'ALL PRIVILEGES',
  });
}

export async function revoke(client, user, database) {
  await client.uapiPost('Mysql', 'revoke_access_to_database', { user, database });
}

export async function setPassword(client, user, password) {
  await client.uapiPost('Mysql', 'set_password', { user, password });
}

export async function deleteDatabase(client, name) {
  await client.uapiPost('Mysql', 'delete_database', { name });
}

export async function deleteUser(client, name) {
  await client.uapiPost('Mysql', 'delete_user', { name });
}

/**
 * Tek adımda kullanılabilir bir veritabanı.
 *
 * Dört cPanel ekranının karşılığı: veritabanı + kullanıcı + tam yetki, ve
 * elde hazır bir `DATABASE_URL`.
 *
 * cPanel'in `Mysql::setup_db_and_user` diye hazır bir ucu VAR ama adları
 * rastgele üretiyor (`cpuser_wp_gwl7vpix28owo855…`). O ad kullanıcının
 * cPanel'de ya da phpMyAdmin'de tanıyabileceği bir şey değil; insan için
 * değil, üçüncü parti kurulumlar için tasarlanmış. Bu yüzden adı kullanıcı
 * seçiyor ve üç çağrıyı biz sırayla yapıyoruz.
 *
 * Yarım kalırsa TEMİZLİYORUZ: kullanıcı oluşup yetki verilemediyse geriye
 * sahipsiz bir MySQL kullanıcısı bırakmak, bir sonraki denemede "bu kullanıcı
 * zaten var" hatası demek. Veritabanı zaten varsa ona DOKUNULMAZ — içinde
 * veri olabilir.
 */
export async function provision(client, { name, user = null, password = null, server = null }) {
  const restrictions = await getRestrictions(client);
  const dbName = withPrefix(restrictions.prefix, name);
  const dbUser = withPrefix(restrictions.prefix, user || name);
  const pass = password || generatePassword();

  assertName(dbName, restrictions.maxDbLength, 'database');
  assertName(dbUser, restrictions.maxUserLength, 'user');

  const existing = await listDatabases(client).catch(() => []);
  const dbExisted = existing.some((d) => d.name === dbName);
  const existingUsers = await listUsers(client).catch(() => []);
  const userExisted = existingUsers.some((u) => u.name === dbUser);

  if (!dbExisted) await createDatabase(client, dbName);

  let userCreated = false;
  try {
    if (userExisted) {
      // Var olan kullanıcının şifresini yalnızca AÇIKÇA verildiyse değiştiriyoruz;
      // sessizce değiştirmek, aynı kullanıcıyı kullanan başka bir uygulamayı
      // yayından düşürür.
      if (password) await setPassword(client, dbUser, password);
    } else {
      await createUser(client, dbUser, pass);
      userCreated = true;
    }
    await grantAll(client, dbUser, dbName);
  } catch (err) {
    if (userCreated) await deleteUser(client, dbUser).catch(() => {});
    if (!dbExisted) await deleteDatabase(client, dbName).catch(() => {});
    throw err;
  }

  const info = server ?? (await getServerInfo(client));
  return {
    database: dbName,
    user: dbUser,
    // Var olan kullanıcının şifresi bizde YOK; uydurmuyoruz, null dönüyoruz.
    password: userCreated || password ? pass : null,
    dbExisted,
    userExisted,
    host: info.host,
    port: info.port,
    url: userCreated || password
      ? buildDatabaseUrl({ user: dbUser, password: pass, host: info.host, port: info.port, database: dbName })
      : null,
  };
}

/* ------------------------------------------------------------ saf yardımcılar */

/**
 * Öneki uygular — iki kez uygulamadan.
 *
 * Kullanıcı arayüze "shop" da yazabilir "bimtest_shop" da; ikisi de aynı şeyi
 * kastediyor. Önek zaten varsa tekrar eklemek `bimtest_bimtest_shop` üretirdi.
 */
export function withPrefix(prefix, name) {
  const clean = String(name ?? '').trim();
  if (!prefix) return clean;
  return clean.startsWith(prefix) ? clean : `${prefix}${clean}`;
}

/** Önekten arındırılmış görünen ad — arayüzde kısa hâli göstermek için. */
export function stripPrefix(prefix, name) {
  const s = String(name ?? '');
  return prefix && s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/**
 * MySQL ad denetimi.
 *
 * cPanel'in kendi kuralı: harf, rakam, alt çizgi. Tire MySQL'de geçerli ama
 * cPanel reddediyor ve hata mesajı anlaşılmaz oluyor — burada temizlemek
 * yerine REDDEDİYORUZ (bkz. guards.mjs'teki aynı gerekçe).
 */
export function validateName(name) {
  return /^[A-Za-z0-9_]+$/.test(String(name ?? ''));
}

function assertName(full, max, kind) {
  if (!validateName(full)) {
    throw new UserError(t('db.invalidName', { name: full }), t('db.invalidNameHint'));
  }
  if (full.length > max) {
    throw new UserError(t('db.nameTooLong', { name: full, max, kind }));
  }
}

/**
 * Bağlantı dizesi.
 *
 * Şifre yüzde-kodlanıyor: üretilen şifrede olmasa bile kullanıcının verdiği
 * şifrede `@` veya `/` bulunabilir ve kodlanmazsa URL sessizce başka bir
 * sunucuya işaret eder.
 */
export function buildDatabaseUrl({ user, password, host, port = 3306, database, protocol = 'mysql' }) {
  const h = host === 'localhost' || host === '127.0.0.1' ? '127.0.0.1' : host;
  return `${protocol}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${h}:${port}/${database}`;
}

/*
 * Sınıflar AYRI sabitler.
 *
 * Tek bir dizide indeks aralıklarıyla çalışmak (`ALPHABET[randomInt(48, …)]`)
 * bir karakter kaydı ve "her sınıftan en az bir tane" güvencesi sessizce
 * bozuldu: rakam sanılan yerden küçük harf geliyordu. Sınırları elle saymak
 * zorunda kalmayınca o hata yapılamıyor.
 */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I ve O yok
const LOWER = 'abcdefghijkmnopqrstuvwxyz'; // l yok
const DIGITS = '23456789'; // 0 ve 1 yok
const SYMBOLS = '-_.~';
const ALPHABET = UPPER + LOWER + DIGITS;

/**
 * Şifre üretici.
 *
 * Alfabede `0/O` ve `1/l/I` yok: bu şifre bir kere gösterilip kopyalanıyor ve
 * elle yazılma ihtimali var. Simgeler URL'de kodlama gerektirmeyenlerle
 * sınırlı, yoksa `DATABASE_URL` gözle okunamaz hâle geliyor.
 *
 * `randomInt` kullanılıyor — `Math.random()` bir sırdır üretmez.
 */
export function generatePassword(length = 24) {
  const pool = ALPHABET + SYMBOLS;
  let out = '';
  // Host'un şifre gücü kuralı her sınıftan en az bir karakter isteyebiliyor.
  for (const set of [UPPER, LOWER, DIGITS, SYMBOLS]) out += set[randomInt(0, set.length)];
  while (out.length < length) out += pool[randomInt(0, pool.length)];
  return shuffle(out);
}

function shuffle(s) {
  const a = [...s];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.join('');
}

/**
 * phpMyAdmin derin bağlantısı.
 *
 * Gerekçesi ve neden oturum üretilemediği: `lib/cpanel-links.mjs`. Burada
 * yalnızca eski çağrı imzası korunuyor.
 */
export function phpMyAdminUrl({ host, port = 2083, user = null, database = null }) {
  return phpMyAdmin({ host, port, user }, { database });
}

/* --------------------------------------------------------------- iç yardımcı */

function pick(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return fallback;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  // Bazı cPanel sürümleri tek sonucu dizi yerine nesne döndürüyor.
  if (typeof v === 'object') return Object.values(v).every((x) => typeof x === 'object') ? Object.values(v) : [v];
  return [v];
}
