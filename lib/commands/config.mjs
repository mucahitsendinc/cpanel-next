import { getPreferences, savePreference, loadGlobalConfig } from '../config.mjs';
import { CONFIG_FILE } from '../paths.mjs';
import { setLocale, AVAILABLE, t } from '../i18n/index.mjs';
import { intro, outro, select, note, log, color } from '../ui.mjs';

/**
 * Ayarlar.
 *
 * Tek bir yer: varsayılan arayüz (web / terminal) ve dil. İkisi de her
 * çalıştırmada bayrakla geçilebiliyor; burası yalnızca varsayılanı belirler.
 */
export async function run({ flags, positionals }) {
  // `deploymanager config ui web` gibi doğrudan kullanım — betikler için.
  const [key, value] = positionals;
  if (key && value) {
    if (key === 'ui' && ['web', 'terminal'].includes(value)) {
      savePreference('ui', value);
      log.success(t('config.uiSaved', { mode: t(`config.ui${cap(value)}`) }));
      return;
    }
    if (key === 'lang' && AVAILABLE.includes(value)) {
      savePreference('lang', value);
      setLocale(value);
      log.success(t('config.langSaved', { lang: value }));
      return;
    }
    log.error(t('config.unknownSetting', { key, value }));
    process.exitCode = 2;
    return;
  }

  intro(t('config.title'));

  const prefs = getPreferences();
  const cfg = loadGlobalConfig();

  note(
    [
      `${color.dim(t('config.labelFile'))}  ${CONFIG_FILE}`,
      `${color.dim(t('config.labelProfiles'))}  ${Object.keys(cfg.profiles ?? {}).length}`,
      `${color.dim(t('config.labelUi'))}  ${prefs.ui ? t(`config.ui${cap(prefs.ui)}`) : t('config.notSet')}`,
      `${color.dim(t('config.labelLang'))}  ${prefs.lang ?? t('config.auto')}`,
    ].join('\n'),
    t('config.current')
  );

  const ui = await select({
    message: t('config.askUi'),
    options: [
      { value: 'terminal', label: t('config.uiTerminal'), hint: t('config.uiTerminalHint') },
      { value: 'web', label: t('config.uiWeb'), hint: t('config.uiWebHint') },
    ],
    initialValue: prefs.ui ?? 'terminal',
  });
  savePreference('ui', ui);

  const lang = await select({
    message: t('config.askLang'),
    options: [
      { value: 'auto', label: t('config.auto') },
      ...AVAILABLE.map((l) => ({ value: l, label: l === 'tr' ? 'Türkçe' : 'English' })),
    ],
    initialValue: prefs.lang ?? 'auto',
  });
  if (lang === 'auto') savePreference('lang', null);
  else {
    savePreference('lang', lang);
    setLocale(lang);
  }

  outro(t('config.saved'));
}

/**
 * İlk çalıştırmada arayüz tercihini bir kez sorar.
 *
 * Tercih kaydedilene kadar her seferinde sormak sinir bozucu olurdu; bir kez
 * sorup kaydediyoruz. `deploymanager config` ile veya `--web`/`--terminal`
 * bayraklarıyla her zaman değiştirilebilir.
 */
export async function ensureUiPreference() {
  const prefs = getPreferences();
  if (prefs.ui) return prefs.ui;

  log.info(t('config.firstRun'));
  const ui = await select({
    message: t('config.askUi'),
    options: [
      { value: 'terminal', label: t('config.uiTerminal'), hint: t('config.uiTerminalHint') },
      { value: 'web', label: t('config.uiWeb'), hint: t('config.uiWebHint') },
    ],
    initialValue: 'terminal',
  });
  savePreference('ui', ui);
  log.info(t('config.changeLater'));
  return ui;
}

const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1);
