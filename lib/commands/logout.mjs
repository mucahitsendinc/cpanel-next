import { loadGlobalConfig, removeProfile } from '../config.mjs';
import { clearCache } from '../probe.mjs';
import { t } from '../i18n/index.mjs';
import { intro, outro, select, confirm, log, color, UserError } from '../ui.mjs';

export async function run({ flags }) {
  intro(t('logout.title'));

  const config = loadGlobalConfig();
  const names = Object.keys(config.profiles ?? {});

  if (!names.length) {
    log.info(t('logout.noProfiles'));
    outro('');
    return;
  }

  const name =
    flags.profile ??
    (names.length === 1
      ? names[0]
      : await select({
          message: t('logout.which'),
          options: names.map((n) => ({
            value: n,
            label: n,
            hint: config.profiles[n].user,
          })),
        }));

  if (!config.profiles[name]) {
    throw new UserError(t('logout.notFound', { name }));
  }

  const profile = config.profiles[name];
  if (!flags.yes) {
    const ok = await confirm({
      message: t('logout.confirm', { user: profile.user, host: profile.host }),
    });
    if (!ok) {
      outro(t('common.cancelled'));
      return;
    }
  }

  removeProfile(name);
  clearCache();

  log.success(t('logout.removed'));
  if (profile.tokenName) {
    // Token'ı yalnızca yerelden sildik; sunucuda hâlâ geçerli. Kullanıcının
    // bunu bilmesi lazım, yoksa "çıkış yaptım" sanıp açıkta bırakır.
    log.warn(t('logout.tokenStillValid', { name: color.bold(profile.tokenName) }));
  }

  outro('');
}
