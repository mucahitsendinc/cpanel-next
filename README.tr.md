# cpanel-next

Next.js projelerini cPanel paylaşımlı hostinge terminalden — ya da yerel bir web
arayüzünden — yayınlar.

```bash
npm i -g cpanel-next

cd ~/projeler/magaza
deploymanager
```

**Gereken tek şey cPanel giriş bilgileriniz.** WHM, root veya SSH gerekmiyor.

*[English README](./README.md)*

---

## Ne yapıyor

Bir projenin içinde çalıştırıyorsunuz. Framework'ü tanıyor, hesabınızdaki
domainleri listeliyor, Node.js uygulaması yoksa oluşturuyor, derlenmiş paketi
yüklüyor, bağımlılıkları kuruyor ve uygulamayı başlatıyor. Sonraki yayınlar tek
komut:

```bash
deploymanager update
```

Uygulama yeniden başlarken ziyaretçi sunucu hatası değil bir bakım sayfası
görüyor — ve site geri geldiği an sayfa kendini yeniliyor.

---

## Bu iş göründüğünden neden zor

cPanel'de bazı işlerin API'si var, bazılarının hiç yok — ve boşluklar tam da
yayınlamanın geçtiği yerde. Araç üç katman kullanıyor ve gerektiğinde
kendiliğinden bir alt katmana düşüyor:

| Katman | Ne | Ne zaman |
|---|---|---|
| **Token API** | cPanel API token → `:2083/execute/` UAPI | Varsayılan. Hızlı, kırılgan değil. |
| **Oturum HTTP** | Giriş yapıp `cpsess` jetonuyla düz HTTP | API2 uçları, CloudLinux |
| **Tarayıcı** | Headless Chromium | Yalnızca giriş yapılamadığında |

Tarayıcı **yalnızca oturum açmak için** kullanılıyor; sonrası düz HTTP, yani
cPanel teması değişince araç kırılmıyor. Kullanıcıların çoğu Chromium'u hiç
indirmiyor.

### İki Node.js rejimi — varsayılmıyor, tespit ediliyor

- **cPanel Application Manager** (`PassengerApps` UAPI, cPanel 66+) — saf API
- **CloudLinux Node.js Selector** — hiçbir API'si yok, komutlar cPanel'in kendi
  cron'undan geçiyor

`deploymanager doctor` hangisinde olduğunuzu ve nelerin çalıştığını gösteriyor.

### İş kuyruğu — çünkü cron yavaş

Her komut için tek seferlik cron eklemek, hiçbir şey olmadan önce 0-60 saniye
beklemek demekti; tekrar eden deploy'un en uzun tek adımı buydu. Bunun yerine
uzun ömürlü bir dinleyici bir iş klasörünü izliyor ve işi ~2 saniyede alıyor.
Kalıcı tek satırlık cron yalnızca dinleyicinin ayakta olduğunu denetleyip
gerekirse yeniden başlatıyor.

Canlı bir CloudLinux hesabında ölçüldü: **iş başına 4-6 sn, öncesinde 0-60 sn.**
Tam bir `update` ~96 saniyeden ~51 saniyeye indi.

---

## İlk çalıştırma

```bash
deploymanager login
```

1. Sunucu, kullanıcı adı ve cPanel şifreniz
2. Araç giriş yapıp **kendine bir API token üretiyor**
3. Bir **ana şifre** belirliyorsunuz
4. Token onunla şifrelenip (scrypt + AES-256-GCM) `0600` izniyle saklanıyor
5. **cPanel şifreniz hiçbir yere yazılmıyor**

Sonrasında tarayıcı hiç açılmıyor; yalnızca ana şifre soruluyor.

> cPanel API token'ları kapsamlandırılamıyor — fonksiyonun adı birebir
> `create_full_access`. Token, hesabınızın erişebildiği her şeye erişiyor. Bu bir
> cPanel kısıtı, aracın tercihi değil. İstediğiniz an cPanel → Security → Manage
> API Tokens'tan iptal edebilirsiniz.

**Ana şifreyi unutursanız kayıtlı bilgiler açılamaz.** Bu kasıtlı; saklanan bir
şifre koruma sağlamaz. Karmaşıklık şartı yok — `123` de olur, tehdit modeli sizin.

---

## Komutlar

```
deploymanager              bu dizindeki projeyi yayınla
deploymanager update       bağlı projeyi yeniden yayınla, soru sormaz
deploymanager login        bağlan ve token üret
deploymanager logout       kayıtlı profili sil
deploymanager status       domainler ve uygulamalar
deploymanager apps         Node.js uygulamalarını listele
deploymanager rollback     önceki sürüme dön
deploymanager logs         son çalıştırmanın sunucu çıktısı
deploymanager doctor       bağlantı ve ortam denetimi
deploymanager ui           yerel web arayüzünü aç
deploymanager config       varsayılan arayüz ve dil
deploymanager maintenance  bakım sayfasını aç/kapat
```

Sık kullanılan bayraklar: `--dry-run`, `--domain`, `--app-root`, `--no-build`,
`--clean-modules`, `--confirm <ad>`, `--web` / `--terminal`, `--lang tr|en`,
`-y`, `-v`.

---

## Web arayüzü

```bash
deploymanager ui
```

Hesapları, domainleri ve uygulamaları tıklayarak yönetiyorsunuz: canlı loglu
deploy, geri alma, başlat/durdur/yeniden başlat, silme, kayıtlar, hesap
ekleme/çıkarma.

Varsayılanı web yaptıysanız, bir projede `deploymanager` yazınca tarayıcı o proje
seçili açılıyor ve **terminal bekliyor**. Tarayıcıyı kapatınca terminale
dönülüyor.

Kapanma tespiti `beforeunload`/`sendBeacon` ile değil kalp atışıyla yapılıyor:
beacon, sekme çökerse, ağ koparsa veya tarayıcı onu düşürürse hiç gelmiyor;
atışın yokluğu ise her durumda doğru sinyal. **Süren bir deploy her zaman çıkış
sinyalinden üstün.**

Güvenlik o sunucuda sonradan eklenen bir katman değil, ilk yazılan şey:

- Yalnızca `127.0.0.1`'e bağlı
- `Host` başlığı doğrulanıyor — **DNS rebinding** localhost sunucularına karşı
  gerçek bir saldırı ve beklenmedik `Host` gelen istek hiç işlenmiyor
- Her API çağrısı özel bir başlık istiyor; bu, çapraz kökenli form/img/script
  isteklerini yapısal olarak eliyor (CSRF)
- **cPanel token'ınız tarayıcıya hiç gönderilmiyor**, sunucu bellekte tutuyor
- Kasa 15 dakika işlem olmazsa kendini kilitliyor
- Yıkıcı adımlarda klasör adını yazmak zorunlu ve bu **sunucuda** denetleniyor —
  ucu doğrudan çağırmak da işe yaramıyor

---

## Yaşam döngüsü hook'ları

`.cpanel-next.json` içinde tanımlıyorsunuz; bağımlılık kurulumunun çevresinde
sunucuda çalışıyorlar:

```json
{
  "hooks": {
    "preInstall":  ["cp .env.production .env"],
    "postInstall": ["npx prisma migrate deploy"],
    "postStart":   ["curl -s https://ornek.com/api/warmup"]
  }
}
```

Uygulamanın Node venv'i `PATH`'in başındayken çalışıyorlar, yani `npx` ve `node`
doğru sürüme çözülüyor.

> Hook'lar kabuk gerektiriyor, dolayısıyla CloudLinux'ta çalışıyor. Stok
> cPanel'de kabuk yolu olmadığı için atlanıyorlar.

---

## Güvenlik

Bu araç bir klasörü boşaltıp içine paket açıyor. Yanlış klasör seçilirse yayında
olan bir site gider. Buna karşı:

1. **Yazarak onay** — yıkıcı adımlarda `y/N` değil, klasör adını elle yazmanız
   isteniyor. Sunucuda da zorunlu.
2. **Korumalı adlar** — `public_html`, `mail`, `etc`, `logs`, `nodevenv`, nokta
   ile başlayan her dizin, ve domainlerinizden birinin belge kökü olan her yol
   (aksi hâlde kaynak kodunuz ve `.env` internete açık olurdu).
3. **Yol kaçışı temizlenmiyor, reddediliyor** — `../../etc`'den karakter ayıklamak
   onu düzeltmez, başka bir hataya çevirir.
4. **Her üzerine yazmadan önce yedek.** Yedek alınamazsa deploy duruyor.
5. **Sahiplik kaydı** — her deploy hangi projeden ve makineden geldiğini yazıyor.
   Üzerine yazmadan önce gösteriliyor, *başka* bir domaine bağlı klasör kırmızıyla
   uyarılıyor.
6. **Ortam dosyaları pakete hiç girmiyor** — `.env`, `.env.local`, `.env.bak-…`,
   dotenv ailesinin tamamı; desen eşleştirmeyle değil izin listesiyle.

---

## Gereksinimler ve sınırlar

- Yerelde Node.js 18.17+
- Next.js App Router veya Pages Router
- Build **daima yerelde** koşuyor. CloudLinux süreç belleğini varsayılan 1 GB'a
  sınırlıyor ve CloudLinux'un kendi dokümanı `npm build`in orada OOM verdiğini
  yazıyor.

Henüz desteklenmiyor:

- `output: 'standalone'` — Next'in kendi dokümanı özel server ile birlikte
  kullanılamayacağını yazıyor, Passenger ise özel server gerektiriyor
- **Next.js 13.4.x reddediliyor** — router-server ikinci bir `http.Server` açıyor
  ve Passenger `http.Server.listen() was called more than once` ile patlıyor
  (13.5.6+ temiz)
- Alt yol mount (`basePath` build zamanında gömülüyor)
- Laravel

### Passenger hakkında bilinmesi gerekenler

- Passenger `PORT` **vermiyor**. `listen()`'i yamalayıp uygulamayı kendi Unix
  soketine bağlıyor, yani port değeri önemsiz — ama `listen()` **tam olarak bir
  kez** çağrılmalı.
- Passenger **ESM yükleyemiyor**. `package.json`'da `"type": "module"` varsa
  başlangıç dosyası `server.cjs` olarak oluşturuluyor.
- Yeniden başlatma `tmp/restart.txt` üzerinden ve yalnızca bir istek geldiğinde
  denetleniyor — araç bu yüzden sonrasında bir istek atıyor.

---

## Durum

Canlı bir CloudLinux/cPanel hesabında uçtan uca doğrulandı: giriş ve token
üretimi, domain çözümleme, paketleme, yükleme, deploy, geri alma, bakım sayfası,
iş kuyruğu, hook'lar, web arayüzü ve güvenlik katmanları.

Stok cPanel yolu (`PassengerApps`) artık canlı bir cPanel 11.136 hesabında
çalıştırıldı: `register_application`, `list_applications`, `edit_application`,
`ensure_deps`, `enable_application`, `disable_application` ve
`unregister_application` çalışıyor; stok cPanel'deki her deploy'u bozacak iki
kusur bulunup düzeltildi.

**Doğrulanmayan tek şey servis etme.** Test hesabı LiteSpeed'li CloudLinux ve
orada Node.js'i CloudLinux Selector yönetiyor; stok Application Manager kaydı
API tarafından kabul ediliyor ama gerçekte servis edilmiyor. Bu yolun siteyi
gerçekten yayınladığını doğrulamak için gerçekten stok bir cPanel kutusu lazım.

cPanel'in kendi dokümanının yanlış olduğu iki yer, ikisi de canlı sunucuda
bulundu:

- `ensure_deps` **ev dizinine göreli** `app_path` istiyor. Dokümandaki örnek
  (`/home/example/my-app/`) `Invalid path` ile reddediliyor.
- `SubDomain::delsubdomain` **yalnızca API2'de** var. UAPI'de hiçbir adla
  karşılığı yok.

---

## Yazar

**Mücahit Sendinç** — [muco.tr](https://muco.tr)

## Lisans

MIT © Mücahit Sendinç
