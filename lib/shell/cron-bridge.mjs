import { randomBytes } from 'node:crypto';
import { UserError } from '../ui.mjs';
import { t } from '../i18n/index.mjs';
import { REMOTE } from '../paths.mjs';
import * as remote from '../remote.mjs';

/**
 * Kabuk komutlarını cPanel kullanıcısı bağlamında çalıştırır — SSH olmadan.
 *
 * NEDEN GEREKLİ: CloudLinux Node.js Selector'ün API'si yoktur. cPanel'in 96
 * UAPI modülünün hiçbiri CloudLinux'a dokunmaz; tek arayüz `cloudlinux-selector`
 * CLI'ı, o da kabuk ister. Paylaşımlı hostların çoğunda SSH kapalıdır
 * (CageFS + `noshell`).
 *
 * NASIL: cPanel'in kendi cron'u bizim adımıza komut çalıştırabilir.
 *   1. Fileman ile bir PHP betiği yaz
 *   2. API2 `Cron::add_line` ile dakikalık tek seferlik bir cron kaydet
 *   3. Betik çalışınca ÖNCE kendi cron satırını siler, sonra işi yapar ve
 *      ilerlemeyi `status_<id>.json` dosyasına yazar
 *   4. Durum dosyasını yoklayarak ilerlemeyi ekrana taşı
 *
 * Bu yöntem üretimde ~90 hesapta koşuyor; buradaki savunmaların her biri
 * gerçek bir arızadan geliyor.
 */

const PHP_CANDIDATES = [
  '/usr/local/bin/ea-php83',
  '/usr/local/bin/ea-php82',
  '/usr/local/bin/ea-php81',
  '/usr/local/bin/php',
  'php',
];

export async function exec(ctx, command, { timeout = 20 * 60_000, onProgress, label = 'Komut' } = {}) {
  const id = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const runDir = REMOTE.runDir;
  const phpBin = ctx.capabilities?.phpBin ?? (await detectPhp(ctx));

  await remote.mkdirp(ctx.client, runDir);
  await remote.saveFile(ctx.client, runDir, `run_${id}.php`, wrapScript(id, command, ctx.client.user));

  const cronCommand = `${phpBin} /home/${ctx.client.user}/${runDir}/run_${id}.php`;
  await ctx.client.api2('Cron', 'add_line', {
    command: cronCommand,
    minute: '*',
    hour: '*',
    day: '*',
    month: '*',
    weekday: '*',
  });

  try {
    return await poll(ctx, id, runDir, { timeout, onProgress, label });
  } finally {
    // Betik kendi satırını silmiş olmalı; olmadıysa API üzerinden temizle ve
    // DOĞRULA. Yetim cron satırı, her dakika koşan bir hayalet demektir.
    await removeCronLine(ctx, cronCommand).catch(() => {});
    await remote.remove(ctx.client, `${runDir}/run_${id}.php`, { required: false }).catch(() => {});
    await remote.remove(ctx.client, `${runDir}/status_${id}.json`, { required: false }).catch(() => {});
  }
}

async function poll(ctx, id, runDir, { timeout, onProgress, label }) {
  const deadline = Date.now() + timeout;
  let lastStep = '';
  let waited = 0;

  while (Date.now() < deadline) {
    // İlk tur cron'u beklediğimiz için seyrek, sonra sıklaştırıyoruz.
    const delay = waited < 60_000 ? 5_000 : 3_000;
    await sleep(delay);
    waited += delay;

    const status = await remote.readJson(ctx.client, runDir, `status_${id}.json`).catch(() => null);
    if (!status) {
      if (waited > 150_000) {
        throw new UserError(t('cron.notTriggered', { label }), t('cron.notTriggeredHint'));
      }
      continue;
    }

    if (status.step && status.step !== lastStep) {
      lastStep = status.step;
      onProgress?.(status.step, status.progress ?? 0);
    }

    if (status.done) {
      if (!status.ok) {
        const err = new UserError(t('cron.failed', { label, error: status.error || t('cron.unknownError') }));
        err.output = status.output;
        throw err;
      }
      return { output: String(status.output ?? ''), ok: true };
    }
  }

  throw new UserError(t('cron.timeout', { label, minutes: Math.round(timeout / 60000) }));
}

/**
 * PHP sarmalayıcı.
 *
 * `deha_progress()` ve `$DEHA_OUTPUT` gövdeye açılır; gövde bunları kullanarak
 * ilerleme bildirir.
 */
function wrapScript(id, body, user) {
  const runDir = REMOTE.runDir;
  const statusPath = `/home/${user}/${runDir}/status_${id}.json`;
  const lockPath = `/home/${user}/${runDir}/lock_${id}`;
  const selfPath = `/home/${user}/${runDir}/run_${id}.php`;

  return `<?php
/* cpanel-next ${id} */
$STATUS = ${JSON.stringify(statusPath)};
$LOCK   = ${JSON.stringify(lockPath)};
$SELF   = ${JSON.stringify(selfPath)};

/* Tek örnek: cron dakikada bir tetikliyor, iş 3 dakika sürerse üç kopya
   aynı anda koşmasın. */
if (@file_exists($LOCK)) { exit; }
@file_put_contents($LOCK, (string)time());

/* KENDİ CRON SATIRINI SİL — ama crontab'ı silme.
   \`crontab -l | grep -v X | crontab -\` kalıbı, \`crontab -l\` boş çıktığında
   TÜM crontab'ı siler. Üretimde 93 hesabın 93'ünde tam olarak bu oldu.
   O yüzden önce çıktı gerçekten var mı diye bakıyoruz. */
$cur = @shell_exec('crontab -l 2>/dev/null');
if (is_string($cur) && trim($cur) !== '') {
    $lines = preg_split('/\\r?\\n/', $cur);
    $kept = array();
    foreach ($lines as $line) {
        if (strpos($line, 'run_${id}.php') === false) { $kept[] = $line; }
    }
    $tmp = ${JSON.stringify(`/home/${user}/${runDir}/crontab_${id}.txt`)};
    @file_put_contents($tmp, implode("\\n", $kept) . "\\n");
    @shell_exec('crontab ' . escapeshellarg($tmp) . ' 2>&1');
    @unlink($tmp);
}

ini_set('memory_limit', '2G');
set_time_limit(3600);
ini_set('max_execution_time', 3600);

$DEHA_OUTPUT = '';
function deha_progress($pct, $step) {
    global $STATUS;
    @file_put_contents($STATUS, json_encode(array(
        'progress' => (int)$pct, 'step' => (string)$step, 'done' => false
    )));
}

try {
    deha_progress(3, 'Baslatildi');
${body}
    @file_put_contents($STATUS, json_encode(array(
        'progress' => 100, 'step' => 'Tamamlandi', 'done' => true, 'ok' => true,
        'output' => $DEHA_OUTPUT
    )));
} catch (\\Throwable $e) {
    @file_put_contents($STATUS, json_encode(array(
        'progress' => 100, 'step' => 'Hata', 'done' => true, 'ok' => false,
        'error' => $e->getMessage(), 'output' => $DEHA_OUTPUT
    )));
}

@unlink($SELF);
@unlink($LOCK);
`;
}

/**
 * Cron satırını API üzerinden siler.
 *
 * ⚠ `Cron::remove_line` `linekey` DEĞİL, `line` (satır NUMARASI) alır —
 * `edit_line` linekey alırken. Bu yüzden satır numarasını asla önbelleğe
 * almıyoruz: silmeden hemen önce listeyi tazeliyoruz.
 */
async function removeCronLine(ctx, command) {
  const data = await ctx.client.api2('Cron', 'listcron', {});
  const rows = Array.isArray(data?.data) ? data.data : Object.values(data?.data ?? {});
  const index = rows.findIndex((r) => String(r.command || '').includes(command.split('/').pop()));
  if (index < 0) return false;
  await ctx.client.api2('Cron', 'remove_line', { line: index + 1 });
  return true;
}

async function detectPhp(ctx) {
  // Hangi PHP ikilisinin var olduğunu dosya varlığıyla anlıyoruz; kabuk
  // olmadan `command -v` çalıştıramayız.
  for (const candidate of PHP_CANDIDATES) {
    if (!candidate.startsWith('/')) continue;
    try {
      await ctx.client.uapi('Fileman', 'get_file_information', { path: candidate });
      if (ctx.capabilities) ctx.capabilities.phpBin = candidate;
      return candidate;
    } catch {
      /* sıradaki */
    }
  }
  const fallback = '/usr/local/bin/php';
  if (ctx.capabilities) ctx.capabilities.phpBin = fallback;
  return fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** PHP gövdesi içine güvenle gömülecek kabuk komutu. */
export function shellLine(command, { progress = null, label = null } = {}) {
  const parts = [];
  if (progress !== null) {
    parts.push(`    deha_progress(${progress}, ${JSON.stringify(label ?? 'Calisiyor')});`);
  }
  parts.push(
    `    $DEHA_OUTPUT .= (string)@shell_exec(${JSON.stringify(`${command} 2>&1`)}) . "\\n";`
  );
  return parts.join('\n');
}
