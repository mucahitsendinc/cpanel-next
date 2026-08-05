# cpanel-next

Next.js projelerini cPanel paylaşımlı hostinge terminalden yayınlar.

```bash
npm i -g cpanel-next

cd ~/projeler/magaza
deploymanager
```

Araç projeyi tarar, cPanel hesabınızdaki domainleri listeler, Node.js
uygulamasını oluşturur (yoksa), paketi yükler, bağımlılıkları kurar ve
uygulamayı başlatır.

**Gereken tek şey cPanel giriş bilgileriniz.** WHM, root veya SSH gerekmiyor.

---

## Nasıl çalışıyor

cPanel'de bazı işlerin API'si var, bazılarının hiç yok. Araç üç katman kullanır
ve gerektiğinde kendiliğinden bir alt katmana düşer:

| Katman | Ne | Ne zaman |
|---|---|---|
| **Token API** | cPanel API token → `:2083/execute/` UAPI | Varsayılan. Hızlı, kırılgan değil. |
| **Oturum HTTP** | cPanel'e giriş yapıp `cpsess` jetonuyla düz HTTP | Token'ın yetmediği yer: API2, CloudLinux uçları |
| **Tarayıcı** | Headless Chromium | Yalnızca giriş yapılamadığında |

Tarayıcı **yalnızca oturum açmak için** kullanılır; sonrası düz HTTP'dir. Bu
yüzden cPanel teması değiştiğinde araç kırılmaz.

### İlk çalıştırma

```bash
deploymanager login
```

1. Sunucu adı, kullanıcı adı ve cPanel şifreniz sorulur
2. Araç cPanel'e giriş yapar
3. **Kendine bir API token üretir** (`Tokens::create_full_access`)
4. Bir **ana şifre** belirlemeniz istenir
5. Token bu ana şifreyle şifrelenip `~/.cpanel-next/config.json` dosyasına
   0600 izniyle yazılır
6. **cPanel şifreniz hiçbir yere yazılmaz**

Sonraki çalıştırmalarda tarayıcı hiç açılmaz; yalnızca ana şifreniz sorulur.

Token'ı istediğiniz an cPanel → **Security → Manage API Tokens** sayfasından
iptal edebilirsiniz.

> cPanel API token'ları kapsamlandırılamaz — fonksiyonun adı birebir
> `create_full_access`. Token, hesabınızın erişebildiği her şeye erişir.
> Bu bir cPanel kısıtı, aracın tercihi değil.

### Ana şifre

Cihazda saklanan token, ana şifrenizden türetilen bir anahtarla şifrelenir
(scrypt + AES-256-GCM). Ana şifre **hiçbir yerde saklanmaz**.

- **Unutursanız kayıtlı bilgiler açılamaz.** Bu kasıtlı — saklanan bir şifre
  koruma sağlamaz. `deploymanager logout` ile profili silip yeniden
  bağlanabilirsiniz.
- **Karmaşıklık şartı yoktur.** `123` de diyebilirsiniz; tehdit modeli sizin
  kararınız.
- Tek ana şifre bütün profilleri açar; sunucu başına ayrı şifre gerekmez.
- Otomasyon için `CPANEL_NEXT_MASTER_PASSWORD` ortam değişkeni kullanılabilir.

---

## Desteklenen sunucular

Araç iki farklı Node.js rejimini de tanır ve hangisinde olduğunuzu kendisi
tespit eder:

- **cPanel Application Manager** (`PassengerApps` UAPI, cPanel 66+) — saf API,
  shell gerekmez
- **CloudLinux Node.js Selector** — API'si olmadığı için komutlar cPanel'in
  kendi cron'u üzerinden çalıştırılır (SSH gerekmez)

`deploymanager doctor` hangisinde olduğunuzu ve nelerin çalıştığını gösterir.

---

## Komutlar

```
deploymanager              bulunduğun dizindeki projeyi yayınla (etkileşimli)
deploymanager deploy       aynısı, bayraklarla
deploymanager login        bağlan ve token üret
deploymanager logout       kayıtlı profili sil
deploymanager status       domainleri ve uygulamaları göster
deploymanager apps         hesaptaki Node.js uygulamalarını listele
deploymanager rollback     önceki sürüme dön
deploymanager logs         son çalıştırmanın sunucu çıktısı
deploymanager doctor       bağlantı ve ortam denetimi
deploymanager ui           yerel web arayüzünü aç
```

### Web arayüzü

```bash
deploymanager ui
```

Tarayıcıda açılır; hesaplarınızı, domainleri ve uygulamaları tıklayarak
yönetirsiniz: deploy (canlı log akışıyla), geri alma, başlat/durdur/yeniden
başlat, kayıtlar.

Arayüz güvenliği, sonradan eklenmiş bir katman değil:

- Sunucu **yalnızca `127.0.0.1`**'e bağlanır; ağdaki başka bir makine erişemez.
- `Host` başlığı doğrulanır. **DNS rebinding** gerçek bir saldırıdır: kötü
  niyetli bir site kendi alan adını `127.0.0.1`'e çözdürüp tarayıcınıza bu
  sunucuya istek attırabilir. Beklenmedik `Host` gelirse istek hiç işlenmez.
- Her API çağrısı özel bir başlık ister; bu, çapraz kökenli form/img/script
  isteklerini yapısal olarak eler (CSRF).
- **cPanel token'ınız tarayıcıya hiç gönderilmez.** Sunucu bellekte tutar.
- Kasa 15 dakika işlem olmazsa kendini kilitler.
- Yıkıcı deploy'da klasör adını **yazarak onay** şartı sunucu tarafında
  zorunludur — arayüzü atlayıp API'yi doğrudan çağırsanız da geçilemez.
- Uygulama **silme** özelliği bilerek yoktur.

Deploy işleri sunucuda yaşar: sekmeyi kapatsanız da devam ederler.

Sık kullanılan bayraklar:

```
--dry-run          hiçbir şey yazma, ne yapılacağını göster
--domain <d>       domaini sormadan belirle
--app-root <ad>    sunucudaki uygulama klasörü
--no-build         mevcut .next çıktısını gönder
--confirm <ad>     yıkıcı işlemi onayla (app-root adını birebir ver)
-y, --yes          onayları geç
-v, --verbose      ayrıntılı çıktı
```

Ortam değişkenleri: `CPANEL_NEXT_MASTER_PASSWORD`, `CPANEL_NEXT_PASSWORD`,
`CPANEL_NEXT_TOKEN`, `CPANEL_NEXT_HOST`, `CPANEL_NEXT_USER`,
`CPANEL_NEXT_LANG`.

### Dil

Arayüz Türkçe ve İngilizce. Dil sırayla şuradan seçilir: `--lang tr|en` →
`CPANEL_NEXT_LANG` → sistem yereli (`LC_ALL`/`LANG`) → İngilizce.

```bash
deploymanager --lang en
CPANEL_NEXT_LANG=tr deploymanager
```

`--verbose` izleri kasten çevrilmez; hata ayıklama çıktısının hata
raporlarında ve arama sonuçlarında eşleşebilmesi için tek dilde kalması
gerekir.

---

## Güvenlik

Bu araç hedef klasörün içeriğini silip yerine paketi açar. Yanlış klasör
seçilirse yayında olan bir site gider. Buna karşı:

1. **Sahiplik işareti** — araç oluşturduğu her klasöre
   `.cpanel-next-owner.json` koyar. Var olan bir klasörün üzerine yazmak için
   bu işaret **zorunludur**. Elle kurduğunuz ya da başka bir araca ait bir
   klasör asla silinmez.
2. **Korumalı adlar** — `public_html`, `mail`, `etc`, `logs`, `nodevenv` … ve
   nokta ile başlayan her dizin reddedilir.
3. **Belge kökü çakışması** — hesabınızdaki herhangi bir domainin belge köküne
   eşit bir uygulama klasörü reddedilir. Aksi hâlde kaynak kodunuz ve `.env`
   dosyanız internete açık olurdu.
4. **Yazarak onay** — yıkıcı işlemlerde `y/N` değil, klasör adını elle
   yazmanız istenir.
5. **Yedek** — üzerine yazmadan önce `~/.cpanel-next-backups/` altına yedek
   alınır. Alınamazsa deploy durur.

Ortam dosyaları (`.env`, `.env.local`, `.env.bak-…` — dotenv ailesinin tamamı)
pakete **hiçbir koşulda** girmez.

---

## Bilinen kısıtlar (faz 1)

- Yalnızca **Next.js**. Laravel desteği planlı.
- `output: 'standalone'` desteklenmiyor — Next'in kendi dokümanı bunun özel
  `server.js` ile birlikte kullanılamayacağını yazıyor, Passenger ise özel
  `server.js` gerektiriyor.
- **Next 13.4.x reddedilir** — o sürüm Passenger altında
  `http.Server.listen() was called more than once` ile patlıyor (13.5.6+ temiz).
- Uygulama yalnızca domain kökünde yayınlanır (`basePath` build'e gömüldüğü
  için alt yol desteği ayrı iş).
- Build daima **yerelde** koşar. CloudLinux'un varsayılan 1 GB bellek sınırı
  altında `next build` güvenilir değil.

### Passenger hakkında bilmeniz gerekenler

- Passenger `PORT` ortam değişkeni **vermez**; `listen()` çağrısını yamalayıp
  uygulamayı kendi Unix soketine bağlar. Verdiğiniz port değeri önemsizdir —
  ama `listen()` **tam olarak bir kez** çağrılmalıdır.
- Passenger **ESM yükleyemez**. `package.json`'ınızda `"type": "module"` varsa
  araç başlangıç dosyasını `server.cjs` olarak oluşturur.
- Yeniden başlatma `tmp/restart.txt` ile yapılır ve yalnızca bir istek
  geldiğinde kontrol edilir; araç bu yüzden yazdıktan sonra uygulamaya bir
  istek atar.

---

## Yazar

**Mücahit Sendinç** — [muco.tr](https://muco.tr)

## Lisans

MIT © Mücahit Sendinç
