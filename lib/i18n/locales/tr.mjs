export default {
  common: {
    cancelled: 'İptal edildi.',
    notConfirmed: 'Onaylanmadı.',
    yes: 'evet',
    no: 'hayır',
    none: '(yok)',
    unknown: 'bilinmiyor',
    dash: '—',
    noRecords: '  (kayıt yok)',
    typeToConfirm: 'Devam etmek için uygulama klasörünün adını yazın',
    mustType: '"{expected}" yazmalısınız.',
    noProfile: 'Kayıtlı bir cPanel profili yok.',
    runLogin: 'Önce "deploymanager login" çalıştırın.',
  },

  cli: {
    unknownCommand: 'Bilinmeyen komut: {name}',
    tryHelp: '"deploymanager --help" deneyin.',
    optionsHint: '"deploymanager --help" ile seçenekleri görebilirsiniz.',
    help: `
  cpanel-next — Next.js projelerini cPanel'e yayınlar

  KULLANIM
    deploymanager [komut] [seçenekler]

  KOMUTLAR
    (komutsuz)        Bulunduğun dizindeki projeyi etkileşimli olarak yayınla
    deploy            Aynısı, bayraklarla (etkileşimsiz kullanılabilir)
    login             cPanel'e bağlan ve bu araç için bir API token'ı üret
    logout            Kayıtlı profili (ve token'ı) sil
    status            Domain'i çöz, hesabın Node.js uygulamalarını göster
    apps              Hesaptaki tüm Node.js uygulamalarını listele
    rollback          Önceki sürüme dön
    logs              Son çalıştırmanın sunucu çıktısını göster
    doctor            Bağlantı, yetenek ve ortam denetimi
    ui                Yerel web arayüzünü aç (tarayıcıdan yönet)

  SEÇENEKLER
    --host <ad>              cPanel sunucusu (örn. sunucu.com)
    --user <ad>              cPanel kullanıcı adı
    --token <token>          cPanel API token'ı (yoksa profilden okunur)
    --port <n>               cPanel portu (varsayılan 2083)
    --profile <ad>           Kayıtlı profil adı
    --password-stdin         Şifreyi stdin'den oku (CI için)
    --insecure               TLS sertifika doğrulamasını atla (adı uyuşmayan
                             sertifikalar için; yalnız güvendiğiniz sunucuda)

    --domain <domain>        Yayınlanacak domain veya subdomain
    --app-root <klasör>      Sunucudaki uygulama klasörü (ev dizinine göreli)
    --app-name <ad>          Uygulama adı (varsayılan: app-root)
    --node-version <n>       Node sürümü (yalnız CloudLinux'ta seçilebilir)
    --no-build               "npm run build" adımını atla (mevcut .next kullanılır)
    --clean-modules          Sunucudaki node_modules'ü silip sıfırdan kur
    --transport <yol>        upload | ftp  (varsayılan: otomatik)

    --lang <tr|en>           Arayüz dili
    --no-open                (ui) tarayıcıyı otomatik açma
    -y, --yes                Onayları geç (yıkıcı işlemlerde yine de sorar)
        --dry-run            Hiçbir şey yazma, ne yapılacağını yaz
        --force              Korumalı ad denetimini geç (sahiplik denetimi geçilmez)
        --adopt              Bu aracın oluşturmadığı bir uygulamayı sahiplen
    -v, --verbose            Ayrıntılı çıktı
    -h, --help               Bu yardım
        --version            Sürüm

  ÖRNEKLER
    cd ~/projeler/magaza && deploymanager
    deploymanager --domain magaza.example.com --app-root magazanext -y
    deploymanager status --domain magaza.example.com
    deploymanager --dry-run
`,
  },

  config: {
    loosePerms: '{file} izinleri gevşekti ({mode}), 0600\'e çekildi.',
    readFailed: 'Yapılandırma dosyası okunamadı ({file}): {error}',
    projectReadFailed: '{file} okunamadı: {error}',
    secretInProject:
      '{file} içinde sır olabilecek bir alan var: "{path}".\n' +
      'Bu dosya commit edilmek üzere tasarlandı; token ve şifreler ~/.cpanel-next/config.json\'a ait.\n' +
      'Alanı silin, sonra tekrar deneyin.',
  },

  cpanel: {
    noHost: 'cPanel sunucusu belirtilmedi.',
    loginHint: 'deploymanager login ile bağlanın.',
    noToken: 'cPanel API token bulunamadı.',
    noTokenHint: 'deploymanager login çalıştırın; araç sizin için bir token üretecek.',
    authRejected: 'cPanel kimlik doğrulaması reddedildi ({label}, HTTP {status}).',
    authRejectedToken: 'Token geçersiz veya iptal edilmiş olabilir. "deploymanager login" ile yenileyin.',
    authRejectedSession: 'Oturum düşmüş olabilir; şifre yeniden sorulacak.',
    api2Rejected: 'cPanel API2 kimlik doğrulaması reddedildi ({label}, HTTP {status}).',
    api2RejectedHint: 'Token API2 uçlarında kabul edilmiyor olabilir; oturum kipi denenecek.',
    api2Unexpected: 'cPanel API2 beklenmeyen yanıt verdi ({label}, HTTP {status}).',
    htmlResponse: 'cPanel JSON yerine HTML döndürdü ({label}, HTTP {status}).',
    htmlResponseHint: 'Sunucu adı veya port yanlış olabilir; ya da oturum düşmüş olabilir.',
    parseFailed: 'cPanel yanıtı ayrıştırılamadı ({label}, HTTP {status})',
    requestFailed: '{label}: istek başarısız (status={status})',
    timeout: 'Zaman aşımı ({seconds} sn): {host}',
    aborted: 'İptal edildi',
  },

  vault: {
    corrupt: 'Kasa bilgisi bozuk.',
    corruptHint: 'deploymanager logout ile sıfırlayıp tekrar bağlanın.',
    wrongPassword: 'Ana şifre yanlış.',
    wrongPasswordHint:
      'Şifrenizi unuttuysanız "deploymanager logout" ile profili silip yeniden bağlanabilirsiniz.',
    inVault: 'kasada',
    plaintext: 'şifresiz — eski biçim',
  },

  auth: {
    masterPrompt: 'Ana şifre',
    masterRequired: 'Ana şifre gerekli.',
    masterCreateInfo:
      "Bu cihazda saklanacak cPanel token'ı bir ana şifreyle şifrelenecek.\n" +
      'Şifre hiçbir yere yazılmaz — UNUTURSANIZ kayıtlı bilgiler açılamaz\n' +
      've yeniden bağlanmanız gerekir. Karmaşıklık şartı yoktur.',
    masterNew: 'Yeni ana şifre belirleyin',
    masterNewRequired: 'Ana şifre boş olamaz.',
    masterRepeat: 'Ana şifreyi tekrar girin',
    masterMismatch: 'Şifreler eşleşmiyor.',
    masterWrongRetry: 'Ana şifre yanlış, tekrar deneyin.',
    tokenEncryptedNoVault: 'Kayıtlı token şifreli ama kasa bilgisi yok.',
    tokenEncryptedNoVaultHint: 'deploymanager login ile yeniden bağlanın.',
    passwordPrompt: 'cPanel şifresi',
    passwordFor: '{user}@{host} cPanel şifresi',
    passwordRequired: 'Şifre boş olamaz.',
    tfaPrompt: 'İki adımlı doğrulama kodu',
    tfaInvalid: '6 haneli kod girin.',
    tfaRequired: 'Bu hesapta iki adımlı doğrulama açık.',
    tfaEnterCode: 'Doğrulama kodunu girin.',
    sessionFailed: 'cPanel oturumu açılamadı.',
    loginRejected: 'Giriş reddedildi',
    loginFailed: 'cPanel girişi başarısız: {message}',
    noJson: 'cPanel girişi JSON döndürmedi (HTTP {status}).',
    noJsonHint: 'Sunucu adı/port doğru mu? Özel bir giriş sayfası varsa tarayıcı yolu denenecek.',
    noSecurityToken: 'cPanel oturum jetonu (cpsess) alınamadı.',
    browserLoginFailed: 'Tarayıcıyla giriş yapılamadı (cpsess alınamadı).',
    browserLoginHint: 'Şifre veya doğrulama kodu hatalı olabilir.',
    tokenFeatureDisabled: 'Bu hesapta API token özelliği (apitokens) kapalı.',
    tokenFeatureDisabledHint:
      'Sorun değil — araç oturum kipiyle çalışacak, her çalıştırmada şifre soracak.',
    tokenMissingInResponse: 'cPanel token üretti ama yanıtta token bulunamadı.',
    tokenFailed: 'API token üretilemedi.',
    escalating: 'Bu adım API token\'ıyla yapılamıyor{reason}; cPanel oturumu açılacak.',
  },

  browser: {
    playwrightMissing: 'playwright-core yüklenemedi.',
    playwrightHint: 'Paketi yeniden kurmayı deneyin: npm i -g cpanel-next  ({error})',
    installerMissing: 'Chromium indirici bulunamadı (playwright-core/cli.js).',
    installerHint: 'Elle kurabilirsiniz: PLAYWRIGHT_BROWSERS_PATH={dir} npx playwright-core install chromium',
    downloading: 'Chromium indiriliyor (~150 MB, tek seferlik)',
    ready: 'Chromium hazır',
    downloadFailed: 'Chromium indirilemedi (çıkış kodu {code}).',
    needsBrowser:
      'Bu adım için tarayıcı gerekiyor{reason}.\n' +
      'Chromium ~150 MB indirilecek ve {dir} altına kurulacak.\n' +
      'Bir daha indirilmeyecek.',
    askDownload: 'Chromium indirilsin mi?',
    refused: 'Tarayıcı olmadan bu adım tamamlanamıyor.',
    refusedHint: 'API yolu bu sunucuda yetmedi. İzin verirseniz tarayıcı yolu deneyecek.',
    sessionReason: 'cPanel oturumu',
  },

  detect: {
    noPackageJson: 'Bu dizinde package.json yok — Next.js projesi görünmüyor.',
    laravelNotSupported:
      'Laravel desteği henüz yok (faz 2). Şimdilik yalnızca Next.js yayınlanabiliyor.',
    packageJsonUnreadable: 'package.json okunamadı: {error}',
    mixedProject:
      'Bu dizinde hem Laravel (artisan) hem Next.js (package.json) var. ' +
      'Hangi alt klasörün yayınlanacağı belirsiz — Next.js projesinin kendi klasörüne girip tekrar deneyin.',
    noNextDep: 'package.json içinde "next" bağımlılığı yok.',
    noBuildScript: 'package.json içinde "build" betiği yok.',
    buildScriptOdd: 'build betiği "next build" içermiyor: "{script}"',
    standalone:
      "next.config içinde output: 'standalone' var. Passenger özel bir server.js gerektiriyor ve " +
      'Next dokümanı bu ikisinin birlikte kullanılamayacağını yazıyor. Faz 1 bunu desteklemiyor — ' +
      "standalone'u kaldırın veya bir sonraki sürümü bekleyin.",
    next134:
      'Next.js {version} Passenger altında çalışmıyor: router-server ikinci bir http.Server ' +
      'açtığı için "http.Server.listen() was called more than once" hatası veriyor. ' +
      '13.5.6 veya üstüne yükseltin.',
    esmWarning:
      'package.json\'da "type": "module" var. Passenger ESM yükleyemediği için başlangıç ' +
      'dosyası server.cjs olarak oluşturulacak.',
    noLockfile:
      'Lockfile yok. Sunucuda bağımlılıklar sabitlenmemiş sürümlerle kurulacak; ' +
      'yereldekinden farklı bir ağaç oluşabilir.',
    oldNode: 'Yerel Node {version} eski; paketleme sorun çıkarabilir.',
    nativeDeps:
      'Yerel (native) bağımlılıklar sunucuda derlenecek: {list}. ' +
      "CloudLinux 7 gibi eski glibc'lerde derleme başarısız olabilir.",
    sharpOptional:
      "Next 15+ sharp'ı optionalDependencies'e taşıdı. Sunucuda opsiyonel paketler atlanırsa " +
      "görüntü optimizasyonu sessizce bozulur; sorun yaşarsanız sharp'ı doğrudan bağımlılık yapın.",
    basePath:
      'next.config içinde basePath var. basePath build sırasında gömülür; uygulamanın kök dizinde ' +
      '(base_uri "/") yayınlanması gerekir, aksi hâlde yollar tutmaz.',
  },

  domain: {
    listFailed: 'Hesaptaki domainler alınamadı: {error}',
    listFailedHint: 'Token/oturum bu hesaba erişebiliyor mu?',
    empty: 'Domain boş olamaz.',
    parked:
      'Park edilmiş domainlerin kendi belge kökü yoktur; ana domaine yönlenirler. ' +
      'Yayın için subdomain veya addon domain kullanın.',
    invalidLabel: 'Geçersiz subdomain etiketi: {label}',
    types: {
      main: 'ana domain',
      addon: 'addon domain',
      sub: 'subdomain',
      parked: 'park edilmiş',
    },
  },

  guards: {
    emptyAppRoot: 'Uygulama klasörü (app-root) boş olamaz.',
    invalidAppRoot: 'Geçersiz uygulama klasörü: "{name}"',
    invalidAppRootHint:
      'Yalnızca harf, rakam, nokta, alt çizgi ve tire kullanın; eğik çizgi ve ".." olmaz.',
    dotStart: 'Uygulama klasörü nokta ile başlayamaz: "{name}"',
    dotStartHint: 'Nokta ile başlayan dizinler hesabın kendi yapılandırmasına ait.',
    protected: '"{name}" korumalı bir klasör; uygulama klasörü olarak kullanılamaz.',
    protectedHint:
      'Next kaynağı belge kökünün veya hesap altyapısının içine konmaz. Ayrı bir klasör adı verin.',
    protectedForce: '"{name}" korumalı bir klasör ve --force ile bile açılmıyor.',
    protectedForceHint: 'Bu klasörü silmek hesabı bozar.',
    docrootClash: '"{name}" bir domainin belge kökü ({docroot}).',
    docrootClashHint:
      'Uygulama klasörü belge kökünden AYRI olmalı; aksi hâlde kaynak kodunuz ve .env dosyanız ' +
      'internete açık hâle gelir. Farklı bir klasör adı verin (örn. "{suggestion}").',
    notOwned: '"{appRoot}" klasörü bu araç tarafından oluşturulmamış (sahiplik işareti yok).',
    notOwnedHint:
      'İçeriği silinip paketiniz açılacaktı — durduruldu.\n' +
      'Bu klasörün gerçekten sizin uygulamanız olduğundan eminseniz --adopt ekleyin; ' +
      'onay ekranında klasör adını elle yazmanız istenecek.',
    newFolder: 'yeni klasör',
  },

  packager: {
    buildStartFailed: 'Build başlatılamadı: {error}',
    buildStartHint: "{cmd} kurulu ve PATH'te mi?",
    buildFailed: 'Build başarısız (çıkış kodu {code}).',
    noBuildId: '.next/BUILD_ID oluşmadı — build çıktısı üretmedi.',
    noBuildIdHint: 'build betiğiniz gerçekten "next build" çalıştırıyor mu?',
    staleBuildId: '.next/BUILD_ID güncellenmedi — build yeni çıktı üretmemiş görünüyor.',
    staleBuildIdHint:
      '--no-build ile mevcut çıktıyı bilerek göndermek isterseniz onu kullanın.',
  },

  remote: {
    deleteFailed: 'Silinemedi: {path}',
    deleteFailedHint: 'cPanel silme çağrısı başarılı döndü ama dosya hâlâ duruyor.',
  },

  transport: {
    failed: 'Paket sunucuya aktarılamadı.',
    rejected: 'Yükleme reddedildi: {reason}',
    unknownReason: 'bilinmeyen sebep',
    missingAfterUpload: 'Yükleme başarılı göründü ama dosya sunucuda bulunamadı.',
    ftpMissing: 'basic-ftp kurulu değil; FTP yolu atlanıyor.',
    ftpCleanupFailed:
      'Geçici FTP hesabı "{user}" silinemedi. cPanel → FTP Accounts\'tan elle silin.',
    splitting: 'Paket {count} parçaya bölünüyor (host tek parçayı kabul etmedi).',
  },

  driver: {
    quotaFull: 'Uygulama kotası dolu ({current}/{max}).',
    quotaFullHint: "cPanel → Application Manager'dan kullanılmayan bir uygulamayı kaldırın.",
    depsFailed: 'Bağımlılık kurulumu başarısız: {message}',
    depsTimeout: 'Bağımlılık kurulumu zaman aşımına uğradı.',
  },

  cron: {
    notTriggered: '{label}: cron 2,5 dakikadır tetiklenmedi.',
    notTriggeredHint: 'Hosting sağlayıcınız cron işlerini kısıtlıyor olabilir.',
    failed: '{label} başarısız: {error}',
    unknownError: 'bilinmeyen hata',
    timeout: '{label}: zaman aşımı ({minutes} dk).',
    appLabel: 'Node.js uygulaması',
    depsLabel: 'Bağımlılık kurulumu',
    stopLabel: 'Durdurma',
    startLabel: 'Başlatma',
  },

  login: {
    title: 'cpanel-next · bağlantı',
    askHost: 'cPanel sunucusu',
    askHostRequired: 'Sunucu adı gerekli.',
    askUser: 'cPanel kullanıcı adı',
    askUserRequired: 'Kullanıcı adı gerekli.',
    opening: 'cPanel oturumu açılıyor',
    openFailed: 'Oturum açılamadı',
    opened: 'Oturum açıldı ({via})',
    viaHttp: 'doğrudan',
    viaBrowser: 'tarayıcı',
    creatingToken: 'Bu araç için API token üretiliyor',
    tokenCreated: 'Token üretildi: {name}',
    tokenDisabled: 'API token özelliği kapalı — oturum kipi kullanılacak',
    tokenFailed: 'Token üretilemedi',
    verifying: 'Token doğrulanıyor',
    verified: 'Token çalışıyor',
    verifyFailed: 'Token doğrulanamadı',
    verifyFailedMessage: 'Üretilen token kabul edilmedi: {error}',
    verifyFailedHint:
      'Hostunuz token erişimini kısıtlıyor olabilir. Araç yine de oturum kipiyle çalışabilir.',
    savedTitle: 'Profil kaydedildi',
    labelServer: 'Sunucu',
    labelAccount: 'Hesap',
    labelToken: 'Token',
    labelStore: 'Kayıt',
    labelQuota: 'Uygulama kotası',
    noTokenValue: 'yok — her çalıştırmada şifre sorulacak',
    tokenScopeWarning:
      "cPanel API token'ları kapsamlandırılamaz: bu token hesabınızın erişebildiği\n" +
      'her şeye erişir. İstediğiniz an cPanel → Security → Manage API Tokens\n' +
      'sayfasından "{name}" kaydını silebilirsiniz.',
    passwordNotStored: 'Şifreniz hiçbir yere yazılmadı.',
    done: 'Hazır. Bir Next.js projesine girip {command} yazın.',
  },

  logout: {
    title: 'cpanel-next · çıkış',
    noProfiles: 'Kayıtlı profil yok.',
    which: 'Hangi profil silinsin?',
    notFound: 'Profil bulunamadı: {name}',
    confirm: '{user}@{host} profili silinsin mi?',
    removed: 'Profil silindi.',
    tokenStillValid:
      "Sunucudaki API token'ı hâlâ geçerli: {name}\n" +
      'Tamamen iptal etmek için cPanel → Security → Manage API Tokens sayfasından silin.',
  },

  apps: {
    title: 'cpanel-next · uygulamalar',
    noManager: 'Bu hesapta Node.js uygulaması yönetimi bulunamadı.',
    reading: 'Uygulamalar okunuyor',
    count: '{count} uygulama',
    emptyTitle: '{user}@{host}',
    empty:
      'Bu hesapta kayıtlı Node.js uygulaması yok.\n' +
      'Bir Next.js projesine girip "deploymanager" yazarak ilkini oluşturabilirsiniz.',
    headers: ['UYGULAMA', 'DOMAIN', 'NODE', 'DURUM', 'KLASÖR', 'SAHİP'],
    ownerSelf: 'cpanel-next',
    ownerExternal: 'dış',
    ownerNote: '"dış" işaretli uygulamalar bu araçla oluşturulmadı; üzerlerine yazılmaz.',
    quota: 'kota {current}/{max}',
    statusRunning: 'çalışıyor',
    statusStopped: 'durdu',
  },

  status: {
    title: 'cpanel-next · durum',
    reading: 'Hesap okunuyor',
    summary: '{domains} domain · {apps} uygulama',
    connectionTitle: 'Bağlantı',
    labelServer: 'Sunucu',
    labelAccount: 'Hesap',
    labelRegime: 'Rejim',
    labelAuth: 'Kimlik',
    authToken: 'API token',
    authSession: 'oturum (token yok)',
    headers: ['DOMAIN', 'TÜR', 'BELGE KÖKÜ', 'UYGULAMA'],
    notFound: '"{domain}" bu hesapta yok ve üst bölgesi de bulunamadı.',
    canCreateSub:
      '"{domain}" henüz yok ama "{root}" hesapta var — deploy sırasında subdomain olarak oluşturulabilir.',
    projectTitle: 'Yerel proje',
    labelDir: 'Dizin',
    labelFramework: 'Next.js',
    labelStartup: 'Başlangıç',
    labelState: 'Durum',
    startupMissing: ' (yok, oluşturulacak)',
    deployable: 'yayınlanabilir',
    notDeployable: 'engelli',
    deployedTitle: 'Bu araçla yayınlananlar',
  },

  doctor: {
    title: 'cpanel-next · tanılama',
    envTitle: 'Ortam',
    serverTitle: 'Sunucu',
    projectTitle: 'Yerel proje · {dir}',
    nodeNeeds: 'en az 18.17 gerekli',
    platform: 'Platform {platform} {arch}',
    chromiumInstalled: 'Chromium kurulu',
    chromiumMissing: 'Chromium kurulu değil',
    chromiumHint: 'gerektiğinde indirilecek (~150 MB)',
    configAt: 'Yapılandırma {file} ({mode})',
    configMissing: 'Yapılandırma yok',
    configMissingHint: 'deploymanager login çalıştırın',
    server: 'Sunucu {host}:{port}',
    account: 'Hesap {user}',
    token: 'Token {value}',
    tokenMissing: 'Token yok',
    tokenMissingHint: 'oturum kipi kullanılacak',
    uapiOk: 'UAPI bağlantısı çalışıyor',
    uapiFail: 'UAPI bağlantısı',
    quota: 'Uygulama kotası {value}',
    api2Ok: 'API2 (token ile) çalışıyor',
    api2Fail: 'API2 (token ile)',
    api2FailHint: '{error} — oturum kipine düşülecek',
    regime: 'Rejim: {label}',
    passengerModule: 'PassengerApps modülü',
    webappModule: 'WebApp API (cPanel 138+)',
    appCount: 'Kayıtlı uygulama: {count}',
    probeFail: 'Yetenek tespiti',
    ftp: 'FTP {state}',
    ftpOff: 'kapalı',
    ftpHint: 'yükleme UAPI ile yapılacak',
    loginFirst: 'Sunucu denetimleri için önce "deploymanager login" çalıştırın.',
    connectFailed: 'Bağlantı kurulamadı.',
    framework: 'Framework: {name}',
    nextInfo: 'Next.js {version} · {router} router',
    startupWillCreate: 'deploy sırasında oluşturulacak',
    deployable: 'Yayınlanabilir',
    notDeployable: 'Yayınlanamaz',
  },

  rollback: {
    title: 'cpanel-next · geri alma',
    reading: 'Yedekler okunuyor',
    count: '{count} yedek',
    noneTitle: 'Yedek bulunamadı',
    none:
      '~/{dir} altında yedek yok.\n' +
      'Yedekler yalnızca mevcut bir uygulamanın üzerine yazılırken alınır.',
    noneForApp: '{name} için yedek bulunamadı; tüm yedekler listeleniyor.',
    which: 'Hangi yedeğe dönülsün?',
    notOwned: '~/{appRoot} bu araç tarafından oluşturulmamış.',
    notOwnedHint: 'Geri alma durduruldu. Eminseniz --adopt ekleyin.',
    warning:
      '~/{appRoot} klasörünün içeriği silinip ~/{backup} yazılacak.\n' +
      'Bağımlılıklar yeniden kurulacağı için bu işlem 1-2 dakika sürebilir.',
    working: 'Geri alınıyor',
    stopping: 'Uygulama durduruluyor',
    cleaningModules: 'Bagimliliklar sifirdan kurulacak (node_modules siliniyor)',
    cleaning: 'Mevcut dosyalar temizleniyor',
    cleanFailed: 'Bazı dosyalar silinemedi: {files}',
    restoring: 'Yedek geri yazılıyor',
    missingPackageJson: 'Geri yazma sonrası package.json bulunamadı — yedek eksik olabilir.',
    installing: 'Bağımlılıklar kuruluyor',
    installingCron: 'Bağımlılıklar kuruluyor (cron bekleniyor)',
    starting: 'Uygulama başlatılıyor',
    doneSpinner: 'Geri alındı',
    failed: 'Geri alma başarısız',
    doneTitle: 'Tamamlandı',
    labelFolder: 'Klasör',
    labelBackup: 'Yedek',
    labelUrl: 'Adres',
    done: 'Geri alındı.',
  },

  logs: {
    title: 'cpanel-next · kayıtlar',
    reading: 'Sunucudaki çalıştırmalar okunuyor',
    count: '{count} çalıştırma kaydı',
    which: 'Hangi çalıştırma?',
    none: 'Sunucuda bekleyen veya tamamlanmış bir çalıştırma kaydı yok.',
    completed: 'Tamamlandı',
    failed: 'Başarısız: {error}',
    running: 'Devam ediyor · %{progress} · {step}',
    outputHeader: '--- sunucu çıktısı (son 4000 karakter) ---',
    markerTitle: 'Sahiplik işareti',
    labelFolder: 'Klasör',
    labelDomain: 'Domain',
    labelProject: 'Proje',
    labelMachine: 'Makine',
    labelVersion: 'Sürüm',
    labelCreated: 'Oluşturma',
    historyHeaders: ['TARİH', 'SÜRÜM', 'DURUM'],
    historyOk: 'ok',
    historyFail: 'hata',
    needApp: 'Uygulama geçmişi için bir proje dizininde çalıştırın veya --app-root verin.',
  },

  deploy: {
    title: 'cpanel-next',
    dryRunBadge: ' · DRY RUN',
    notDeployable: 'Proje bu hâliyle yayınlanamaz.',
    projectLine: '{framework} · {router} router · {name}',
    probing: 'Sunucu yetenekleri sorgulanıyor',
    probed: 'Sunucu: {regime}',
    cached: ' (önbellek)',
    noDriver: 'Bu hesapta Node.js uygulaması yönetilemiyor.',
    noDriverHint:
      'Ne cPanel Application Manager ne CloudLinux Node.js Selector bulunabildi.\n' +
      'Hosting sağlayıcınıza "Setup Node.js App" özelliğinin açık olup olmadığını sorun.',
    noDomains: '{user}@{host} hesabında hiç domain bulunamadı.',
    domainNotFound: '"{domain}" bu hesapta yok ve üst bölgesi de bulunamadı.',
    domainNotFoundHint:
      'Hesaptaki domainler:\n  {list}\n\nDomaini önce cPanel → Domains bölümünden hesaba ekleyin.',
    askDomain: 'Hangi domaine yayınlansın? ({account})',
    newSubdomain: '+ yeni subdomain oluştur',
    askRoot: 'Hangi domainin altına?',
    askLabel: 'Subdomain etiketi  (… .{root})',
    labelRequired: 'Etiket gerekli.',
    labelChars: 'Yalnızca harf, rakam ve tire.',
    labelExists: 'Bu subdomain zaten var.',
    appExists: 'Bu domainde zaten bir uygulama var: {name} (~/{path})',
    askUpdate: '"{name}" güncellensin mi?',
    askAppRoot: 'Sunucudaki uygulama klasörü',
    startupCreated: '{file} oluşturuldu (Passenger başlangıç dosyası). Projenize commit edin.',
    destructiveWarn: '{appRoot} klasörünün içeriği SİLİNECEK ve paketiniz açılacak.',
    destructiveWarnPreserve: ' (korunacak dosyalar hariç)',
    askPublish: '{url} adresine yayınlansın mı?',
    creatingSubdomain: 'Subdomain oluşturuluyor: {domain}',
    createdSubdomain: 'Subdomain oluşturuldu: {domain}',
    sslNote:
      'SSL sertifikası (AutoSSL) bir saati bulabilir; o ana dek sertifika uyarısı normaldir.',
    building: 'Proje derleniyor (npm run build)',
    noBuildFlag: '--no-build: mevcut .next çıktısı gönderiliyor.',
    noBuildOutput: '.next/BUILD_ID yok — gönderilecek bir build yok.',
    packing: 'Paket hazırlanıyor',
    packed: 'Paket hazır: {files} dosya · {size}',
    skippedEnv: 'Pakete alınmayan ortam dosyaları: {list}',
    backingUp: 'Mevcut sürüm yedekleniyor',
    backedUp: 'Yedek: ~/{path}',
    backupFailed: 'Yedek alınamadı',
    backupFailedMessage: 'Yedek alınamadı: {error}',
    backupFailedHint: 'Geri dönüş yolu olmadan mevcut uygulamanın üzerine yazmıyoruz.',
    uploading: 'Paket yükleniyor',
    uploadingProgress: 'Paket yükleniyor · {sent} / {total}',
    uploaded: 'Paket yüklendi ({strategy})',
    uploadTooLarge: 'Tek parça kabul edilmedi, bölünüyor',
    uploadFailed: 'Yükleme başarısız',
    applying: 'Sunucuda uygulanıyor',
    stopping: 'Uygulama durduruluyor',
    cleaning: 'Eski dosyalar temizleniyor',
    cleanFailed: 'Bazı dosyalar silinemedi: {files}',
    cleanFailedHint: 'cPanel silme çağrısı sessizce başarısız olmuş olabilir; deploy durduruldu.',
    extracting: 'Arşiv açılıyor',
    missingPackageJson: 'Paket açıldı ama package.json bulunamadı.',
    backupKept: 'Yedek duruyor: ~/{path}',
    writingMarker: 'Sahiplik işareti yazılıyor',
    registering: 'Node.js uygulaması kaydediliyor',
    runningRemote: 'Sunucuda çalıştırılıyor (cron tetiklenmesi bekleniyor)',
    installing: 'Bağımlılıklar kuruluyor (npm install)',
    installingLine: 'Bağımlılıklar: {line}',
    restarting: 'Uygulama yeniden başlatılıyor',
    published: 'Yayınlandı',
    remoteFailed: 'Sunucu adımı başarısız',
    rollbackHint: 'Geri almak için: deploymanager rollback --domain {domain}',
    doneTitle: 'Tamamlandı',
    labelUrl: 'Adres',
    labelAccount: 'Hesap',
    labelFolder: 'Klasör',
    labelBackup: 'Yedek',
    labelRollback: 'Geri alma',
    live: 'Yayında.',
    dryRunDone: '--dry-run: hiçbir şey yazılmadı.',

    confirmMismatch: '--confirm "{given}" uygulama klasörüyle eşleşmiyor ("{appRoot}").',
    confirmMismatchHint: 'Yıkıcı işlemi onaylamak için klasör adını birebir verin.',
    confirmedByFlag: '--confirm ile onaylandı: {appRoot}',
    summaryTitle: 'DEPLOY ONAYI',
    summaryTitleDestructive: 'DEPLOY ONAYI · ÜZERİNE YAZILACAK',
    sLocalProject: 'Yerel proje',
    sFramework: 'Framework',
    sStartup: 'Başlangıç',
    sStartupCreated: ' (oluşturuldu)',
    sServer: 'Sunucu',
    sAccount: 'cPanel hesabı',
    sDomain: 'Domain',
    sNewSubdomain: '  [YENİ SUBDOMAIN]',
    sDocroot: 'Belge kökü',
    sDocrootAuto: '(cPanel belirler)',
    sApp: 'Uygulama',
    sNew: '  [YENİ]',
    sPackage: 'Paket',
    sPackageValue: '{files} dosya · {size}',
    sUrl: 'Adres',
    sEnvExcluded: 'Pakete GİRMEYECEK ortam dosyaları: {list}',
    sOthers: 'Bu hesapta dokunulmayacak diğer uygulamalar:',
    excludedTitle: 'Hariç tutulanlar',
    excludedItem: '{count} öğe · {size}',
    stepsTitle: 'Yapılacaklar',
    stepBuild: 'npm run build  (yerelde)',
    stepZip: 'zip → Fileman::upload_files',
    stepBackup: 'yedek: fileop copy  ~/{appRoot} → ~/{dir}/{appRoot}-<zaman>',
    stepClean: 'temizlik: fileop unlink  ~/{appRoot}/* (node_modules, tmp ve korunanlar hariç)',
    stepExtract: 'fileop extract  → ~/{appRoot}',
    stepMarker: '{file} yazılır (sahiplik işareti)',
    stepRestart: 'tmp/restart.txt güncellenir + ~11 sn beklenir + uygulamaya HTTP GET',
  },

  probe: {
    webappAvailable: 'WebApp API mevcut (cPanel 138+)',
    passengerResponded: 'PassengerApps yanıt verdi ({count} uygulama)',
    venvSeen: 'CloudLinux venv yolu görüldü: {path}',
    nodePath: 'Node yolu: {path}',
    passengerUnavailable: 'PassengerApps kullanılamıyor: {error}',
    nodevenvDir: '~/nodevenv dizini var',
    assumedStock: 'CloudLinux izi yok, stok cPanel Application Manager varsayıldı',
    featureOn: 'passengerapps özelliği açık ama liste alınamadı',
    featureOff: 'passengerapps özelliği kapalı',
    selectorApps: 'node-selector.json: {count} uygulama',
  },

  ui: {
    title: 'cpanel-next · arayüz',
    running: 'Arayüz çalışıyor',
    address: 'Adres',
    bound: 'Dinlenen',
    security:
      'Sunucu yalnızca bu bilgisayardan erişilebilir (127.0.0.1) ve adresteki ' +
      'jeton olmadan hiçbir istek kabul edilmiyor. cPanel token\'ınız tarayıcıya gönderilmiyor.',
    stop: 'Durdurmak için Ctrl+C.',
    stopped: 'Arayüz durduruldu.',
  },

  regime: {
    cloudlinux: 'CloudLinux Node.js Selector',
    passenger: 'cPanel Application Manager',
    unknown: 'bilinmiyor',
  },
};
