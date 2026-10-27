# Client fork (ssevban/Mailspring) için gereken değişiklikler

Bu dosya sadece liste ve öneri. Client kodu bu session'da değiştirilmedi.

Referans: ssevban/Mailspring `6c884a6` (2026-10-25). Aşağıdaki dosyalar upstream Foundry376/Mailspring `4e6ae2b` ile byte byte aynı, satır numaraları ikisi için de geçerli. Yollar `app/` altına göredir.

Hedef host'lar (`docs/compat.md` ve `deploy/Caddyfile` ile aynı):

```text
id.<DOMAIN>     identity + metadata + deltas + onboarding/dashboard   (rootURLForServer, IDENTITY_SERVER)
link.<DOMAIN>   /o/ /open/ /link/                                    (open/link tracking PLUGIN_URL)
share.<DOMAIN>  /thread/ /page/ /asset/ /signature-assets/           (backend SHARE_URL)
```

`<DOMAIN>` = senin domain'in. Aşağıdaki diff'lerde `example.com` yerine onu yaz.

## 1. Zorunlu (backend'e bağlı)

### 1.1 identity root: `src/flux/mailspring-api-request.ts:43-47`

Sadece `production` değerini değiştir. `env` kontrolü ve development/staging kalsın (`config.json`'daki `"env": "production"` başka yerlerde de okunuyor, irfanMiral client fork'u onu silmiş, onu alma).

```ts
      production: 'https://id.example.com',
```

Etkisi: tüm `makeRequest` çağrıları, onboarding webview (`onboarding/lib/page-authenticate.tsx:11`), SSO linkleri, views client'ları ve sync engine. Sync engine ayrıca ayar istemiyor: `src/mailsync-process.ts:219-220` `IDENTITY_SERVER` env'ini bundan set ediyor, Mailspring-Sync `NetworkRequestUtils.cpp:588` bunu okuyor.

Alternatif: nichovski/Mailspring PR #3 (`8156e17`, `8383d7f`) `MAILSPRING_IDENTITY_SERVER` env override'ı ekliyor. Ama tracking URL'lerini de AYNI host'a yönlendiriyor (identity ile link aynı host). Bu deploy'da tracking `link.` host'unda, id host'unda `/o/ /open/ /link/` 404. O PR'ı alırsan ya tek host'a geçmen ya da PR'ı tracking için ayrı env alacak şekilde değiştirmen lazım. Kendi build'ini zaten alacağın için hardcode daha az kod.

### 1.2 tracking PLUGIN_URL: iki `package.json`

`internal_packages/open-tracking/package.json:8` ve `internal_packages/link-tracking/package.json:8`:

```json
    "production": "https://link.example.com"
```

Etkisi: `open-tracking-composer-extension.ts:66` (`/o/<token>.png`) ve `link-tracking-composer-extension.ts:75` (`/link/...`). Bu değerler build'e gömülür; gönderilmiş maillerdeki URL'ler sonradan değişmez, domain'i bir kere seç.

### 1.3 kendi pixel'ini sayma: `internal_packages/remove-tracking-pixels/lib/main.ts:174-195`

Bu fonksiyon gelen mailin body'sinden, mevcut hesaba ait read-receipt pixel'ini siler (reply, forward, bounce içinde senin pixel'in duruyorsa onu açınca kendi open'ını saymasın diye).

- eski format, satır 175: `getmailspring.com/open/${accountId.toUpperCase()}`. Bu kontrol aslında hiç tutmuyor (eski URL `/open/<headerMessageId>?me=<accountId>`, path'te accountId yok) ama satır 176'daki `me=${encodeURIComponent(accountId)}` host'tan bağımsız yakalıyor. Değiştirmesen de eski format korunur.
- yeni format, satır 183: `imageURL.includes('getmailspring.com/o/')`. DEĞİŞMEZSE: senin domain'indeki `/o/` pixel'i hiç yakalanmaz, kendi gönderdiğin maile gelen reply'ı, forward'ı veya bounce'u açtığında alıcı açmış gibi `open_count` artar.

Minimum değişiklik:

```ts
    if (imageURL.includes('link.example.com/o/')) {
```

Satır 175 için de aynı host'u yazmak tutarlılık için yeterli (`link.example.com/open/`).

### 1.4 thread sharing URL: `internal_packages/thread-sharing/lib/main.tsx:48`

```ts
  return `https://share.example.com/thread/${identity.id}/${metadata.key}`;
```

Değişmezse "share thread" linki `shared.getmailspring.com`'a gider, orada senin datan yok. Backend route'u `/thread/<identityId>/<key>`, aynı şekil. `thread-sharing/package.json:4-7`'deki `serverUrl` kodda okunmuyor (grep: 0 kullanım), değiştirmen gerekmiyor.

### 1.5 auto-update: `src/browser/autoupdate-manager.ts`

Fork build'inde açık kalırsa: `updates.getmailspring.com/check/<platform>/<arch>/<version>/<identity.id>/stable` (satır 47-67) her 30 dk'da bir sorgulanır, resmi sürüm bulunursa indirip senin build'inin üstüne kurar (Windows Squirrel, macOS). Linux'ta `autoupdate-impl-base.ts` feed'i kendisi sorguluyor ve "update available" bar'ı gösteriyor, kurulum yerine dönen URL'i açıyor (`autoupdate-impl-base.ts:46-80`). Ayrıca identity id'n Foundry376'ya gider.

En küçük güvenli değişiklik iki satır:

```ts
  setupAutoUpdater() {
    this.setState(UnsupportedState);
    return;
```

ve `check()` (satır 165) başına:

```ts
    if (!autoUpdater) return;
```

İkinci satır şart: sadece `setupAutoUpdater`'dan `return` edersen (irfanMiral client fork'u böyle yapmış, `485584d`) `autoUpdater` null kalır ve menüden "Check for Updates" (`src/browser/application.ts:532`) `autoUpdater.checkForUpdates()`'te TypeError atar. `updateFeedURL` (constructor) sadece string kuruyor, network'e çıkmıyor, kalabilir.

### 1.6 signature ikonları: `internal_packages/composer-signature/lib/templates.tsx:8-61`

`https://www.getmailspring.com/signature-assets/*.gif` hardcode. Bunlar gönderdiğin maillerin içine gömülüyor; değişmezse alıcı her açışta Foundry376 sunucusundan resim çeker. Backend artık `share.<DOMAIN>/signature-assets/` altında serve ediyor:

```ts
    src="https://share.example.com/signature-assets/fb.gif"
```

DİKKAT: satır 44 `twitter.gif` istiyor, backend'de `twitter.png` var (irfanMiral X ikonuyla değiştirmiş). Ya client'ta `twitter.png` yaz ya backend'e `twitter.gif` ekle.

## 2. getmailspring.com geçen diğer yerler

Docs/community/support linkleri hariç (`/docs/*`, `community.getmailspring.com`, `support@`, `getmailspring.com/pro`, `getmailspring.com/download`).

| dosya:satır | ne | backend'e bağlı mı | etkisi / öneri |
|---|---|---|---|
| `src/regexp-utils.ts:230-232` `trackedLinkRegex` | `link.getmailspring.com/link/...redirect=` regex'i | hayır | KULLANILMIYOR: repo genelinde tek referans kendi tanımı (grep, specs dahil). Dead code, değiştirmesen de etkisi yok. Tutarlılık için host'u güncelleyebilirsin |
| `src/error-logger.js:165` | Electron crashReporter `https://id.getmailspring.com/report-crash`, `autoSubmit: true` | evet (resmi id server) | native crash dump'ları Foundry376'ya gider. Kapatmak için `_startCrashReporter` (satır 158) gövdesini `return;` ile bitir. Backend'de `/report-crash` yok |
| `src/error-logger-extensions/sentry-error-reporter.js:7` | Sentry DSN (`sentry.io`) | hayır (Sentry) | `ErrorLogger` her zaman `SentryErrorReporter` kuruyor (`src/error-logger.js:42-46`), JS hataları Foundry376'nın Sentry projesine gidebilir. Hangi koşulda gerçekten gönderdiğini (dev/spec mode, opt-out ayarı) incelemedim, DOĞRULANMADI. Kapatmak istersen o extension'ı listeden çıkar |
| `internal_packages/onboarding/lib/oauth-signin-page.tsx:142` | Gmail/O365 OAuth bittikten sonra tarayıcıyı `https://id.getmailspring.com/oauth/finished`'a yönlendirir | sadece görsel | token exchange local'de (`onboarding-helpers.ts:329, 421`), auth çalışır. Sadece tarayıcıda resmi "bitti" sayfası açılır. İstersen `https://id.example.com/` yap |
| `internal_packages/composer-signature/lib/constants.ts:128` | `https://logo.getmailspring.com/company-logo/<domain>` | evet (resmi logo servisi) | "company logo" seçilirse imzaya gömülür, alıcılar Foundry376'dan çeker. Backend'de karşılığı yok |
| `internal_packages/composer-signature/lib/signature-photo-picker.tsx:159` | `resolvedURL.includes('getmailspring.com')` | hayır | sadece upload edilen fotoğrafın URL input'unu gizleyip gizlememe kararı. Upload'lar artık `share.<DOMAIN>/asset/...` olacağı için input görünür kalır, kozmetik |
| `src/browser/autoupdate-manager.ts:62-64` | update feed | evet | bkz. 1.5 |
| `src/browser/autoupdate-impl-base.ts:6` | download sayfası fallback | hayır | 1.5 yapılınca kullanılmaz |
| `src/flux/stores/draft-factory.ts:66` | `headerMessageId = <UUID>@getmailspring.com` | hayır | sadece Message-ID domain'i. Backend bunu opaque string olarak saklıyor. Değiştirmek zorunlu değil |
| `src/flux/stores/signature-store.ts:49` | default imzadaki "Mailspring" linki | hayır | kozmetik |
| `src/browser/application.ts:1125` | yorum: `getmailspring.com/v/<shareId>` | hayır | Views paylaşım landing sayfası resmi tarafta, backend'de `/api/views/*` yok |
| `src/flux/mailspring-api-request.ts:45` | staging identity | hayır | production build'de okunmaz |
| `open-tracking/package.json:7`, `link-tracking/package.json:7`, `thread-sharing/package.json:6` | staging URL'leri | hayır | production build'de okunmaz |
| `thread-sharing/package.json:7` | `share.getmailspring.com` | hayır | kodda okunmuyor |
| `internal_packages/views/specs/view-sharing-spec.ts` | test | hayır | |
| `src/mailsync-process.ts:35, 82`, `src/key-manager.ts:228, 234`, `package-manager.ts:143, 258`, `application.ts:506-516`, preferences/onboarding/templates/activity/thread-search linkleri | docs/community | hayır | |

Ek bilgi:
- Mailspring-Sync (`mailsync` binary) içinde getmailspring.com geçen yerler: `main.cpp:132` (usage metni), `MailUtils.cpp:945` (IMAP ID `support-email`), `MailProcessor.cpp:878` (spam heuristiği). Hiçbiri network çağrısı değil. Sync engine'in tek backend bağlantısı `IDENTITY_SERVER`.
- Prebuilt `mailsync` binary'si `npm install` postinstall'da S3'ten iniyor (CONTRIBUTING.md 98-108). Değiştirmen gerekmiyor, host'u env'den alıyor.

## 3. Build

Upstream CONTRIBUTING.md (60-95) ve `app/build/build.js` (547-563) baz alındı. Node v20 LTS öneriliyor (CI), minimum v16.17 / npm 8.

Linux (deb + rpm üretir):

```bash
sudo apt-get install libx11-dev libxkbfile-dev execstack libgconf-2-4 libsecret-1-dev rpm   # Debian/Ubuntu
git clone https://github.com/ssevban/Mailspring && cd Mailspring
# 1.1 - 1.6 değişikliklerini uygula
npm ci
npm run build
# çıktı: app/dist/mailspring-<version>-<arch>.deb ve app/dist/rpm altında .rpm
```

Windows:

```powershell
npm install --global --production windows-build-tools   # ya da VS Build Tools + Python
git clone https://github.com/ssevban/Mailspring; cd Mailspring
# 1.1 - 1.6 değişikliklerini uygula
npm ci
npm run build
# çıktı: app\dist\mailspring-win32-x64\  (çalıştırılabilir klasör)
```

Windows installer (`app/build/create-signed-windows-installer.js`) `WINDOWS_SIGNTOOL_PATH` yoksa `process.exit(1)` yapıyor (satır 99-101), yani Squirrel installer imza sertifikası olmadan üretilmiyor. İmzasız kullanım için `app\dist\mailspring-win32-x64\` klasörünü olduğu gibi kullan. Squirrel ile kurulmamış bir klasörde Windows auto-update'in ne yaptığını test etmedim; 1.5'i yine de uygula.

`--skip-installers` sadece paketlenmiş klasörü üretir (her iki platform).

Bu build adımlarını bu session'da çalıştırmadım. Platform tercihin (Windows/Linux) prompt'ta doldurulmamıştı, ikisini de yazdım.

## 4. Doğrulama (build sonrası)

1. Preferences > Subscription > Sign in: webview `https://id.<DOMAIN>/onboarding` açmalı, `manage.js user add` ile oluşturduğun kullanıcıyla login.
2. Hesap ekle, mailsync log'unda `Metadata delta stream starting...` görünmeli (`MetadataWorker.cpp:143`).
3. Read receipt + link tracking açık bir mail gönder, gönderilen mailin kaynağında `https://link.<DOMAIN>/o/...png` ve `https://link.<DOMAIN>/link/...` olmalı.
4. Alıcı tarafında aç/tıkla, gönderen client'ta birkaç saniye içinde "opened"/"clicked" görünmeli.
5. Gönderdiğin maile gelen reply'ı aç: open sayısı ARTMAMALI (1.3).
