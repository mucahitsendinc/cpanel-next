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
 * @returns {string|null} yeni içerik, ya da değişiklik gerekmiyorsa null
 */
export function mergeMarked(current, { begin, end, block }) {
  const text = String(current ?? '');
  const start = text.indexOf(begin);

  // Hiç yoksa EN ÜSTE ekleniyor: bizim kurallarımız (503, Laravel
  // yönlendirmesi) Passenger devralmadan önce çalışmak zorunda.
  if (start === -1) return `${block}\n\n${text}`;

  const stop = text.indexOf(end, start);
  /*
   * Yarım blok: BEGIN var, END yok.
   *
   * Bu, yarıda kalmış bir yazma ya da elle yapılmış bir düzenleme demek.
   * Nerede bittiğini bilmediğimiz bir bölgeyi "onarmaya" kalkmak, aradaki
   * kullanıcı kurallarını silmek olurdu. Dokunmuyoruz.
   */
  if (stop === -1) return null;

  const old = text.slice(start, stop + end.length);
  if (old === block) return null;
  return text.slice(0, start) + block + text.slice(stop + end.length);
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
