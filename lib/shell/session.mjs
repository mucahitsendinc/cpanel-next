/**
 * SUNUCUDA KALICI ÇALIŞMA DİZİNİ OLAN KABUK OTURUMU.
 *
 * Worker her işi ayrı bir `sh` çağrısıyla koşuyor, yani süreç durumu iki komut
 * arasında YAŞAMIYOR. Kullanıcı `cd public` yazıp sonra `ls` yazdığında ikinci
 * komut ev dizininde koşardı — bir terminali kullanılamaz kılan tam olarak bu.
 *
 * Çözüm: dizini İSTEMCİDE tutmak ve her komuttan önce oraya girmek. Komut
 * bittikten sonra `pwd` okunuyor, böylece `cd ..`, `cd -`, `cd` (ev dizini) ve
 * komutun içindeki dizin değişiklikleri de doğru izleniyor — biz `cd`'yi
 * ayrıştırmıyoruz, kabuğa SORUYORUZ.
 *
 * ⚠ SSH YOK. Bu araç paylaşımlı hostingde SSH olmadan çalışmak için var;
 * komutlar cron ile başlatılan uzun ömürlü worker'a dosya bırakılarak
 * gönderiliyor. Worker 2 saniyede bir yokladığı için tur süresi birkaç saniye.
 */

/*
 * Çıktının sonuna eklenen işaretler.
 *
 * Kullanıcının kendi çıktısıyla karışmasınlar diye rastgele değil ama yeterince
 * tuhaflar; ayrıca SON eşleşme alınıyor, yani kullanıcı bu metni yazdırsa bile
 * gerçek olan sonuncusu oluyor.
 */
export const EXIT_MARK = '__CN_EXIT__';
export const CWD_MARK = '__CN_CWD__';

/** Ev dizini gösterimi: `/home/user/public_html` → `~/public_html`. */
export function prettyCwd(cwd, home) {
  if (!cwd) return '~';
  if (cwd === home) return '~';
  if (home && cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
  return cwd;
}

/**
 * Worker'a gönderilecek betik.
 *
 * ⚠ KULLANICININ KOMUTU AYRI BİR SATIRDA, OLDUĞU GİBİ.
 *
 * `sh -c '<komut>'` ile sarmalamak cazip ama YANLIŞ olurdu: `cd` alt kabukta
 * koşar ve biz `pwd` okuduğumuzda değişiklik kaybolmuş olurdu. Komut ana
 * kabukta koşmalı ki dizin değişikliği `pwd`'ye yansısın.
 *
 * Bunun bedeli: kullanıcının yazım hatası betiği bozabilir. Kabul edilebilir,
 * çünkü burada betik ZATEN kullanıcının komutundan ibaret — bozulacak bir
 * yayın hattı yok, yalnızca o komut başarısız oluyor.
 */
export function buildScript(command, { cwd = null, home = '$HOME' } = {}) {
  const start = cwd ? cwd : home;
  return [
    // Dizin silinmişse ev dizinine düşüyoruz; komutun hiç koşmaması yerine
    // beklenen yerde koşması daha iyi.
    `cd ${shellQuote(start)} 2>/dev/null || cd ${home} 2>/dev/null || cd /`,
    /*
     * ⚠ TEK BİR `EXIT` TRAP'İ VAR — BU YÜZDEN TRAP KURMUYORUZ, KANCA TANIMLIYORUZ.
     *
     * CANLIDA GÖRÜLEN HATA: bu betik kendi `trap ... EXIT`ini kuruyordu ve
     * POSIX kabuğunda tek bir EXIT trap'i olduğu için worker'ın iş
     * sarmalayıcısındaki `cn_finish` trap'ini EZİYORDU. Sonuç: komut
     * çalışıyor, çıktısını yazıyor, ama durum dosyası hiç `done` olmuyor;
     * istemci işin bittiğini göremeyip zaman aşımına kadar yokluyor.
     * Ekranda "Baslatildi" yazıp öyle kalıyordu.
     *
     * Çözüm: işaretleri bir FONKSİYONA koyuyoruz. Sarmalayıcı varsa onun tek
     * trap'i bunu çağırıyor; yoksa (betik tek başına koşuyorsa, testlerde
     * olduğu gibi) yedek olarak trap'i kendimiz kuruyoruz.
     *
     * Kanca `exit`i de kapsıyor: kullanıcı `exit 42` yazdığında bile çıkış
     * kodu ve çalışma dizini geri geliyor.
     */
    `cn_marks() { printf '\\n${EXIT_MARK}%s\\n' "$1"; printf '${CWD_MARK}%s\\n' "$(pwd)"; }`,
    `command -v cn_finish >/dev/null 2>&1 || trap 'cn_marks "$?"' EXIT`,
    command,
  ].join('\n');
}

/** Tek tırnaklı POSIX alıntılama. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Worker çıktısını çözer.
 *
 * İşaretler çıktıdan AYIKLANIYOR: kullanıcı ekranda kendi komutunun çıktısını
 * görmeli, bizim iç protokolümüzü değil.
 *
 * @returns {{output: string, exitCode: number|null, cwd: string|null}}
 */
export function parseResult(raw) {
  const text = String(raw ?? '');
  const lines = text.split('\n');

  let exitCode = null;
  let cwd = null;
  const kept = [];

  for (const line of lines) {
    if (line.startsWith(EXIT_MARK)) {
      const n = Number.parseInt(line.slice(EXIT_MARK.length), 10);
      // SON eşleşme kazanıyor: kullanıcı çıktısı işareti taklit etse bile
      // gerçek olan, en sonda bizim yazdığımız.
      if (Number.isFinite(n)) exitCode = n;
      continue;
    }
    if (line.startsWith(CWD_MARK)) {
      const value = line.slice(CWD_MARK.length).trim();
      if (value) cwd = value;
      continue;
    }
    kept.push(line);
  }

  // İşaretlerden önce eklediğimiz boş satır geri alınıyor.
  while (kept.length && kept[kept.length - 1] === '') kept.pop();

  return { output: kept.join('\n'), exitCode, cwd };
}

/*
 * Bir kabuk oturumunun tutması gereken tek durum: nerede olduğu.
 *
 * Ortam değişkenleri ve kabuk fonksiyonları KASITLI olarak taşınmıyor.
 * Taşımaya çalışmak (her komuttan sonra `export -p` okuyup bir sonrakine
 * enjekte etmek) hem kırılgan hem de kullanıcıyı yanıltıcı olurdu: gerçek bir
 * kalıcı kabuk olmadığı hâlde öyleymiş gibi davranır, sonra beklenmedik bir
 * yerde ayrışırdı. Dizin, gerçekten gereken ve doğru izlenebilen tek durum.
 */
export function createSession({ home = null } = {}) {
  return { cwd: home, home, history: [] };
}

/** Komut sonrası oturumu günceller. */
export function applyResult(session, result) {
  if (result?.cwd) session.cwd = result.cwd;
  return session;
}
