# cpanel-next

Next.js ve Laravel projelerini cPanel paylaşımlı hostinge terminalden — ya da
yerel bir web arayüzünden — yayınlar.

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
5. **cPanel şifreniz hiçbir yere yazılmıyor** — o hesap için otomatik girişi
   açmadıysanız (aşağıda); açtıysanız yalnızca kasada şifreli olarak duruyor

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
deploymanager db           MySQL veritabanları (list, create, drop, users, pma)
```

Sık kullanılan bayraklar: `--dry-run`, `--domain`, `--app-root`, `--no-build`,
`--clean-modules`, `--confirm <ad>`, `--web` / `--terminal`, `--lang tr|en`,
`--env-local`, `-y`, `-v`.

---

## Web arayüzü

```bash
deploymanager ui
```

Hesapları, domainleri ve uygulamaları tıklayarak yönetiyorsunuz: canlı loglu
deploy, geri alma, başlat/durdur/yeniden başlat, silme, kayıtlar, hesap
ekleme/çıkarma.

Arayüz, cPanel ya da Node bilgisi olmadan ilk bakışta anlaşılacak şekilde
kurgulandı:

- İlk açılışta bir **karşılama ekranı** aracın ne yaptığını üç adımda anlatıyor
  ve tek bir hesap istiyor. (Eskiden yeni kullanıcı doğrudan kasa ekranına
  düşüyor, şifresini yazıyor ve `no profiles` hatası alıyordu: arkasında hiçbir
  şey olmayan, geçilemeyen bir kapı.)
- Yayınlama **üç adımlı** bir akış — proje → hedef → kontrol — ve üstte bir
  adım şeridi var; nerede olduğunuzu ve ne kaldığını görüyorsunuz.
- Her alanın altında tek satır açıklama, her boş listede "şimdi ne yapmalıyım"
  kartı var; kontrol adımı neyin silineceğini *ve neyin korunacağını* yazıyor.
- Uygulamalar tablo satırı değil kart: durum, adres, klasör ve bütün işlemler
  tek yerde.
- **phpMyAdmin**, **Dosya Yöneticisi** ve **cPanel** tek tıkla açılıyor; hesap
  için ya da doğrudan bir uygulamanın klasörü için.
- Hesaplar **düzenlenebiliyor**: sunucu, port, kullanıcı adı ve token yenileme.
  Yanında bir **"Bağlantıyı test et"** düğmesi var — "token'ım hâlâ geçerli mi"
  sorusunun cevabı deploy'un ortasında değil burada veriliyor.

### Otomatik giriş

Yukarıdaki bağlantılar sizin adınıza cPanel'e **giriş yapıp** doğrudan hedefe
götürüyor. Bunun için cPanel şifrenizin saklanması gerekiyor; hesap eklerken
varsayılan açık, tek tıkla kapanıyor.

Neden şifre gerekiyor: cPanel'in web arayüzü API token'ıyla değil `cpsession`
çereziyle çalışıyor ve o çerez kullanıcının tarayıcısında olmak zorunda.
cPanel'in kendi spesifikasyonu `Session::create_temp_user` için birebir şunu
yazıyor: *"geçerli bir cPanel oturum kimliği gerektirir… aksi hâlde WHM API 1
`create_user_session` kullanmalısınız"*. WHM bu aracın kapsamı dışında, yani
token'dan tarayıcı oturumu üretmenin bir yolu yok.

Saklandığında şifre, token ile **aynı kasada**: ana şifrenizden scrypt ile
türetilen anahtarla AES-256-GCM, `0600` izinli dosya. Giriş anında yerel
sunucudan `no-store` başlıklı tek kullanımlık bir sayfa üretiliyor; sayfanın
`form-action` politikası **yalnızca** o cPanel adresine izin veriyor ve form
gönderildikten sonra DOM'dan siliniyor. Şifre yalnızca tarayıcınızdan cPanel'e
gidiyor; API token'ı bu sayfaya hiç girmiyor.

Kapalıyken bağlantılar cPanel'in giriş sayfasına `goto_uri` ile gidiyor:
şifrenizi cPanel'e siz giriyorsunuz, yine doğru ekrana düşüyorsunuz.

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

## E-posta, FTP ve yedekler

Yayınlamak tek başına yetmiyor: bir site canlıya çıktığında posta kutusu,
dosya erişimi ve yedek de gerekiyor. Bunların hepsi cPanel'de ayrı ekranlar;
burada aynı arayüzde.

### E-posta

Posta kutusu açma, silme, şifre yenileme ve kota. **Bağlantı ayarları
sunucudan okunuyor**, tahmin edilmiyor — hostlar sunucu adını ve portları
değiştirebiliyor ve yanlış bir `mail.domain.com:465` insanı saatlerce
uğraştırıyor. Ekranda hem güvenli (SSL/TLS) hem şifresiz değerler, IMAP, POP3
ve SMTP portlarıyla birlikte duruyor.

Posta kutusu silmek adresi birebir yazmayı gerektiriyor: içindeki bütün
postalar da gidiyor.

### FTP

Hesap açma, listeleme, şifre yenileme, silme. Giriş adı `kullanıcı@sunucu`
biçiminde hazır veriliyor.

İki not:

- **Noktalar korunuyor.** cPanel'in `disallowdot` varsayılanı `1` ve
  `deploy.bot` sessizce `deploybot` oluyor; kullanıcı sonra bağlanamıyor ve
  sebebini göremiyor. Açıkça `0` gönderiyoruz.
- **Silmek dosyaları silmiyor.** cPanel'in `destroy` parametresi hesabın ev
  dizinini de siliyor ve varsayılan ev dizini uygulamanın kendisi olabiliyor —
  yani bir FTP hesabını kaldırmak siteyi götürebilir. O parametre hiç
  gönderilmiyor.

### Yedek al ve indir

Her veritabanının yanında bir düğme: sunucuda dışa aktarılıp bilgisayarınıza
iniyor. Uygulama kartlarında da aynısı var, dosyalar için.

```
~/Downloads/cpanel-next/shop-20260806143000.sql.gz
```

İndiği anda **"Klasörde göster"** düğmesi çıkıyor — dosyayı açmıyor, Finder'da
seçili gösteriyor.

Nasıl çalıştığı, çünkü göründüğü kadar basit değil:

- cPanel'in UAPI'sinde **indirme ucu yok**. `Fileman::get_file_content` var ama
  aralık desteklemiyor ve JSON döndürdüğü için ikili dosyada bozuluyor; klasik
  `/download?file=…` adresi ise oturum çerezi istiyor, token kabul etmiyor.
  Bu yüzden dosya sunucuda base64'e çevrilip parçalara bölünüyor, parçalar tek
  tek okunup yerelde birleştiriliyor — yüklemenin aynadaki hâli. Sonunda boyut
  karşılaştırılıyor: eksik inen bir dosya sessizce kabul edilmiyor.
- Veritabanı için `mysqldump` gerekiyor ama **var olan kullanıcıların şifresi
  bizde yok**. Kısa ömürlü bir MySQL kullanıcısı açılıp iş biter bitmez
  siliniyor — hata hâlinde de. Şifre komut satırına **yazılmıyor**:
  `mysqldump -pSIFRE` paylaşımlı bir sunucuda `ps` çıktısında herkese görünür.
  Onun yerine 0600 izinli geçici bir `--defaults-extra-file` kullanılıyor.
- 200 MB üstü dosyalarda araç duruyor ve cPanel'in kendi indirme ekranına
  yönlendiriyor: bu yol her parça için bir HTTP turu demek ve o boyutta
  dakikalar sürer. Sessizce denemek yerine söylemek doğru olan.

### cPanel şifresini değiştirme

Ayarlar'da. cPanel **eski şifreyi istiyor** ve bu iyi: kasası açık bir
arayüzün, kullanıcının onayı olmadan cPanel şifresini değiştirebilmesi doğru
olmazdı. Otomatik giriş açıksa kasadaki kopya da güncelleniyor.

> `enablemysql` bayrağı **gönderilmiyor**. cPanel bu bayrakla MySQL
> kullanıcılarının şifresini de eşitliyor — yani `.env` dosyalarındaki
> `DB_PASSWORD` bir anda geçersiz oluyor ve yayındaki her uygulama
> veritabanına bağlanamıyor. Sessizce yapılacak bir şey değil.

### Ana şifre

Ayarlar → Genel'den değiştirilebiliyor. Kasadaki her sır (token'lar ve —
otomatik giriş açıksa — cPanel şifreleri) yeni anahtarla yeniden mühürleniyor.

Dosya **tek seferde** yazılıyor: ortada bir hata olsaydı yarısı eski yarısı
yeni anahtarla şifrelenmiş bir kasa kalırdı ve o kasa bir daha hiç açılamazdı.
Eski şifre yanlışsa hiçbir şeye dokunulmuyor.

### Ayarlar nerede

İki farklı kapsam, iki farklı yer:

| | nerede |
|---|---|
| Dil, varsayılan arayüz, **ana şifre** | Ayarlar sekmesi |
| Bağlantı, token yenileme, **cPanel şifresi**, otomatik giriş, hesabı kaldırma | Başlıktaki hesap seçicinin yanındaki ⚙ |
| Yeni cPanel hesabı | Başlıktaki **+** |

---

## Masaüstü uygulaması

```bash
cd desktop
npm install
npm start          # geliştirme
npm run build:mac  # .dmg üretir (win / linux de var)
```

Çift tıkla açılan, Uygulamalar klasöründe duran bir sürüm. Terminal
gerekmiyor.

**Kendi iş mantığı yok ve olmamalı.** `deploymanager ui` zaten 127.0.0.1'de
bir sunucu açıp tarayıcıyı ona yönlendiriyordu; masaüstü sürümü aynı sunucuyu
Electron'un ana sürecinde başlatıp bir pencerede gösteriyor. Arayüz, API'ler ve
güvenlik katmanları birebir aynı — `lib/` tek kaynak olarak kalıyor, çünkü iki
ön yüzün ayrışması birinde düzeltilen davranışın diğerinde kalması demek olurdu.

Kabuğun kendine ait dört kararı var:

- **Sayfa bir web sayfası olarak kalıyor.** `nodeIntegration` kapalı,
  `contextIsolation` ve `sandbox` açık. Arayüzün sunucuyla konuşma yolu zaten
  mevcut HTTP API'si ve o API oturum jetonu istiyor; masaüstü olduk diye o
  katmanı atlamak, tarayıcıda olmayan bir saldırı yüzeyi açardı.
- **Dış bağlantılar sistem tarayıcısında açılıyor** — phpMyAdmin, Dosya
  Yöneticisi, cPanel, yayınlanan sitenin kendisi. Kullanıcının cPanel oturumu
  kendi tarayıcısında yaşıyor; ayrıca uygulamayı bir tarayıcıya dönüştürüp geri
  dönüş yolu bırakmamak gerekiyor.
- **Menü var**, çünkü Electron'da menü yoksa Cmd+C / Cmd+V hiç çalışmıyor.
  Şifre ve bağlantı dizesi kopyalanan bir araçta bu sessiz ama can sıkıcı bir
  kusur olurdu.
- **Pencere kapanınca uygulama da kapanıyor**, macOS'ta bile. Arka planda cPanel
  token'ı tutan bir sunucu var; kullanıcının görmediği bir süreç onu bellekte
  tutmaya devam etmemeli.

> macOS'ta imzalanmamış bir uygulama Gatekeeper'a takılıyor: ilk açılışta sağ
> tık → Aç gerekiyor. Düzgün dağıtım için Apple Developer hesabı ve
> notarization gerekli — kod tarafında hazır, imza sizin hesabınızla yapılıyor.

Masaüstü paketi npm paketine **girmiyor**: `files` alanı yalnızca `bin`, `lib`
ve README'leri topluyor.

---

## Laravel

```bash
cd ~/projeler/magaza
deploymanager            # ilk kurulum
deploymanager update     # sonraki her yayın
```

### Belge kökü değiştirilmiyor

Laravel'in `public/` sorununun "temiz" çözümü `SubDomain::changedocroot` ile
belge kökünü `<klasör>/public` yapmak. Kullanmıyoruz: ana domainde zaten
mümkün değil (WHM ister), addon/subdomain'de de hesabın yapılandırmasını
kalıcı olarak değiştirir.

Bunun yerine Laravel domainin **kendi klasörüne** kuruluyor ve işi `.htaccess`
yapıyor:

```
~/magaza.site.com/          ← belge kökü (dokunulmadı)
  .htaccess                 ← her isteği public/'e alır
  app/ config/ vendor/ .env ← yönlendirme yüzünden URL'den erişilemez
  public/                   ← Laravel'in kendi .htaccess'i devralır
```

Uygulama klasörü bu yüzden **sorulmuyor** — domainin belge kökünün ta kendisi.
Yanlış klasöre kurma ihtimali yapısal olarak yok.

> Bu düzenin bedeli var: kaynak dosyalar fiziksel olarak belge kökünün altında.
> `AllowOverride None` ya da kapalı bir mod_rewrite, `.env` dosyanızı internete
> açar. Bu yüzden yayından sonra araç `https://domain/.env`, `/composer.json` ve
> `/artisan` adreslerini **gerçekten çekip** okunabiliyor mu diye bakıyor ve
> okunabiliyorsa açıkça hata veriyor.

### Kod siliniyor, veri duruyor

İki taraflı bir sorun ve tek kural ikisini birden çözmüyor:

- Yerelde **sildiğiniz** dosya sunucuda kalmamalı. Sadece üzerine yazsak,
  silinmiş bir controller sunucuda yaşamaya devam eder.
- Sunucuda **üretilen** dosya silinmemeli: `public/uploads`, `storage/logs`,
  faturalar, kullanıcı görselleri.

| | davranış |
|---|---|
| `app` `config` `routes` `database` `resources` `bootstrap` `vendor` | **silinip yeniden kuruluyor** |
| `storage` | hiç paketlenmiyor, hiç silinmiyor |
| `public` | paket üstüne açılıyor; **silinmiyor** |
| `.env` `.htaccess` `.well-known` `cgi-bin` `.user.ini` | dokunulmuyor |

`public/` için eskimiş dosya sorunu **manifesto** ile çözülüyor: her deploy'da
gönderdiğimiz public yollarının listesi sahiplik işaretine yazılıyor. Sonraki
deploy'da "geçen sefer bizim gönderdiğimiz ama bu sefer göndermediğimiz"
dosyalar siliniyor. Bizim hiç göndermediğimiz bir dosya listede olmadığı için
**asla** silinemez — bu bir temenni değil, kümelerin yapısı.

### `.env`

Yerel `.env` dosyanız **gönderilmez** ve sunucudaki dosyanın hiçbir satırı
silinmez. Sadece şunlar yazılır:

- `APP_DEBUG` `true` ise `false` yapılır (`--keep-debug` ile kapatılır)
- ilk kurulumda `APP_URL`, seçtiğiniz domainden
- veritabanı seçtiyseniz `DB_*`

Sunucuda hiç `.env` yoksa `.env.example`'dan oluşturulur ve `APP_KEY` üretilir.

### vendor ve node paketleri

`node_modules` **hiç gitmiyor**: Vite/Mix derlemesi yerelde koşuyor, sunucuya
yalnızca `public/build` çıktısı gidiyor.

`vendor` için üç kip var, varsayılan `auto`:

| kip | davranış |
|---|---|
| `auto` | `composer.lock` **değiştiyse** gönder; değişmediyse sunucudaki korunur (~2 MB'lık güncellemeler) |
| `always` | her deploy'da gönder |
| `server` | gönderme, sunucuda `composer install --no-dev -o` çalıştır |

`server` kipi varsayılan değil: composer bellek canavarı ve CloudLinux'un
varsayılan 1 GB LVE sınırında OOM riski gerçek.

### İzinler

Kurulum sırasında sunucuda kabuktan ayarlanıyor:

| | |
|---|---|
| Dizinler | `755` |
| Dosyalar | `644` |
| `storage`, `bootstrap/cache` | `775` |
| `.env` | `600` |

Neden gerekiyor: zip arşivi kendi kip bitlerini taşıyor ve bunlar sizin
makinenizdeki umask'a göre değişiyor. Sunucuda `600` ile açılan bir dosya web
sunucusu tarafından okunamıyor ve site 403 veriyor.

Belge kökünün kendisi de `755` yapılıyor — Apache **suEXEC**, grup ya da
herkese yazılabilir bir belge kökünü servis etmeyi reddediyor ve `775`
bırakmak siteyi 500'e düşürürdü.

`.env`'in `600` olması ikinci savunma: dosya bizim topolojimizde belge kökünün
altında duruyor ve `.htaccess` onu gizliyor, ama tek savunmaya güvenmiyoruz.

### Migration

| | varsayılan |
|---|---|
| ilk kurulum | `migrate:fresh --seed` |
| güncelleme | `migrate --force` |

Kipler: `none`, `migrate`, `migrate-seed`, `fresh-seed`. Bayrakla
(`--migrate none`, `--no-migrate`) ya da `.cpanel-next.json` ile:

```json
{
  "framework": "laravel",
  "laravel": {
    "migrate": "none",
    "firstMigrate": "fresh-seed",
    "vendor": "auto",
    "forceDebugOff": true,
    "optimize": true
  }
}
```

> `migrate:fresh` **bütün tabloları siler**. Onay ekranında kırmızı yazıyor ve
> güncellemede asla varsayılan değil.

Kurulumdan sonra sırayla: yazma izinleri → `storage:link` → migration →
`optimize:clear` → `config:cache` → `route:cache` → `view:cache`.
`route:cache` ve `view:cache` ölümcül değil — closure kullanan rotalarda
`route:cache` hata verir ve bunun yayını engellemesi doğru olmaz.

### Bilinmesi gerekenler

- Belge kökü dolu ise (yayında bir WordPress, düz HTML site) **klasör adını
  yazarak onay** isteniyor ve önce yedek alınıyor.
- `composer.lock` **zorunlu**. Onsuz vendor kararı verilemez ve sürümler
  yereldekinden kayabilir — Next tarafında tam olarak bu kayma, çerçevenin
  içinde patlayan bir hataya yol açmıştı.
- Domainin PHP sürümü cPanel'e soruluyor (`LangPHP`), artisan o sürümle
  koşuyor. Hesabın varsayılan CLI'ı 7.4 olsa bile Laravel 11 doğru PHP'yi
  buluyor.

---

## Veritabanı

Veritabanı olmadan uygulama yayınlamak yarım bir iş. cPanel'de bunu bağlamak
dört ekran sürüyor — *Create Database*, *Create User*, *Add User To Database*,
yetki kutuları — ve sonunda bağlantı dizesini elle kuruyorsunuz.

```bash
deploymanager db create magaza --app-root magazanext --env-local
```

Bu tek komut veritabanını oluşturuyor, kullanıcıyı açıyor, o veritabanında tam
yetki veriyor, şifre üretiyor ve

```
DATABASE_URL=mysql://kullanici:…@127.0.0.1:3306/hesap_magaza
```

satırını hem sunucudaki `.env` dosyasına hem de makinenizdeki `.env.local`
dosyasına yazıyor. Web arayüzü aynısını tek düğmeyle yapıyor; ayrıca hesap için
ve tek bir veritabanı için **phpMyAdmin** bağlantısı veriyor.

```
deploymanager db              veritabanları, boyutları ve kullanıcıları
deploymanager db create <ad>  veritabanı + kullanıcı + yetki + DATABASE_URL
deploymanager db drop <ad>    veritabanını sil (adını yazarak onay)
deploymanager db users        MySQL kullanıcıları ve eriştikleri veritabanları
deploymanager db pma [ad]     phpMyAdmin'i aç
```

Bilinmesi gerekenler:

- **Önek varsayılmıyor, soruluyor.** Çoğu host her veritabanı ve kullanıcı adının
  başına `<hesap>_` koyuyor, ama host öneklemeyi kapatabiliyor; o durumda cPanel
  `prefix: null` döndürüyor. Bunu "cevap gelmedi" sanıp yine de `<hesap>_`
  eklemek, kullanıcının cPanel'de bulamayacağı adlar üretmek demek.
  Yetkili kaynak `Mysql::get_restrictions`.
- **Şifre bir kez gösteriliyor.** Hiçbir yerde saklanmıyor — ne cPanel'de ne
  bizde. Aynı ekranın `.env` dosyasına yazmayı önermesinin sebebi bu.
- **Var olana dokunulmuyor.** Veritabanı zaten varsa içine karışılmıyor (veri
  olabilir); kullanıcı zaten varsa şifresi *değiştirilmiyor*, çünkü onu başka
  bir uygulama kullanıyor olabilir.
- **Silmek adı yazmayı gerektiriyor.** Veritabanının yedeği ve geri alması yok,
  yani kural klasörlerdekinden daha sıkı ve sunucuda denetleniyor.
- **phpMyAdmin şifrenizi bu araçtan geçirmiyor.** API token'ından tarayıcıya
  taşınabilir bir cPanel oturumu üretilemiyor; bu yüzden düğme cPanel'in kendi
  giriş sayfasına `goto_uri` ile gidiyor. Zaten girişliyseniz doğrudan
  phpMyAdmin açılıyor.

`.env`, `.env.local`, `.env.production` ve `.env.production.local` artık
deploy'lar arasında korunuyor. Bunlar pakete hiç girmiyor, yani oraya yazılan
her şey aksi hâlde bir sonraki yayında silinirdi.

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
doğru sürüme çözülüyor — **üç aşamada da**. Komut dizi yerine düz metin olarak da
yazılabiliyor; bunun dışındaki bir değer karakter karakter döndürülmek yerine
raporlanıp yok sayılıyor.

> Hook'lar kabuk gerektiriyor, dolayısıyla CloudLinux'ta çalışıyor. Stok
> cPanel'de kabuk yolu olmadığı için atlanıyorlar — ve deploy kaydı bunu
> çalışmayan komut sayısıyla birlikte yazıyor.

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
- Next.js App Router veya Pages Router · Laravel 9+ (`artisan` + `composer.lock`)
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

### Build ile çalıştırma aynı sürümde olmalı

Yüklenen pakete giden `package.json`, bağımlılık aralıkları
`package-lock.json`'daki kesin sürümlerle değiştirilmiş hâlde gidiyor. Sizin
dosyanıza dokunulmuyor — yalnızca gönderilen kopya değişiyor.

Bu bir incelik değil. `"next": "^16.1.1"` demek, build'in yerelde 16.1.1 ile
koşup `.next`'i o sürüme göre üretmesi; sunucudaki `npm install` ise 16.3.0
çekiyor. O build'i farklı bir minor sürümle çalıştırınca uygulama **çerçevenin
içinde** `Cannot read properties of undefined` ile çöküyor ve yığın izi yalnızca
`at ignore-listed frames` diyor — kendi kodunuzda hiçbir ipucu yok. Canlı bir
hesapta ölçüldü: build next 16.1.1 / react 19.2.3, sunucuda kurulan 16.3.0 /
19.2.8.

`package-lock.json`'ı yüklemek yetmiyor; CloudLinux'un `install-modules` komutu
ona uymuyor. `output: 'standalone'`'ın böyle bir projeyi "düzeltiyor"
görünmesinin sebebi de bu — build anındaki `node_modules`'ü pakete gömdüğü için
sunucuda kurulum hiç koşmuyor, dolayısıyla kayma da olmuyor.

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
