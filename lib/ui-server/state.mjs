import { randomBytes } from 'node:crypto';
import { loadGlobalConfig, getPreferences } from '../config.mjs';
import { unlockVault, openToken } from '../vault.mjs';
import { CpanelClient } from '../cpanel.mjs';
import { probe } from '../probe.mjs';
import { loadDriver } from '../context.mjs';
import { detectLocale, setLocale } from '../i18n/index.mjs';
import { UserError } from '../ui.mjs';

/**
 * Sunucu durumu.
 *
 * Çözülmüş cPanel token'ları YALNIZCA burada, bellekte durur. Tarayıcıya
 * hiçbir zaman gönderilmez; arayüz yalnızca profil adlarını görür ve işlemleri
 * sunucuya yaptırır.
 *
 * Belirli bir süre işlem olmazsa kasa kendini kilitler — açık bir sekme
 * unutulduğunda token süresiz açıkta kalmasın.
 */
export function createState({ lang = null, verbose = false, idleLockMs = 15 * 60_000 } = {}) {
  const state = {
    // Sıra: açık parametre → KAYITLI TERCİH → sistem yereli.
    // Kayıtlı tercih atlanırsa kullanıcı her açılışta dili yeniden seçmek
    // zorunda kalıyordu.
    lang: setLocale(lang ?? getPreferences().lang ?? detectLocale()),
    verbose,
    idleLockMs,
    locked: true,
    /** profil adı → { host, port, user, token } — token DİSKTEN değil, kasadan */
    unlocked: new Map(),
    /** profil adı → { client, probeResult, driver, capabilities } */
    sessions: new Map(),
    jobs: new Map(),
    lastTouch: Date.now(),
    timer: null,
    /* --- tarayıcı yaşam döngüsü --- */
    vaultKey: null,
    lastBeat: 0,
    sawClient: false,
    exitRequested: false,
  };

  state.touch = () => {
    state.lastTouch = Date.now();
  };

  /**
   * Tarayıcıdan gelen kalp atışı.
   *
   * Sekmenin kapandığını anlamanın güvenilir tek yolu bu: sayfa düzenli ping
   * atar, ping kesilirse sayfa yok demektir. `beforeunload`/`sendBeacon`
   * güvenilmez (sekme çökerse, ağ kesilirse veya tarayıcı beacon'ı düşürürse
   * hiç gelmez); atış yokluğu ise her durumda doğru sinyal.
   */
  state.beat = () => {
    state.lastBeat = Date.now();
    state.sawClient = true;
    state.touch();
  };

  state.hasRunningJobs = () => [...state.jobs.values()].some((j) => j.status === 'running');

  /**
   * Terminale dönme zamanı geldi mi?
   *
   * ⚠ ÇALIŞAN İŞ VARSA ASLA. Deploy sürerken sekme kapanırsa süreci
   * öldürmek, yarım açılmış bir uygulama bırakır — cron köprüsünün sağladığı
   * dayanıklılığı tam da gerektiği anda çöpe atardı.
   */
  state.shouldExit = (graceMs = 12_000) => {
    if (state.exitRequested) return !state.hasRunningJobs();
    if (!state.sawClient) return false;
    if (state.hasRunningJobs()) return false;
    return Date.now() - state.lastBeat > graceMs;
  };

  state.lock = () => {
    state.vaultKey = null;
    state.unlocked.clear();
    state.sessions.clear();
    state.locked = true;
  };

  state.dispose = () => {
    if (state.timer) clearInterval(state.timer);
    state.lock();
  };

  // Boşta kalma denetimi. Sabit aralıkla bakıyoruz; her istekte zamanlayıcı
  // kurmaktan daha ucuz ve öngörülebilir.
  state.timer = setInterval(() => {
    if (!state.locked && Date.now() - state.lastTouch > state.idleLockMs) state.lock();
  }, 30_000);
  state.timer.unref?.();

  /**
   * Ana şifreyle kasayı açar ve TÜM profillerin token'larını çözer.
   *
   * Tek ana şifre bütün profilleri açıyor (kasa tek); kullanıcı sunucu başına
   * ayrı şifre ezberlemek zorunda değil.
   */
  state.unlock = (masterPassword) => {
    const config = loadGlobalConfig();
    const profiles = config.profiles ?? {};
    const names = Object.keys(profiles);
    if (!names.length) throw new UserError('no profiles');

    const needsVault = names.some((n) => profiles[n].tokenEnc);
    let key = null;
    if (needsVault) {
      if (!config.vault) throw new UserError('vault missing');
      key = unlockVault(config.vault, masterPassword); // yanlış şifrede fırlatır
    }

    state.unlocked.clear();
    state.sessions.clear();
    for (const name of names) {
      const p = profiles[name];
      let token = p.token ?? null; // eski biçim: şifresiz
      if (p.tokenEnc && key) token = openToken(key, p.tokenEnc);
      state.unlocked.set(name, {
        name,
        host: p.host,
        port: p.port ?? 2083,
        user: p.user,
        tokenName: p.tokenName ?? null,
        token,
      });
    }
    /*
     * Türetilmiş anahtar oturum boyunca bellekte kalıyor.
     *
     * Yeni bir cPanel hesabı eklerken ana şifreyi TEKRAR sormamak için:
     * kasa tek, şifre tek. Her hesabın ayrı şifresi yok ve olmamalı.
     */
    state.vaultKey = key;
    state.locked = false;
    state.touch();
    return [...state.unlocked.values()].map(publicProfile);
  };

  /** Bir profil için hazır bağlam (client + sürücü). İlk çağrıda sonda atar. */
  state.session = async (profileName, { refresh = false } = {}) => {
    if (state.locked) throw new UserError('locked');
    const profile = state.unlocked.get(profileName);
    if (!profile) throw new UserError(`unknown profile: ${profileName}`);

    if (!refresh && state.sessions.has(profileName)) return state.sessions.get(profileName);

    const client = new CpanelClient({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      token: profile.token,
      verbose: state.verbose,
    });

    const probeResult = await probe(client, { refresh, verbose: state.verbose });
    const driver = await loadDriver(probeResult.regime);

    const ctx = {
      client,
      driver,
      probeResult,
      cfg: { host: profile.host, port: profile.port, user: profile.user, token: profile.token },
      flags: {},
      cleanup: [],
      capabilities: {},
      profileName,
    };
    state.sessions.set(profileName, ctx);
    return ctx;
  };

  /** Henüz profil olarak kaydedilmemiş bir hesap için geçici istemci. */
  state.clientFor = ({ host, port, user, session }) =>
    new CpanelClient({ host, port, user, session, verbose: state.verbose });

  /* ------------------------------------------------------------------ işler */

  /**
   * Uzun süren işler (deploy, rollback) sunucuda yaşar.
   *
   * Sekme kapansa bile devam ederler — cron köprüsünün zaten sağladığı
   * dayanıklılığı arayüz tarafında da korumak için. Olaylar biriktirilir, yeni
   * bağlanan bir dinleyici geçmişi baştan alır.
   */
  state.createJob = (type, meta = {}) => {
    const id = randomBytes(8).toString('hex');
    const job = {
      id,
      type,
      meta,
      status: 'running',
      events: [],
      listeners: new Set(),
      result: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    state.jobs.set(id, job);
    return job;
  };

  state.pushEvent = (job, event) => {
    const stamped = { ...event, at: Date.now() };
    job.events.push(stamped);
    if (job.events.length > 2000) job.events.splice(0, job.events.length - 2000);
    for (const send of job.listeners) {
      try {
        send(stamped);
      } catch {
        /* kopmuş dinleyici; SSE tarafında temizleniyor */
      }
    }
  };

  state.finishJob = (job, { result = null, error = null }) => {
    job.status = error ? 'failed' : 'done';
    job.result = result;
    job.error = error ? { message: error.message, hint: error.hint ?? null } : null;
    job.endedAt = Date.now();
    state.pushEvent(job, { type: job.status, text: error ? error.message : null });
  };

  return state;
}

/** Tarayıcıya giden profil gösterimi — token ASLA dahil değil. */
export function publicProfile(p) {
  return {
    name: p.name,
    host: p.host,
    port: p.port,
    user: p.user,
    tokenName: p.tokenName,
    hasToken: Boolean(p.token),
  };
}
