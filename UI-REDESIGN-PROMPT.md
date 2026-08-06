# Görev: `cpanel-next` arayüzünü sıfırdan tasarla

Tek bir dosyayı yeniden yazacaksın: **`lib/ui-server/app.html`**.
Başka hiçbir dosyaya dokunma.

---

## 1. Ürün ne yapıyor

`cpanel-next`, Next.js ve Laravel projelerini cPanel paylaşımlı hostinge
yayınlayan bir araç. Kullanıcı terminalde `deploymanager ui` yazıyor ya da
masaüstü uygulamasını açıyor; her iki durumda da `127.0.0.1`'de bir yerel
sunucu açılıyor ve bu HTML sayfası ona bağlanıyor.

**Kullanıcı kitlesi son kullanıcı.** cPanel bilmiyor, Node bilmiyor, "belge
kökü" ne demek bilmiyor. Şu anki arayüz bunu varsayıyor ve **çok karışık** —
yeniden tasarımın tek amacı bu.

---

## 2. Değiştirilemez teknik kısıtlar

Bunlar tercih değil, sunucunun dayattığı kurallar. İhlal edilirse sayfa
çalışmaz.

### Tek dosya, sıfır bağımlılık

- Çıktı **tek bir `app.html`**: `<style>` + `<body>` + `<script>`.
- **Build adımı yok.** Sayfa diskten olduğu gibi servis ediliyor.
- **React/Vue/Tailwind/hiçbir kütüphane yok.** Vanilla DOM API.
- **Hiçbir dış kaynak yüklenemez.** CSP şu:
  ```
  default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
  connect-src 'self'; img-src data:
  ```
  Yani: dış font yok, CDN yok, `<img src="https://...">` yok. Görsel
  gerekiyorsa **inline SVG** ya da `data:` URI. Stil ve script **inline**
  olmak zorunda (ayrı `.css`/`.js` dosyası servis edilmiyor).

### Sunucunun enjekte ettiği iki yer değişmeli

Sayfa servis edilirken sunucu şu iki dizgeyi değiştiriyor:

```js
const TOKEN = '__SESSION_TOKEN__';
let LANG = '__LANG__';
```

Bu iki satır **birebir bu biçimde** kalmalı, yoksa oturum jetonu ve dil
enjekte edilemez.

### API sözleşmesi

Bütün istekler `X-CN-Token: TOKEN` başlığıyla gidiyor. Mevcut yardımcıları
koru:

```js
async function api(pathname, opts = {})   // fetch('/api/' + pathname, ...)
const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body) })
```

Hata gövdesi `{ error, hint }` biçiminde geliyor; ikisini de göster.

**Canlı iş akışı SSE ile:**
```js
new EventSource('/api/jobs/' + jobId + '/events?t=' + encodeURIComponent(TOKEN))
```
Gelen olay tipleri: `step`, `info`, `warn`, `remote`, `output`, `progress`
(`{sent,total}`), `done`, `failed` (`{text, hint}`), `job`.

**Sunucu API'sini DEĞİŞTİREMEZSİN.** Uç listesi bölüm 4'te.

### i18n — iki dil zorunlu

```js
const S = { tr: { anahtar: 'metin', ... }, en: { key: 'text', ... } };
const s = (k) => (S[LANG] || S.en)[k] ?? (S.en[k] ?? k);
```

- Kullanıcıya görünen **her** metin `s('anahtar')` üzerinden geçmeli.
- `tr` ve `en` sözlükleri **birebir aynı anahtarlara** sahip olmalı.
- Şu an ~317 anahtar var; yeniden yazarken hepsini karşılamak zorunda
  değilsin, ama kullandığın her anahtar iki sözlükte de olmalı.
- Türkçe **birincil dil**. Metinler doğal Türkçe olmalı, çeviri kokmamalı.

### Masaüstü kabuğu (Electron)

Sayfa hem tarayıcıda hem Electron penceresinde çalışıyor. Electron kendini
sorgu parametresiyle tanıtıyor: `?t=...&shell=mac`.

```js
const shell = new URLSearchParams(location.search).get('shell');
if (shell) document.body.classList.add('shell-' + shell);
```

`body.shell-mac` altında **zorunlu**:
```css
body.shell-mac header{ -webkit-app-region:drag; padding-left:92px }
body.shell-mac header button,
body.shell-mac header select,
body.shell-mac header a,
body.shell-mac header input{ -webkit-app-region:no-drag }
```
Gerekçe: Electron'da başlık çubuğu gizli. Sürükleme bölgesi olmazsa pencere
taşınamıyor; `no-drag` olmazsa üstteki düğmeler tıklanamıyor; 92px boşluk
olmazsa macOS'un kapat/küçült düğmeleri içeriğin üstüne biniyor.

Bu kurallar **yalnızca** `body.shell-mac` altında olmalı — tarayıcıda
uygulanırsa sol üstte sebepsiz bir boşluk oluşur.

### Koyu/açık tema

`prefers-color-scheme` ile ikisi de desteklenmeli. Şu an CSS değişkenleriyle
yapılıyor; yaklaşımı değiştirebilirsin ama iki tema da çalışmalı.
`prefers-reduced-motion` ile animasyonlar kapanmalı.

---

## 3. Tasarım hedefi

**"Kullanıcının düşünmesine gerek kalmasın."** Şu anki arayüzün sorunu şu:
yedi sekme, her sekmede yoğun tablolar, her ekranda çok fazla seçenek, ve
kullanıcı hangi sırayla ne yapacağını bilmiyor.

Beklentiler:

1. **Yönlendir, sunma.** Kullanıcı ekrana bakınca "şimdi ne yapmalıyım"ı
   bilmeli. Boş listeler "kayıt yok" demek yerine sıradaki adımı önermeli.
2. **Aşamalı açıklık.** Gelişmiş seçenekler (vendor kipi, migration kipi,
   build atlama, sahiplenme) varsayılan olarak **gizli** olmalı; isteyen
   açsın. Şu an hepsi aynı anda ekranda ve en çok karışıklık buradan geliyor.
3. **Yedi sekme çok.** Bilgi mimarisini yeniden kur. Öneri (bağlayıcı değil):
   sol kenarda ikonlu bir gezinme, "Sitelerim" merkezde, geri kalanı
   ikincil. Daha iyi bir şey bulursan yap.
4. **Tehlikeli işlemler görsel olarak ayrılmalı.** Silme, `migrate:fresh`,
   klasör üzerine yazma — bunlar sıradan düğmeler gibi görünmemeli.
5. **Modern ve sakin.** Tutarlı boşluk ölçeği, tek bir tipografi hiyerarşisi,
   yumuşak yüzeyler. Gradyan/animasyon şovu istemiyorum; profesyonel ve
   dingin olsun.
6. **Klavye ve erişilebilirlik.** Odak halkaları görünür, form etiketleri
   bağlı, kontrast yeterli.

---

## 4. Kapsanması gereken ekranlar ve uçlar

Hiçbir yetenek kaybolmamalı. Aşağıdakilerin hepsi arayüzde bir yerde olmalı.

### Açılış
| durum | ekran |
|---|---|
| `GET api/status` → `hasProfiles: false` | Karşılama: araç ne yapıyor + ilk hesabı ekle formu (ana şifre de burada belirlenir) |
| `locked: true` | Kasa açma (ana şifre) → `POST api/unlock {master}` |
| açık | Ana arayüz |

### Panel
`GET api/overview/<profil>` → `{ profile, sites, apps, domains, links, regime, regimeLabel, maxApps, driver }`

- `apps[]` — Node.js uygulamaları: `{name, domain, path, nodeVersion, status, enabled, owned, ownerProject, filesUrl}`
  - İşlemler: `POST api/app-action {profile,appRoot,action}` (`start|stop|restart`),
    `POST api/app-update {profile,appRoot,projectPath,domain}`,
    `POST api/app-delete {profile,appRoot,confirm,deleteFiles}`,
    `POST api/files-download {profile,path}`
- `sites[]` — Laravel siteleri: `{domain, appRoot, framework, ownerProject, version, filesUrl}`
  - Laravel'de **başlat/durdur/yeniden başlat YOK** (yönetilen süreç yok)
- `domains[]` — `{domain, type, typeLabel, docroot}`
  - Subdomain ekle: `POST api/subdomain {profile,label,rootDomain}`
  - Sil: `DELETE api/subdomain {profile,domain,confirm}`
- `links` — cPanel derin bağlantıları: `{cpanel, phpMyAdmin, files, tokens}`

### Yayınlama (sihirbaz)
1. **Proje seç**: `GET api/recent`, `GET api/browse?path=`, `GET api/project?path=`
   → `{project:{framework,nextVersion,laravelVersion,router,startupFile,assetBuilder,deployable,blockers,warnings}, plan:{files,bytes,skippedEnv}, link}`
2. **Hedef**:
   - Next.js: domain + uygulama klasörü → `POST api/preflight {profile,domain,appRoot,adopt}`
   - Laravel: yalnızca domain (klasör = belge kökü, seçilmiyor) →
     `POST api/laravel-preflight {profile,domain}` → `{target, appRoot, first, count, sample, ownerProject}`
   - Domain listesinde **"+ yeni subdomain"** seçeneği olmalı
3. **Kontrol ve onay**: ne silinecek, ne korunacak. Klasör doluysa
   **adını birebir yazarak onay** (sunucu da denetliyor, atlanamaz).
4. **Yayın**: `POST api/deploy {...}` → `{jobId}` → SSE ile canlı log

Laravel ek ayarları (gizlenebilir olmalı): migration kipi
(`none|migrate|migrate-seed|fresh-seed`), vendor kipi (`auto|always|server`),
`APP_DEBUG`'a dokunma, veritabanı (dokunma / yeni oluştur / mevcut seç).

### Veritabanı
`GET api/db/<profil>` → `{databases, users, restrictions, server, pmaUrl}`
- Oluştur: `POST api/db-create {profile,name,user,password}`
- Sil: `POST api/db-delete {profile,database,confirm}` (yazarak onay)
- Şifre: `POST api/db-password {profile,user,database}`
- Kullanıcı sil: `POST api/db-user-delete {profile,user,confirm}`
- Yedek al ve indir: `POST api/db-backup {profile,database}` → iş
- Ortam dosyası: `GET api/env?profile=&appRoot=&file=&reveal=`,
  `POST api/env {profile,appRoot,file,entries|remove}`,
  `POST api/env-local {projectPath,file,entries}`

### E-posta
`GET api/mail/<profil>` → `{accounts, domains}`
- Oluştur `POST api/mail-create`, şifre `POST api/mail-password`,
  kota `POST api/mail-quota`, sil `POST api/mail-delete` (yazarak onay)
- Bağlantı ayarları: `GET api/mail-settings?profile=&email=`
- **Webmail'e doğrudan giriş**: `/sso?t=TOKEN&profile=X&target=webmail&email=Y`
  (yeni sekmede açılır, şifre sormaz)

### FTP
`GET api/ftp/<profil>` → `{accounts, server}`
- `POST api/ftp-create`, `POST api/ftp-password`, `POST api/ftp-delete` (yazarak onay)

### Geçmiş
- `GET api/backups?profile=` → geri alma noktaları → `POST api/rollback {profile,appRoot,backup,confirm}`
- `GET api/logs?profile=&appRoot=` → sunucudaki son çalıştırmalar + deploy geçmişi

### Hesap ayarları (seçili cPanel hesabı)
- `PATCH api/profiles/<ad>` — sunucu/port/kullanıcı, şifre verilirse token yenilenir,
  `savePassword` ile otomatik giriş
- `POST api/profiles/<ad>/test` → `{ok, user, domain}` — bağlantı testi
- `DELETE api/profiles/<ad>`
- cPanel şifresi: `POST api/account-password {profile,oldPassword,newPassword}`

### Genel ayarlar (araca ait)
- Ana şifre: `POST api/master-password {oldPassword,newPassword}`
- `GET/POST api/preferences` — `{ui: 'web'|'terminal', lang}`
- Dil: `POST api/lang {lang}`

### cPanel derin bağlantıları
Şifre kasadaysa `/sso?t=TOKEN&profile=X&target=phpmyadmin|files|cpanel[&dir=|&db=]`
(otomatik giriş), değilse `links` içindeki adres. Hepsi
`target="_blank" rel="noreferrer"` ile yeni sekmede.

### İndirilen dosyalar
İş bitince sonuç `{path}` içeriyorsa **"Klasörde göster"** düğmesi:
`POST api/reveal {path}`

### Yaşam döngüsü
- `POST api/heartbeat` her ~5 sn — kesilirse sunucu kapanıyor, **bunu bozma**
- `POST api/lock` — kasayı kilitle
- `POST api/exit` — terminale dön

---

## 5. Kabul kriterleri

Şu testler **geçmek zorunda** (`npm test`, kök dizinde):

`test/ui-strings.test.mjs` şunları denetliyor:
1. `tr` ve `en` sözlükleri **aynı anahtarlara** sahip
2. Kodda kullanılan **her** `s('anahtar')` sözlükte var
3. Sekme listesi ve görünüm eşlemesi tutarlı
4. Dış bağlantılarda `target="_blank"` ve `rel="noreferrer"` var
5. **Çağrılan her fonksiyon tanımlı** (ölü düğme olmasın)

Testi kendi yapına göre güncelleyebilirsin ama **denetlediği beş şeyi
gevşetme** — hepsi gerçek bir arızadan geliyor:
- Eksik i18n anahtarı düğmenin üstüne `writeEnv` yazdırıyordu
- Tanımsız fonksiyon "Sil" düğmesini sessizce ölü bırakmıştı

Ayrıca:
- Sayfa `node --check` ile sözdizimi denetiminden geçmeli
- `deploymanager ui` ile açılıp gerçekten çalışmalı
- Electron penceresinde sürüklenebilmeli, düğmeler tıklanabilmeli

---

## 6. Yaklaşım

- Mevcut `app.html`'i **oku**; hangi ekranın ne yaptığını oradan öğren.
- Sunucu tarafını (`lib/ui-server/api.mjs`, `server.mjs`) **okuyabilirsin**
  ama **değiştirme**.
- Tasarımı sıfırdan kur; mevcut CSS'i ve bileşenleri korumak zorunda değilsin.
- Yardımcı `el(tag, attrs, ...children)` işlevi işe yarıyor, korumanı öneririm.
- Türkçe yorum yaz ve **neden** öyle yaptığını açıkla, ne yaptığını değil.

## 7. Yapmayacakların

- Sunucu API'sini değiştirmek
- Dosyayı parçalara bölmek (tek dosya olmak zorunda)
- Herhangi bir kütüphane/CDN eklemek
- `__SESSION_TOKEN__` / `__LANG__` enjeksiyon noktalarını bozmak
- Yazarak onay adımlarını kaldırmak ya da tek tıka indirmek
- Kalp atışını (`heartbeat`) kaldırmak
- Türkçe ya da İngilizce sözlüğü eksik bırakmak
