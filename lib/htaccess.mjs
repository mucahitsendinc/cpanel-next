/**
 * `.htaccess` içinde İŞARETLİ blok yönetimi — tamamen saf.
 *
 * Bu dosya, aracın başkasının dosyasına dokunduğu tek yer olduğu için ayrı
 * duruyor. Bir docroot `.htaccess`'i genelde bize ait olmayan şeyler taşır:
 * CloudLinux'un Passenger bloğu, hostun eklediği yönlendirmeler, kullanıcının
 * kendi kuralları. Hiçbirine dokunmuyoruz — yalnızca KENDİ BEGIN/END
 * çiftimizin arasını yönetiyoruz.
 *
 * Aynı mantık iki yerde gerekiyor (bakım kuralı ve Laravel yönlendirmesi);
 * ikinci kopyayı yazmak yerine buraya çıkarıldı.
 */

/**
 * Bloğu ekler ya da GÜNCELLER.
 *
 * `after` verilirse blok, o işaretli bloğun ALTINDA kalmak zorunda. Zaten
 * varsa ama yanlış taraftaysa taşınıyor.
 *
 * @returns {string|null} yeni içerik, ya da değişiklik gerekmiyorsa null
 */
export function mergeMarked(current, { begin, end, block, after = null }) {
  const text = String(current ?? '');
  const start = text.indexOf(begin);

  /*
   * ⚠ SIRA, İÇERİK KADAR ÖNEMLİ — CANLIDA ÖĞRENİLDİ.
   *
   * Aynı `.htaccess` içinde iki bloğumuz var: bakım kuralı ve Laravel
   * yönlendirmesi. Laravel bloğu şununla bitiyor:
   *
   *     RewriteRule ^(.*)$ public/$1 [L]
   *
   * `.htaccess` bağlamında yeniden yazma sonrası istek BAŞTAN işleniyor;
   * ikinci turda `^public/` kuralı `[L]` ile duruyor. Yani Laravel bloğu
   * ÜSTTEYSE, altındaki bakım kuralına HİÇ SIRA GELMİYOR.
   *
   * Sonuç: güncelleme sırasında vendor silinmişken kullanıcı bakım sayfası
   * yerine 500 görüyordu. Blok içerikleri doğruydu; yanlış olan sıraydı.
   *
   * Eski davranış bunu garanti ediyordu: blok yoksa EN ÜSTE ekleniyordu, ve
   * Laravel bloğu bakım bloğundan sonra kurulduğu için hep onun üstüne
   * biniyordu.
   */
  const anchor = after ? afterEnd(text, after) : -1;

  if (start === -1) {
    // Hiç yoksa: çıpa varsa onun ALTINA, yoksa EN ÜSTE. Bizim kurallarımız
    // Passenger devralmadan önce çalışmak zorunda.
    if (anchor === -1) return `${block}\n\n${text}`;
    return `${text.slice(0, anchor)}\n\n${block}${text.slice(anchor)}`;
  }

  const stop = text.indexOf(end, start);
  /*
   * Yarım blok: BEGIN var, END yok.
   *
   * Bu, yarıda kalmış bir yazma ya da elle yapılmış bir düzenleme demek.
   * Nerede bittiğini bilmediğimiz bir bölgeyi "onarmaya" kalkmak, aradaki
   * kullanıcı kurallarını silmek olurdu. Dokunmuyoruz.
   */
  if (stop === -1) return null;

  /*
   * Zaten var ama ÇIPANIN ÜSTÜNDE: söküp doğru yere koyuyoruz.
   *
   * Bu yol, aracın önceki sürümleriyle kurulmuş her `.htaccess`'i ilk
   * güncellemede kendiliğinden onarıyor — kullanıcının dosyayı elle
   * düzeltmesi gerekmiyor.
   */
  if (anchor !== -1 && start < anchor) {
    const without = `${text.slice(0, start)}${text.slice(stop + end.length)}`.replace(/^\n+/, '');
    const moved = afterEnd(without, after);
    if (moved === -1) return `${block}\n\n${without}`;
    return `${without.slice(0, moved)}\n\n${block}${without.slice(moved)}`;
  }

  const old = text.slice(start, stop + end.length);
  if (old === block) return null;
  return text.slice(0, start) + block + text.slice(stop + end.length);
}

/** `after` bloğunun bittiği konum (END'in hemen sonrası), yoksa -1. */
function afterEnd(text, { begin, end }) {
  const start = text.indexOf(begin);
  if (start === -1) return -1;
  const stop = text.indexOf(end, start);
  if (stop === -1) return -1;
  return stop + end.length;
}

/** Bloğu söker. Yoksa null döner (yazmaya gerek yok). */
export function removeMarked(current, { begin, end }) {
  const text = String(current ?? '');
  const start = text.indexOf(begin);
  if (start === -1) return null;
  const stop = text.indexOf(end, start);
  if (stop === -1) return null;
  return `${text.slice(0, start)}${text.slice(stop + end.length)}`.replace(/^\n+/, '');
}
