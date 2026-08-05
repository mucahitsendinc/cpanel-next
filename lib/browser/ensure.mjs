import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { BROWSERS_DIR, ensureHomeDir } from '../paths.mjs';
import { UserError, confirm, spinner, log } from '../ui.mjs';
import { t } from '../i18n/index.mjs';

const require = createRequire(import.meta.url);

/**
 * Chromium'u tembel indirir.
 *
 * Paketin kendisi ~2 MB; tarayıcı ~150 MB. Kullanıcıların çoğu token yoluyla
 * (T1) veya HTTP oturumuyla iş görecek ve Chromium'a hiç dokunmayacak. Bu
 * yüzden indirme kuruluma değil, gerçekten gerektiği ana bağlı.
 *
 * Sistemdeki Chrome'a KASTEN bakmıyoruz: sürüm sabit olsun, kullanıcının
 * eklentileri/profili/politikaları işe karışmasın.
 */

function browsersPath() {
  ensureHomeDir();
  fs.mkdirSync(BROWSERS_DIR, { recursive: true });
  return BROWSERS_DIR;
}

async function playwright() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath();
  try {
    return await import('playwright-core');
  } catch (err) {
    throw new UserError(t('browser.playwrightMissing'), t('browser.playwrightHint', { error: err.message }));
  }
}

export async function isChromiumInstalled() {
  const { chromium } = await playwright();
  try {
    const exe = chromium.executablePath();
    return Boolean(exe && fs.existsSync(exe));
  } catch {
    return false;
  }
}

export async function installChromium({ quiet = false } = {}) {
  const dest = browsersPath();
  let cliPath;
  try {
    cliPath = require.resolve('playwright-core/cli.js');
  } catch {
    try {
      const pkg = require.resolve('playwright-core/package.json');
      cliPath = path.join(path.dirname(pkg), 'cli.js');
    } catch {
      cliPath = null;
    }
  }
  if (!cliPath || !fs.existsSync(cliPath)) {
    throw new UserError(t('browser.installerMissing'), t('browser.installerHint', { dir: dest }));
  }

  const s = quiet ? null : spinner();
  s?.start(t('browser.downloading'));

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dest },
      stdio: quiet ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    child.stdout?.on('data', (d) => {
      tail = (tail + d.toString()).slice(-400);
    });
    child.stderr?.on('data', (d) => {
      tail = (tail + d.toString()).slice(-400);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new UserError(t('browser.downloadFailed', { code }), tail.trim()));
    });
  });

  s?.stop(t('browser.ready'));
  return dest;
}

/**
 * Chromium gerekiyorsa kullanıcıdan izin alıp indirir.
 * `--yes` verilmişse sormaz; CI'da takılıp kalmasın.
 */
export async function ensureChromium({ assumeYes = false, reason = '' } = {}) {
  if (await isChromiumInstalled()) return true;

  if (!assumeYes) {
    log.info(t('browser.needsBrowser', { reason: reason ? ` (${reason})` : '', dir: BROWSERS_DIR }));
    const ok = await confirm({ message: t('browser.askDownload') });
    if (!ok) {
      throw new UserError(t('browser.refused'), t('browser.refusedHint'));
    }
  }

  await installChromium();
  return true;
}

export async function launchChromium({ insecure = false } = {}) {
  await ensureChromium({ reason: t('browser.sessionReason') });
  const { chromium } = await playwright();
  return chromium.launch({
    headless: true,
    args: insecure ? ['--ignore-certificate-errors'] : [],
  });
}

export { BROWSERS_DIR };
