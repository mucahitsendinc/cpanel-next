import { randomBytes } from 'node:crypto';
import { loadGlobalConfig, getPreferences } from '../config.mjs';
import { unlockVault, openToken } from '../vault.mjs';
import { createSession } from '../shell/session.mjs';
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
/**
 * Bellekte tutulan en fazla iş sayısı.
 *
 * Terminal komut başına bir iş yarattığı için bu sınır olmadan `state.jobs`
 * sınırsız büyüyor ve `/api/status` her yoklamada daha büyük bir yanıt
 * döndürüyor. 50, bir oturumun geçmişini görmek için fazlasıyla yeterli.
 */
export const MAX_JOBS = 50;

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

      /*
       * cPanel ŞİFRESİ — yalnızca kullanıcı açıkça istediyse var.
       *
       * Varsayılan olarak saklanmıyor ve bu aracın kuruluş ilkesi. Ama
       * cPanel'in kendi ekranlarına (phpMyAdmin, Dosya Yöneticisi) OTOMATİK
       * giriş yapmanın başka yolu yok: cPanel spesifikasyonu
       * `Session::create_temp_user` için "geçerli bir cPanel oturumu
       * gerektirir, aksi hâlde WHM API'sini kullanın" diyor — yani API
       * token'ından tarayıcı oturumu üretilemiyor.
       *
       * Saklandığında token'la aynı kasada, aynı ana şifreyle, aynı
       * AES-256-GCM ile duruyor.
       */
      let password = null;
      if (p.passwordEnc && key) {
        try {
          password = openToken(key, p.passwordEnc);
        } catch {
          password = null; // bozuk kayıt otomatik girişi kapatır, açılışı değil
        }
      }

      state.unlocked.set(name, {
        name,
        host: p.host,
        port: p.port ?? 2083,
        user: p.user,
        tokenName: p.tokenName ?? null,
        token,
        password,
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
      /*
       * Terminal oturumu — tek durumu ÇALIŞMA DİZİNİ.
       *
       * Worker her komutu ayrı bir `sh` ile koşuyor, yani `cd` normalde iki
       * komut arasında yaşamıyor. Dizini burada tutup her komuttan önce
       * oraya giriyoruz (bkz. shell/session.mjs).
       *
       * Ctx'in içinde olması ömrünü doğru yere bağlıyor: kasa kilitlenince
       * ya da profil yenilenince kendiliğinden sıfırlanıyor.
       */
      shell: createSession({ home: `/home/${profile.user}` }),
      // Aynı anda iki komut çalıştırmayı engelleyen bayrak. Worker işleri
      // zaten seri koşuyor; paralel yoklama yalnızca cPanel API'sini döverdi.
      shellBusy: false,
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
    pruneJobs();
    return job;
  };

  /*
   * BİTEN İŞLER BUDANIYOR.
   *
   * `state.jobs` hiç temizlenmiyordu. Deploy için sorun değildi — bir
   * oturumda birkaç tane oluyor. Terminal bunu değiştiriyor: her komut bir
   * iş, yani yoğun bir oturum yüzlerce kayıt bırakır. `/api/status` bütün
   * işleri özetleyip döndürdüğü için bu, her yoklamada büyüyen bir yanıt
   * demek.
   *
   * ⚠ ÇALIŞAN İŞ ASLA ATILMIYOR. Yalnızca bitmiş olanlar, en eskiden
   * başlayarak. Çalışan bir işi atmak, arayüzün onu izleyemez hâle gelmesi
   * ve `hasRunningJobs`'un yanlış cevap vermesi demekti — o da terminale
   * dönmenin yarıda kesilmesine yol açardı.
   */
  const pruneJobs = () => {
    if (state.jobs.size <= MAX_JOBS) return;
    const finished = [...state.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));

    let excess = state.jobs.size - MAX_JOBS;
    for (const job of finished) {
      if (excess <= 0) break;
      // Açık SSE dinleyicisi varsa bırakılıyor: tarayıcı hâlâ okuyor olabilir.
      if (job.listeners.size) continue;
      state.jobs.delete(job.id);
      excess -= 1;
    }
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
    /*
     * İPUCU DA AKIŞA GİRİYOR.
     *
     * Eskiden yalnızca `message` gidiyordu ve worker'ın taşıdığı komut çıktısı
     * (`hint`) arayüze hiç ulaşmıyordu: kullanıcı "Laravel başarısız:
     * migrate:fresh" görüp neden olduğunu göremiyordu. Sunucuda ne olduğunu
     * söyleyen tek yer o çıktı.
     */
    state.pushEvent(job, {
      type: job.status,
      text: error ? error.message : null,
      hint: error?.hint ?? null,
    });
  };

  return state;
}

/** Tarayıcıya giden profil gösterimi — token ve şifre ASLA dahil değil. */
export function publicProfile(p) {
  return {
    name: p.name,
    host: p.host,
    port: p.port,
    user: p.user,
    tokenName: p.tokenName,
    hasToken: Boolean(p.token),
    // Şifrenin KENDİSİ değil, yalnızca VAR OLDUĞU bilgisi: arayüz buna bakıp
    // "otomatik giriş" düğmesini gösteriyor.
    hasPassword: Boolean(p.password),
  };
}
