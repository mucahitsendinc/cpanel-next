import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildContext, runCleanup } from '../context.mjs';
import { t } from '../i18n/index.mjs';
import * as mysql from '../mysql.mjs';
import * as remote from '../remote.mjs';
import { upsertEnv } from '../envfile.mjs';
import { intro, outro, table, note, spinner, color, log, text, typeToConfirm, UserError, bytes } from '../ui.mjs';

/**
 * `deploymanager db` — cPanel MySQL yönetimi.
 *
 * Web arayüzündeki Veritabanı sekmesiyle AYNI çekirdeği kullanıyor
 * (`lib/mysql.mjs`); burada yalnızca sunum farklı. İki ön yüzden birinin
 * eksik kalması, aracın "terminalde de yapılabilir" iddiasını bozardı.
 */
export async function run({ flags, positionals, cwd }) {
  const sub = positionals[0] ?? 'list';
  const arg = positionals[1] ?? null;
  const ctx = await buildContext({ flags, cwd, needProbe: false });

  try {
    intro(t('db.title'));
    switch (sub) {
      case 'list':
        return await list(ctx);
      case 'create':
        return await create(ctx, arg, flags, cwd);
      case 'drop':
      case 'delete':
        return await drop(ctx, arg, flags);
      case 'users':
        return await users(ctx);
      case 'pma':
      case 'phpmyadmin':
        return await pma(ctx, arg, flags);
      default:
        throw new UserError(t('db.unknownSub', { name: sub }), t('db.subHint'));
    }
  } finally {
    await runCleanup(ctx);
  }
}

async function load(ctx) {
  const s = spinner();
  s.start(t('db.reading'));
  const data = await mysql.overview(ctx.client);
  s.stop(t('db.count', { count: data.databases.length }));
  return data;
}

async function list(ctx) {
  const d = await load(ctx);
  if (!d.databases.length) {
    note(t('db.empty'), t('db.title'));
  } else {
    console.log('');
    console.log(table(t('db.headers'), d.databases.map((db) => [
      db.name,
      db.size ? bytes(db.size) : '—',
      db.users.join(', ') || '—',
    ])));
    console.log('');
  }
  log.info(t('db.server', { host: d.server.host, port: d.server.port }));
  log.info(d.restrictions.prefix ? t('db.prefix', { prefix: d.restrictions.prefix }) : t('db.noPrefix'));
  log.info(color.dim(phpMyAdminLine(ctx)));
  outro('');
}

async function users(ctx) {
  const d = await load(ctx);
  /*
   * `list_users` erişilen veritabanlarını zaten veriyor. Yine de veritabanı
   * listesinden geriye doğru birleştiriyoruz: eski cPanel sürümlerinde o alan
   * boş dönebiliyor ve kullanıcı yetkisi olduğu hâlde yetkisiz görünüyordu.
   */
  const byUser = new Map(d.users.map((u) => [u.name, [...u.databases]]));
  for (const db of d.databases) {
    for (const u of db.users) {
      if (!byUser.has(u)) byUser.set(u, []);
      const list = byUser.get(u);
      if (!list.includes(db.name)) list.push(db.name);
    }
  }
  console.log('');
  console.log(table(t('db.userHeaders'), [...byUser].map(([name, dbs]) => [name, dbs.join(', ') || '—'])));
  console.log('');
  outro('');
}

/**
 * Tek adımda kullanılabilir veritabanı.
 *
 * Şifre BİR KEZ gösteriliyor; ne cPanel'de ne bizde okunabilir bir yerde
 * duruyor. Bu yüzden `--app-root` ve `--env-local` bayrakları var: kullanıcı
 * kopyalamayı unutsa bile bağlantı dizesi gideceği yere yazılmış olsun.
 */
async function create(ctx, name, flags, cwd) {
  const given = name ?? (await text({ message: t('db.namePrompt') }));
  if (!given) throw new UserError(t('db.nameRequired'));

  const s = spinner();
  s.start(t('db.creating'));
  const r = await mysql.provision(ctx.client, { name: given.trim() });
  s.stop(t('db.created', { database: r.database }));

  if (r.dbExisted) log.warn(t('db.dbExisted', { database: r.database }));
  if (r.userExisted) log.warn(t('db.userExisted', { user: r.user }));

  const [dbLabel] = t('db.headers');
  const [userLabel] = t('db.userHeaders');
  const lines = [`${dbLabel}: ${r.database}`, `${userLabel}: ${r.user}`];
  if (r.password) lines.push(`${t('db.passwordLabel')}: ${r.password}`);
  note(lines.join('\n'), t('db.credentials'));

  if (r.url) {
    note(`DATABASE_URL=${r.url}`, t('db.connection'));
    log.warn(t('db.passwordOnce'));

    // Sunucudaki `.env` — pakete girmeyen, deploy'da korunan dosya.
    const appRoot = flags['app-root'] ? remote.rel(flags['app-root']) : null;
    if (appRoot) {
      const current = (await remote.readFile(ctx.client, appRoot, '.env').catch(() => null)) ?? '';
      const next = upsertEnv(current, { DATABASE_URL: r.url });
      await remote.saveFile(ctx.client, appRoot, '.env', next.content);
      log.success(t('db.envWritten', { file: `~/${appRoot}/.env`, keys: 'DATABASE_URL' }));
    }

    if (flags['env-local']) {
      const target = path.join(cwd, '.env.local');
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      fs.writeFileSync(target, upsertEnv(current, { DATABASE_URL: r.url }).content, { mode: 0o600 });
      log.success(t('db.envWritten', { file: target, keys: 'DATABASE_URL' }));
    }
  }

  log.info(color.dim(phpMyAdminLine(ctx, r.database)));
  outro('');
}

async function drop(ctx, name, flags) {
  if (!name) throw new UserError(t('db.nameRequired'));
  const d = await load(ctx);
  const full = mysql.withPrefix(d.restrictions.prefix, name);
  const target = d.databases.find((x) => x.name === full);
  if (!target) throw new UserError(t('db.invalidName', { name: full }));

  /*
   * Yazarak onay — `y/N` DEĞİL.
   *
   * Veritabanı silmenin yedeği yok. Aracın klasör silerken uyguladığı kural
   * burada daha da geçerli.
   */
  log.warn(t('db.deleteHint'));
  if (flags.confirm !== full) {
    await typeToConfirm(full, t('common.typeToConfirm'));
  }

  const s = spinner();
  s.start(t('db.dropping'));
  await mysql.deleteDatabase(ctx.client, full);
  s.stop(t('db.dropped', { database: full }));
  outro('');
}

async function pma(ctx, name, flags) {
  const url = phpMyAdminUrlFor(ctx, name ? mysql.withPrefix(`${ctx.client.user}_`, name) : null);
  note(url, 'phpMyAdmin');
  log.info(color.dim(t('db.pmaHint')));
  if (!flags['no-open']) openBrowser(url);
  outro('');
}

function phpMyAdminUrlFor(ctx, database = null) {
  return mysql.phpMyAdminUrl({
    host: ctx.client.host,
    port: ctx.client.port,
    user: ctx.client.user,
    database,
  });
}

const phpMyAdminLine = (ctx, database = null) => `phpMyAdmin: ${phpMyAdminUrlFor(ctx, database)}`;

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* açılamazsa adres zaten ekranda */
  }
}
