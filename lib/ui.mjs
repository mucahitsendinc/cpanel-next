import * as p from '@clack/prompts';
import color from 'picocolors';
import { t } from './i18n/index.mjs';

export { color, t };

export const intro = (msg) => p.intro(color.bgCyan(color.black(` ${msg} `)));
export const outro = (msg) => p.outro(msg);
export const note = (body, title) => p.note(body, title);
export const spinner = () => p.spinner();
export const log = p.log;

/** Kullanıcı Ctrl-C'ye bastıysa temiz çık — yarım kalmış iş bırakma. */
export function guardCancel(value, message = null) {
  if (p.isCancel(value)) {
    p.cancel(message ?? t('common.cancelled'));
    process.exit(130);
  }
  return value;
}

export async function text(opts) {
  return guardCancel(await p.text(opts));
}

export async function password(opts) {
  return guardCancel(await p.password(opts));
}

export async function select(opts) {
  return guardCancel(await p.select(opts));
}

export async function confirm(opts) {
  return guardCancel(await p.confirm(opts));
}

/**
 * Yıkıcı işlemler için yazarak onay.
 *
 * `y/N` refleks hâline gelir; app-root adını elle yazdırmak kullanıcıyı
 * neye dokunduğunu okumaya zorlar. Bu aracın en ucuz güvenlik katmanı.
 */
export async function typeToConfirm(expected, promptText = null) {
  const answer = await text({
    message: promptText ?? t('common.typeToConfirm'),
    placeholder: expected,
    validate: (v) => (v === expected ? undefined : t('common.mustType', { expected })),
  });
  return answer === expected;
}

/** Basit hizalı tablo. Genişlik hesabı ANSI kodlarını saymaz. */
export function table(headers, rows) {
  if (!rows.length) return color.dim(t('common.noRecords'));
  const all = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...all.map((r) => stripAnsi(String(r[i] ?? '')).length))
  );
  const line = (cells) =>
    '  ' +
    cells
      .map((c, i) => {
        const raw = String(c ?? '');
        const pad = widths[i] - stripAnsi(raw).length;
        return raw + ' '.repeat(Math.max(0, pad));
      })
      .join('  ');

  const head = color.bold(line(headers));
  const rule = color.dim('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  return [head, rule, ...rows.map(line)].join('\n');
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

export function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n || 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Hatayı kullanıcıya anlaşılır biçimde bas ve çık. Yığın izi yalnız --verbose'ta. */
export function fail(err, { verbose = false } = {}) {
  const message = err instanceof Error ? err.message : String(err);
  p.log.error(color.red(message));
  if (verbose && err instanceof Error && err.stack) {
    console.error(color.dim(err.stack));
  }
  if (err?.hint) {
    p.log.info(err.hint);
  }
  // Deploy yarıda kaldıysa bakım sayfası açık bırakılıyor; kullanıcı bunu
  // ekranda görmeli, yoksa sitenin neden "yenileniyor" dediğini anlamaz.
  if (err?.maintenanceLeftOn) {
    p.log.warn(t('deploy.maintenanceLeftOn', { domain: err.maintenanceLeftOn }));
  }
  process.exit(1);
}

/** Sebebi ve çözümü birlikte taşıyan hata. `hint` kullanıcıya ne yapacağını söyler. */
export class UserError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}
