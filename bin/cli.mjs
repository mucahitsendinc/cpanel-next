#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setLocale, t } from '../lib/i18n/index.mjs';
import { fail } from '../lib/ui.mjs';

const OPTIONS = {
  // kimlik / hedef
  host: { type: 'string' },
  user: { type: 'string' },
  token: { type: 'string' },
  port: { type: 'string' },
  profile: { type: 'string' },
  'password-stdin': { type: 'boolean', default: false },
  insecure: { type: 'boolean', default: false },

  // deploy
  domain: { type: 'string' },
  'app-root': { type: 'string' },
  'app-name': { type: 'string' },
  'node-version': { type: 'string' },
  'no-build': { type: 'boolean', default: false },
  'clean-modules': { type: 'boolean', default: false },
  transport: { type: 'string' },

  // davranış
  lang: { type: 'string' },
  'no-open': { type: 'boolean', default: false },
  web: { type: 'boolean', default: false },
  terminal: { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  confirm: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  adopt: { type: 'boolean', default: false },
  verbose: { type: 'boolean', short: 'v', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
};

const COMMANDS = {
  deploy: () => import('../lib/commands/deploy.mjs'),
  login: () => import('../lib/commands/login.mjs'),
  logout: () => import('../lib/commands/logout.mjs'),
  status: () => import('../lib/commands/status.mjs'),
  apps: () => import('../lib/commands/apps.mjs'),
  rollback: () => import('../lib/commands/rollback.mjs'),
  logs: () => import('../lib/commands/logs.mjs'),
  doctor: () => import('../lib/commands/doctor.mjs'),
  ui: () => import('../lib/commands/ui.mjs'),
  config: () => import('../lib/commands/config.mjs'),
  maintenance: () => import('../lib/commands/maintenance.mjs'),
};

async function main() {
  // Dil, herhangi bir metin üretilmeden ÖNCE ayarlanmalı; bu yüzden
  // `--lang` argümanını parseArgs'tan bağımsız olarak da tarıyoruz
  // (parseArgs hata verirse bile hata mesajı doğru dilde çıksın).
  const rawLang = extractLang(process.argv.slice(2));
  if (rawLang) setLocale(rawLang);

  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    console.error(`${err.message}\n\n${t('cli.optionsHint')}`);
    process.exit(2);
  }

  const { values: flags, positionals } = parsed;
  if (flags.lang) setLocale(flags.lang);

  if (flags.version) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    );
    console.log(pkg.version);
    return;
  }

  const first = positionals[0];
  const explicit = Boolean(first && COMMANDS[first]);
  if (explicit) positionals.shift();

  if (flags.help) {
    console.log(t('cli.help'));
    return;
  }

  if (first && !explicit) {
    console.error(`${t('cli.unknownCommand', { name: first })}\n\n${t('cli.tryHelp')}`);
    process.exit(2);
  }

  // Kayıtlı dil tercihi (bayrak ve ortam değişkeni ondan önce gelir).
  if (!flags.lang && !process.env.CPANEL_NEXT_LANG) {
    const { getPreferences } = await import('../lib/config.mjs');
    const saved = getPreferences().lang;
    if (saved) setLocale(saved);
  }

  /*
   * Komut verilmediyse varsayılan arayüz tercihine bakılır.
   *
   * `deploymanager` yazmak, kullanıcının tercihine göre ya terminal akışını
   * ya da web arayüzünü açar. Komut açıkça verildiyse (ör. `deploy`) tercih
   * devreye girmez — açık komut her zaman kazanır.
   */
  let commandName = explicit ? first : 'deploy';
  if (!explicit) {
    if (flags.web) commandName = 'ui';
    else if (flags.terminal) commandName = 'deploy';
    else {
      const { ensureUiPreference } = await import('../lib/commands/config.mjs');
      commandName = (await ensureUiPreference()) === 'web' ? 'ui' : 'deploy';
    }
  }

  const mod = await COMMANDS[commandName]();
  await mod.run({ flags, positionals, cwd: process.cwd() });
}

/** `--lang tr` ve `--lang=tr` biçimlerinin ikisini de yakalar. */
function extractLang(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--lang' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--lang=')) return argv[i].slice(7);
  }
  return null;
}

main().catch((err) => {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  fail(err, { verbose });
});
