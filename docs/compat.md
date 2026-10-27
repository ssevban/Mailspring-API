# Mailspring client/sync engine <-> self-hosted backend uyumluluk raporu

Tarih: 2026-10-27

## 0. Güncel durum (aşağıdaki bölümlerden önce bunu oku)

- Deploy tek host: `link.example.com`, host'taki nginx arkasında (`deploy/nginx.conf`). Bu raporda geçen id./link./share. ayrımı ve Caddy iptal; Caddyfile silindi.
- Thread paylaşımı ve paylaşılan aktivite sayfaları kullanılmıyor: `/thread/` ve `/page/` nginx'te 404.
- `/link`: alıcıya hiçbir durumda ara sayfa gösterilmiyor (bkz. §6).
- Dockerfile multi-stage: derleme araçları (python3, make, g++) sadece build stage'de, runtime image'da node + production `node_modules` (44 MB) + uygulama dosyaları var.


Referans commit'ler (bu rapordaki tüm `dosya:satır` referansları bunlara göre):

| repo | commit | tarih |
|---|---|---|
| Foundry376/Mailspring (client) | `4e6ae2b60d92` | 2026-10-27 |
| ssevban/Mailspring (client fork) | `6c884a6` | 2026-10-25, upstream'e göre kendi commit'i yok; aşağıdaki dosyaların hepsi upstream ile byte byte aynı (cmp ile kontrol edildi) |
| Foundry376/Mailspring-Sync (C++ sync engine) | `5b8f6bdb3760` | 2026-10-26 |
| 1RandomDev/mailspring-api | `36682a9` (v1.2.0) | 2023-03-07 |
| irfanMiral/Mailspring-API | `d6fab11` | 2026-09-28 |
| bu repo (fix'ler sonrası) | `selfhost-compat` branch | |

Client yolları `app/` altına göredir. Sync engine yolları `MailSync/` altına göredir.

## 1. Client + sync engine endpoint envanteri

### 1.1 Base URL'ler

| ne | değer (production) | kaynak |
|---|---|---|
| identity root | `https://id.getmailspring.com` (development: `http://localhost:5101`, staging: `https://id-staging.getmailspring.com`) | `src/flux/mailspring-api-request.ts:35-50` |
| sync engine `IDENTITY_SERVER` | `rootURLForServer('identity')` (sadece renderer'dan spawn edilen mailsync için; main process'te `'unknown'`) | `src/mailsync-process.ts:216-221`, okuma: `NetworkRequestUtils.cpp:587-588` |
| open tracking `PLUGIN_URL` | `https://link.getmailspring.com` | `internal_packages/open-tracking/package.json:5-9`, `open-tracking/lib/open-tracking-constants.ts:5` |
| link tracking `PLUGIN_URL` | `https://link.getmailspring.com` | `internal_packages/link-tracking/package.json:5-9`, `link-tracking/lib/link-tracking-constants.ts:5` |
| thread sharing public URL | `https://shared.getmailspring.com/thread/<identity.id>/<key>` HARDCODE | `internal_packages/thread-sharing/lib/main.tsx:48` |
| thread-sharing `serverUrl` | `https://share.getmailspring.com` | `internal_packages/thread-sharing/package.json:4-7`; `lib/` altında okunmuyor (grep: 0 kullanım) |

### 1.2 Auth

- client: `Authorization: Basic base64("<token>:")`, `Accept: application/json`, body varsa JSON ya da FormData. `src/flux/mailspring-api-request.ts:111-124`
- non-2xx -> `APIError` (statusCode set), JSON parse edilemeyen 2xx -> `APIError`. `src/flux/mailspring-api-request.ts:135-147`
- sync engine: aynı Basic header. `NetworkRequestUtils.cpp:587-600`. 2xx dışı -> `SyncException`, 401/403 retry edilmez. `NetworkRequestUtils.cpp:341-364`
- views client'ı kendi `requestJSON`'unu kullanıyor, auth aynı helper'dan. `internal_packages/views/lib/agent/client.ts:129-153`

### 1.3 Identity server endpoint'leri (client)

| method | path | request | client'ın okuduğu response | hata davranışı | kaynak |
|---|---|---|---|---|---|
| GET | `/api/me` | yok | `{id, firstName, lastName, emailAddress, stripePlan, stripePlanEffective, featureUsage{<feature>:{quota, period, usedInPeriod, featureLimitName}}}`; `id` yoksa reportError | ağ hatası: eski identity korunur, 10 dk'da bir poll | `src/flux/stores/identity-store.ts:16-32, 235-267, 100-101` |
| POST | `/api/login-link?utm_*` | FormData: `utm_medium`, `utm_source`..., `next_path` | `{path}` -> `${root}${path}` açılır | hata olursa `${root}${path}` açılır | `src/flux/stores/identity-store.ts:174-223` |
| POST | `/api/save-public-asset` | FormData: `filename`, `file` (Blob) | `{link}` | throw | `src/flux/mailspring-api-request.ts:52-73`; kullananlar `thread-sharing/lib/main.tsx:106,121,148`, `composer-signature/lib/signature-photo-picker.tsx:130` |
| POST | `/api/share-static-page` | JSON `{key, html}`, timeout 1500 | `{link}` | throw | `src/flux/mailspring-api-request.ts:75-85`; kullanan `activity/lib/dashboard/share-button.tsx:78` |
| POST | `/api/translate` | JSON `{lang, text, format:'html'}`, `text` = `<b>..</b>` paragrafları | `{result}` (html, `<b>` elemanları sırayla okunur) | hata dialog'u | `internal_packages/translation/lib/service.ts:239-261` |
| GET | `/api/info-for-email-v2/<email>?phrase=<name>` | yok | `{person, company}` | "we don't care about errors": `{}` döner | `internal_packages/participant-profile/lib/participant-profile-data-source.ts:34-48` |
| POST | `/api/grammar/check` | JSON `{messageId, text, language}` | LanguageTool `/v2/check` şekli: `matches[].{offset,length,message,shortMessage,replacements[].value,rule{id,description,issueType,category{id,name}},sentence,context{text,offset,length}}` | 400 -> UsageExceededError, 429/502 -> geçici hata | `internal_packages/composer-grammar-check/lib/grammar-check-service.ts:121-166` |
| GET/POST/DELETE | `/api/newsletter/first-account/<email>?name=<name>` | yok | `{status}`; GET'te `'Never Subscribed'` ise POST'a geçer | hata -> UI state `'Error'` | `internal_packages/onboarding/lib/newsletter-signup.tsx:58-105` |
| GET (webview) | `/onboarding?version=..&skipSupported=true` | cookie | HTML; `#identity-result` innerText = base64(JSON identity ya da `{skipped:true}`) | | `internal_packages/onboarding/lib/page-authenticate.tsx:10-27` |
| GET (browser) | `/payment`, `/dashboard`, `/dashboard#billing` | login-link üzerinden | HTML | | `src/components/feature-used-up-modal.tsx:49`, `internal_packages/preferences/lib/tabs/preferences-identity.tsx:225,267,423` |
| POST | `/api/views/agent/sessions` (+ `/<viewId>/messages`, `/tool-results`, `/interrupt`, `/budget`) | JSON | zod şemaları | `AgentAPIError` | `internal_packages/views/lib/agent/client.ts:166-189` |
| GET | `/api/views/agent/sessions/<viewId>/events` | SSE | event stream | 4xx -> kalıcı hata | `internal_packages/views/lib/agent/client.ts:197-245` |
| GET | `/api/views/agent/usage` | | | | `internal_packages/views/lib/agent/client.ts:192-194` |
| POST/DELETE/GET | `/api/views/share`, `/api/views/share/<id>`, `/api/views/shares?viewId=`, `/api/views/shared/<id>` (auth'suz), `/api/views/shared/<id>/install` | JSON | zod şemaları | `AgentAPIError` | `internal_packages/views/lib/sharing/client.ts:132-159` |

Identity root'a giden ama makeRequest olmayan:
- `evented-iframe.tsx:228-230`: identity root'a giden linkleri SSO URL'ine çeviriyor.
- `webview.tsx:57`: hata mesajında root URL.

getmailspring.com'a HARDCODE giden, backend'e bağlı çağrılar (rootURLForServer'dan geçmiyor):
- `src/error-logger.js:165`: crash reporter `https://id.getmailspring.com/report-crash`, `autoSubmit: true`
- `internal_packages/onboarding/lib/oauth-signin-page.tsx:142`: OAuth sonrası tarayıcı `https://id.getmailspring.com/oauth/finished`'a redirect
- `internal_packages/thread-sharing/lib/main.tsx:48`: `https://shared.getmailspring.com/thread/...`
- `internal_packages/composer-signature/lib/templates.tsx:8-61`: `https://www.getmailspring.com/signature-assets/*.gif`
- `internal_packages/composer-signature/lib/constants.ts:128`: `https://logo.getmailspring.com/company-logo/<domain>`
- `src/browser/autoupdate-manager.ts:62-67`: `https://updates.getmailspring.com/check/<platform>/<arch>/<version>/<identity.id>/<channel>`

Detay ve önerilen client değişiklikleri: `docs/client-changes.md`.

### 1.4 Feature usage / limitler

- Limitler client'ta hesaplanmıyor, `/api/me` cevabındaki `featureUsage` objesinden geliyor. DOĞRULANDI: `src/flux/stores/feature-usage-store.tsx:152-168` (dosya başı yorumu 20-56) `IdentityStore.identity().featureUsage[feature]` okuyor.
- `quota` falsy ise feature serbest (`isUsable` -> true). `featureUsage[feature]` yoksa `EMPTY_FEATURE_USAGE` (quota 0) -> serbest. `feature-usage-store.tsx:112-118, 159-166`, `identity-store.ts:36-41`
- `hasProFeatures()` = `stripePlanEffective !== 'Basic'`. `identity-store.ts:86-88`
- `markUsed`: local `usedInPeriod += 1`, sonra `contact-profiles` ve `translation` hariç `SendFeatureUsageEventTask` kuyruğa girer. `feature-usage-store.tsx:128-139`
- `SendFeatureUsageEventTask` sync engine'de `POST /api/feature_usage_event` body `{feature}`. `TaskProcessor.cpp:2821-2833`

### 1.5 Sync engine (Mailspring-Sync) endpoint'leri

| method | path | request | beklenen response | kaynak |
|---|---|---|---|---|
| GET | `/ping` | yok | sadece diagnostic; "any HTTP response code means curl and SSL worked", 404 de OK | `main.cpp:641-660` |
| GET | `/metadata/<aid>?limit=500&offset=<500*page>` | | JSON array, her eleman `{object_type, object_id, aid, plugin_id, v (uint), value}`; `size == 500` ise sonraki sayfa | `MetadataWorker.cpp:89-96`, parse `MailStore.cpp:38-47` |
| GET | `/deltas/<aid>/head` | | `{cursor}` (number ya da string) | `MetadataWorker.cpp:98-109` |
| GET | `/deltas/<aid>/streaming?p=<platform>&ih=<imapHost>&cursor=<c>` | HTTP/1.1 zorunlu | newline-delimited JSON; `{object:'metadata', cursor:string, attributes:<metadata objesi>}` ya da `{object:'backend-event', event:'identity-refresh-needed'}`; `pos > 1` olmayan satırlar heartbeat; 30 sn boyunca <1 byte/sn gelirse bağlantı kapanır | `MetadataWorker.cpp:111-201` |
| POST | `/metadata/<aid>/<modelId>/<pluginId>` | JSON `{objectType, version, value, headerMessageId?}` | 2xx yeter, body okunmuyor | `TaskProcessor.cpp:1971-1993` |
| POST | `/api/feature_usage_event` | JSON `{feature}` | 2xx | `TaskProcessor.cpp:2821-2833` |
| POST | `/api/resolve-dav-hosts` | JSON (identity yoksa auth'suz) | `{caldavHost, carddavHost}` | `DAVWorker.cpp:519, 596-597` |

Versiyon semantiği: local `upsertMetadata` versiyonu artırıp POST'ta gönderir (`TaskProcessor.cpp:1959-1960, 1983`). Gelen metadata `v <= local v` ise yok sayılır (`Models/MailModel.cpp:76-91`). Yani server asla client'ın gönderdiğinden düşük `v` tutmamalı.

### 1.6 Tracking URL'leri (public, tarayıcı/mail client'ı çağırır)

| ne | URL | kaynak |
|---|---|---|
| open (yeni) | `${PLUGIN_URL}/o/<token>.png`, token = base64url(JSON `{messageId: headerMessageId, accountId, recipient?}`), padding'siz | `open-tracking/lib/open-tracking-composer-extension.ts:17-25, 55-66` |
| open (eski) | `/open/<headerMessageId>?me=<accountId>&recipient=<base64>` (eski client'lar; mevcut client'ta sadece remove-tracking-pixels tanıyor) | `remove-tracking-pixels/lib/main.ts:174-179` |
| link | `${PLUGIN_URL}/link/<headerMessageId>/<index>?redirect=<encodeURIComponent(url)>&recipient=<encodeURIComponent(btoa(email))>`; `recipient` sadece per-recipient body'de var | `link-tracking/lib/link-tracking-composer-extension.ts:74-85` |

- `recipient` yoksa (`shared_body`, Microsoft Graph ile gönderen hesaplar) open token'da `recipient` alanı yok, link'te `&recipient=` yok. `open-tracking/lib/types.ts`, `link-tracking/lib/types.ts`, composer extension'larda `metadata.shared_body = true`.
- metadata value şekli: open `{open_count, open_data[{timestamp, recipient}], uid, shared_body?}` (`open-tracking-button.tsx:38`, extension `:84`), link `{tracked, uid, links[{url, click_count, click_data[], redirect_url}], shared_body?}` (`link-tracking-button.tsx:38`, extension `:77-94`).
- gönderilen mesajın metadata'sı: sent message local'e sync edildikten sonra `SyncbackMetadataTask` (message, `modelHeaderMessageId` ile) -> ilk upsert, `v=1`. `TaskProcessor.cpp:2787-2818`

## 2. Backend route'ları

### 2.1 1RandomDev/mailspring-api v1.2.0 (`index.js`)

| method | path | satır | not |
|---|---|---|---|
| GET | `/` | 82 | static index |
| GET | `/open/.+` | 85 | `recipient` yoksa `Buffer.from(undefined)` throw (90) |
| GET | `/link/.+/.+` | 112 | önce koşulsuz `res.redirect(redirect)`, sonra sayım |
| GET | `/page/.+`, `/asset/.+`, `/thread/.*/.*` | 148, 160, 173 | |
| GET | `/dashboard` | 198 | static index'e redirect |
| GET | `/onboarding` | 201 | |
| POST | `/login` | 210 | |
| POST | `/api/resolve-dav-hosts` | 234 | id.getmailspring.com'a proxy |
| POST | `/api/feature_usage_event` | 243 | no-op |
| GET | `/api/me` | 247 | |
| POST | `/api/share-static-page` | 255 | |
| POST | `/api/save-public-asset` | 273 | |
| POST | `/api/translate` | 318 | google-translate (unofficial) |
| POST | `/metadata/<aid>/<id>/<plugin>` | 346 | |
| GET | `/metadata/<aid>` | 406 | |
| GET | `/deltas/<aid>/head`, `/deltas/<aid>/streaming` | 418, 424 | |

Yok: `/o/<token>.png`, `/api/login-link`, `/api/grammar/check`, `/ping`, `/api/newsletter/*`, `/api/info-for-email-v2/*`, `/api/views/*`, `/signature-assets/*`. Ayrıca `manage.js` ESM projede `require()` kullanıyor, hiç çalışmıyor; `better-sqlite3@^8` güncel Node'da derlenmiyor (irfanMiral CHANGES.md; ben `manage.js`'in irfanMiral'daki ESM halini test sırasında çalıştırdım, 1RandomDev halini çalıştırmadım).

### 2.2 irfanMiral/Mailspring-API `d6fab11`

| method | path | satır (d6fab11) | not |
|---|---|---|---|
| GET | `/`, `/robots.txt` | 110, 113 | |
| GET | `/signature-assets/<name>.(gif\|png)` | 116 | `twitter.png` var, client `twitter.gif` istiyor -> 404 |
| GET | `/open/.+` | 154 | `recipient` opsiyonel, path decode edilmiyor |
| GET | `/o/<token>.png` | 168 | try/catch var, alan tipleri kontrol edilmiyor |
| GET | `/link/.+/.+` | 181 | koşulsuz redirect (open redirect), `recipient` yoksa throw -> click sayılmıyor, `links['__proto__']` |
| GET | `/page/.+`, `/asset/.+`, `/thread/.*/.*` | 217, 229, 242 | thread-sharing.ejs'te `<%- JSON.stringify(data) %>` |
| GET | `/dashboard`, POST `/dashboard/change-password`, `/dashboard/sessions/revoke`, `/dashboard/logout` | 267, 286, 323, 340 | cookie session |
| GET | `/onboarding`, POST `/login` | 349, 358 | cookie flag'siz |
| POST | `/api/resolve-dav-hosts` | 382 | DNS SRV, auth'suz |
| POST | `/api/feature_usage_event` | 398 | no-op |
| GET | `/api/me` | 402 | |
| POST | `/api/share-static-page`, `/api/save-public-asset` | 410, 428 | |
| POST | `/api/translate` | 473 | |
| POST | `/api/grammar/check` | 499 | LanguageTool proxy |
| POST | `/api/login-link` | 525 | `{path: next_path}` |
| POST/GET | `/metadata/...` | 533, 593 | create'te `v=1` sabit, update'te `v++` |
| GET | `/deltas/<aid>/head`, `/streaming` | 605, 611 | |

## 3. Uyumluluk matrisi

"bu repo" kolonu fix'ler sonrası durum, testler `test/compat.test.js`.

| endpoint | client kullanıyor mu | 1RandomDev | irfanMiral | bu repo | eksik/uyumsuz detay |
|---|---|---|---|---|---|
| GET `/api/me` | evet | var | var | var, test edildi | |
| POST `/login`, GET `/onboarding` | evet (webview) | var | var | var, test edildi | irfanMiral: cookie HttpOnly/Secure/SameSite yok. düzeltildi |
| POST `/api/login-link` | evet | YOK (404 -> client `${root}${path}` açar) | var | var | |
| GET `/dashboard` | evet (browser) | static redirect | gerçek sayfa | aynı | |
| GET `/payment` | evet (browser) | YOK | YOK | YOK | 404 sayfası; quota zaten 1000/hafta ve `usedInPeriod` her `/api/me` poll'unda 0'a döner, modal pratikte çıkmaz |
| POST `/api/feature_usage_event` | evet (sync engine) | no-op | no-op | no-op | |
| POST `/api/save-public-asset` | evet | var | var | var, test edildi | |
| POST `/api/share-static-page` | evet | var | var | var | client artık `key` gönderiyor, backend yok sayıyor ve kendi key'ini üretiyor; client sadece dönen `link`'i kullanıyor -> uyumlu |
| GET `/metadata/<aid>` | evet (sync) | var | var | var, test edildi | |
| POST `/metadata/<aid>/<id>/<plugin>` | evet (sync) | var | var | var, test edildi | ikisinde de `v` client'tan bağımsız (create=1, update=v+1). client'ta local `v` daha yüksekse server'dan gelen değişiklikler yok sayılır (`MailModel.cpp:85`). düzeltildi |
| GET `/deltas/<aid>/head` | evet (sync) | var | var | var, test edildi | |
| GET `/deltas/<aid>/streaming` | evet (sync) | var | var | var, test edildi (direkt ve Caddy arkasında) | heartbeat 16x`\n` / 10 sn, sync engine'in 30 sn low-speed limit'iyle uyumlu |
| GET `/ping` | sadece diagnostic | YOK | YOK | YOK | 404 da "HTTP OK" sayılıyor (`main.cpp:654`), gerek yok |
| POST `/api/resolve-dav-hosts` | evet (sync) | id.getmailspring.com proxy | DNS SRV | aynı | |
| GET `/o/<token>.png` | evet | YOK (yeni client'ın tüm open'ları 404) | var | var, test edildi | irfanMiral: token alanlarının tipi kontrol edilmiyor. düzeltildi |
| GET `/open/<hmid>?me=&recipient=` | eski client'lar | var (`recipient` yoksa throw) | var | var, test edildi | path percent-decode edilmiyordu (`%40`). düzeltildi |
| GET `/link/<hmid>/<i>?redirect=&recipient=` | evet | var | var | var, test edildi | ikisinde de: `recipient` yoksa (shared_body) click sayılmıyor, open redirect, `__proto__` index. düzeltildi |
| GET `/thread/<identityId>/<key>` | evet (public, client URL'i hardcode) | var | var | var, test edildi | `</script>` XSS. düzeltildi. template CSS/JS'i `shared.getmailspring.com`'dan yüklüyor (aşağıda açık konular) |
| GET `/page/<key>`, `/asset/<key>.<ext>` | evet (public) | var | var | var | kullanıcı HTML'i/dosyası serve ediyor, ayrı origin şart (Caddy'de share host'una kısıtlandı) |
| GET `/signature-assets/*` | evet (client hardcode `www.getmailspring.com`) | YOK | var | var | client değişmeden kullanılmaz; `twitter.gif` yok (`twitter.png` var) |

Kullanılmayan / ücretli endpoint'ler:

| endpoint | 1RandomDev | irfanMiral | bu repo | stub mu 404 mü | client davranışı (kaynak) |
|---|---|---|---|---|---|
| POST `/api/translate` | var (Google unofficial) | var | var | gerçek implementasyon | hata olursa dialog (`translation/lib/service.ts:247-256`). metin Google'a gidiyor |
| POST `/api/grammar/check` | YOK | var (LanguageTool proxy) | var | gerçek implementasyon | 404 olursa throw, 400 -> "quota exceeded" (`grammar-check-service.ts:132-145`). default `api.languagetool.org`, compose edilen metin dışarı gidiyor; `LANGUAGETOOL_URL` ile self-host önerilir |
| GET `/api/info-for-email-v2/<email>` | YOK | YOK | YOK | 404 bırakıldı | `{}` döner, sessiz (`participant-profile-data-source.ts:39-42`) |
| `/api/newsletter/first-account/*` | YOK | YOK | YOK | 404 bırakıldı | onboarding'de status `'Error'` (`newsletter-signup.tsx:82-84, 96-98`); fonksiyonel etkisi yok |
| `/api/views/agent/*` | YOK | YOK | YOK | 404 bırakıldı | AI authoring proxy (Mailspring'in kendi LLM proxy'si, request/response şeması zod ile `views/lib/agent/client.ts` içinde). implement etmek ayrı bir LLM backend'i demek, kapsam dışı. `AgentAPIError`, views authoring çalışmaz |
| `/api/views/share*`, `/api/views/shared/*` | YOK | YOK | YOK | 404 bırakıldı | `AgentAPIError`, View paylaşma/yükleme çalışmaz. paylaşım landing sayfası da `getmailspring.com/v/<id>` (`src/browser/application.ts:1125`) |
| `/report-crash` | YOK | YOK | YOK | client'ta hardcode id.getmailspring.com | backend'e hiç gelmiyor, client'ta kapatılmalı |
| `/oauth/finished` | YOK | YOK | YOK | client'ta hardcode id.getmailspring.com | sadece tarayıcıda gösterilen "bitti" sayfası; auth akışı local server'da biter (`oauth-signin-page.tsx:141-143`) |

## 4. Base seçimi: irfanMiral

Karar: irfanMiral/Mailspring-API.

Gerekçe (matrise göre):
- 1RandomDev'de yeni pixel formatı (`/o/<token>.png`) yok: güncel client'ın tüm read receipt'leri 404. irfanMiral'da var.
- 1RandomDev'de `/api/login-link`, `/api/grammar/check` yok; `/api/resolve-dav-hosts` hâlâ id.getmailspring.com'a gidiyor.
- 1RandomDev'de `manage.js` çalışmıyor ve `better-sqlite3@^8` güncel Node'da derlenmiyor (irfanMiral CHANGES.md). Kullanıcı oluşturmanın tek yolu manage.js.
- irfanMiral gerçek bir fork: `git merge-base` = 1RandomDev `36682a9` (v1.2.0), üstüne 7 commit, rebase/rewrite yok. Lisans GPL-3.0 korunmuş.
- İkisinde de ortak olan bug'lar (open redirect, shared_body click, metadata version, XSS) her iki base'te de düzeltilmesi gerekiyordu, karar değiştirmiyor.

irfanMiral'ın 1RandomDev v1.2.0'a göre commit'leri (`git log 36682a9..d6fab11`), diffstat: 22 dosya, +1363/-793 (çoğu package-lock):

| commit | tarih | özet |
|---|---|---|
| `4b40c9d` | 2026-09-07 | robots.txt, `X-Robots-Tag: noindex, nofollow`, HTML'lere robots meta |
| `646e312` | 2026-09-07 | manage.js ESM'e çevrildi, `./data` oluşturma, `shares_assets` typo; better-sqlite3 `^13.0.3`, Dockerfile `node:22-alpine` + build toolchain; resolve-dav-hosts DNS SRV ile; google-translate `^3.0.0`; `/api/grammar/check` (LanguageTool), `/api/login-link` |
| `037ebf3` | 2026-09-07 | `/dashboard` sayfası (şifre değiştirme, session listesi/revoke, logout); WAL + `busy_timeout` |
| `da78f1c` | 2026-09-07 | release v1.3.0 |
| `43a8353` | 2026-09-08 | `/signature-assets/*` self-host, Twitter -> X ikonu |
| `64b57f1` | 2026-09-08 | release v1.4.0 |
| `d6fab11` | 2026-09-28 | `/o/<token>.png` route'u, open kaydı `recordOpenTrackingHit()`'e taşındı, `blank.png` |

## 5. Bu repoda yapılan değişiklikler

Hepsi `selfhost-compat` branch'inde, irfanMiral `d6fab11` üstüne:

| commit | ne | client/sync karşılığı |
|---|---|---|
| `ad373dd` | `test/compat.test.js`, `npm test` (node:test, yeni dependency yok) | bkz. 1.2-1.6 |
| `efda68d` | metadata: create'te gönderilen `version`, update'te `max(v+1, version)`, integer >= 1 değilse 400 | `TaskProcessor.cpp:1983`, `MailModel.cpp:85` |
| `00f7a18` | session cookie `HttpOnly; SameSite=Lax; Secure` (proxy arkasında), `trust proxy` loopback+private | onboarding webview identity'yi `#identity-result`'tan okuyor, cookie'den değil (`page-authenticate.tsx:18-27`) |
| `a0bf66c` | thread-sharing.ejs: inline JSON'da `<` -> `<` | thread datası 3. parti mail body'leri (`thread-sharing/lib/main.tsx:121-136`) |
| `5ef838c` | open/link tracking input doğrulama, shared_body click sayımı, open redirect kapatma, `__proto__` | `open-tracking-composer-extension.ts:17-66`, `link-tracking-composer-extension.ts:74-94` |

Testler (`npm test`, 7/7 geçiyor; irfanMiral `d6fab11` üstünde 1-6 fail):
1. login (yanlış/doğru şifre), cookie flag'leri, `/onboarding` `#identity-result` decode, `/api/me` alanları, auth'suz/yanlış token 401
2. metadata version: create v3, update v5, stale v4 -> 409
3. yeni pixel (recipient'li ve recipient'siz) + eski `/open/` (encoded path) -> `open_count` 1,2,3; her biri `/deltas/.../streaming`'e `modify` event'i, `cursor` string
4. link redirect + `click_count`; base64'ünde `+` ve `=` olan recipient'ler (standart base64 + URI encode); recipient'siz click
5. open redirect: eşleşmeyen `redirect`, bilinmeyen mesaj, `javascript:` -> 302 yok
6. bozuk token'lar (garbage base64, JSON olmayan, `null`, object/array alanlar, SQL injection string'i, `?me[a]=1`) -> 200 + image, DB'ye yazım yok, process ayakta; `__proto__`/`constructor`/olmayan index, eksik `redirect`, bozuk percent-encoding -> < 500
7. paylaşılan thread sayfasında `</script>` kaçışı

Ek olarak elle doğrulandı: Caddy (v2.11.7, `go install` ile build edildi) arkasında host bazlı routing, `Secure` cookie, ve pixel -> delta event gecikmesi (~20 ms, buffering yok).

## 6. Güvenlik değerlendirmesi

| konu | durum |
|---|---|
| open redirect (`/link`) | KISMEN. Bilinen mesaj: tıklama sayılır ve 302 her zaman gönderenin metadata'sında o index için kayıtlı URL'e gider, `redirect` parametresi yok sayılır. Bilinmeyen mesaj (metadata henüz server'a ulaşmamış ya da sahte headerMessageId): `redirect` parametresine düz 302, tıklama sayılmaz. Alıcı hiçbir durumda ara sayfa görmez (istenen davranış). Kalan risk: sahte headerMessageId ile bu domain üzerinden başka siteye yönlendiren link üretilebilir. `javascript:`, `data:`, `vbscript:`, `file:` hiç yönlendirilmez (404) |
| SQL injection | tüm sorgular prepared statement; `?me[a]=1` gibi object parametreler artık binding'e ulaşmıyor (önce better-sqlite3 TypeError'ı) |
| base64/JSON parse | try/catch + tip kontrolü; bozuk token -> 1x1 image, log warn |
| prototype pollution | link index sadece `^\d+$` |
| stored XSS | thread-sharing.ejs düzeltildi. Tek host kurulumunda `/thread/` ve `/page/` nginx'te kapalı: tarayıcı testinde (Playwright/Chromium) paylaşılan thread sayfasındaki bir script'in aynı host'taki `/onboarding`'i (içinde API token var) okuyabildiği görüldü. `/asset/` açık; oraya sadece login olmuş kullanıcının kendi yüklediği dosyalar (imza fotoğrafı) gidiyor |
| login brute force | rate limit YOK. Caddy'de built-in rate limit yok (plugin gerekiyor, yeni dependency). Öneri: Caddy JSON access log + fail2ban, `/login` 401'leri |
| tracking verisi | open/link endpoint'leri tasarım gereği auth'suz; headerMessageId bilen biri sayaç artırabilir (resmi server'da da aynı model, doğrulanmadı) |

## 7. Açık konular

- `static/thread-sharing.ejs` CSS/JS'i `https://shared.getmailspring.com/static/thread-sharing/build/...` adresinden yüklüyor (1RandomDev'den beri). Paylaşılan thread sayfası Foundry376'nın CDN'ine bağlı ve o script share origin'inde çalışıyor. 2026-10-27'de iki dosya da 200 dönüyor (curl ile kontrol edildi), yani şu an çalışıyor ama Foundry376 kaldırırsa paylaşılan thread sayfası boş açılır. Çözüm bundle'ı repo'ya vendor'lamak, ama kaynağı bu repoda yok.
- `/api/views/*` (AI authoring + View sharing) implement edilmedi.
- metadata update yolu (`UPDATE` + `emitEvent`) transaction dışında; tek process'te sorun değil, değiştirmedim.
- `/link` lookup'ı `aid` ile scope'lanmıyor (headerMessageId unique varsayımı, upstream'den beri).
- Docker image build'i bu sandbox'ta `apk add` aşamasında network yüzünden test edilemedi. Dockerfile irfanMiral'ınki, değiştirmedim.
