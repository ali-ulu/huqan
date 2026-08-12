# HUQAN — Four Fits Analizi (Balfour çerçevesi)

**Baz:** `origin/main` @ `37f68cf` (PR #643, 2026-08-12), kodun kendisinden okundu.
Doküman iddiaları değil, çalışan yüzeyler esas alındı.

> Bu üçüncü tur. İlk tur 228 commit bayat klondan yazıldığı için yanlıştı.
> İkinci tur bayatlığı düzeltti ama yeni bir hata yaptı: `github-app-server.js`'in
> "production entry point" olarak listelenmesine bakıp bunu *kanal kararı* saydı.
> Kodu okuyunca öyle olmadığı görüldü — aşağıda düzeltildi.

---

## Önce: bugün bir kullanıcı fiilen neye dokunabiliyor?

| Yüzey | Durum | Kanıt |
|---|---|---|
| CLI | Çalışıyor | `npm start` → `cli.js` |
| Lokal REST | Çalışıyor, 22 route | `lib/http/route-auth-policy.js`; `/verify`, `/api/trust-receipt`, `/api/workbench/receipt-bundle` dahil |
| MCP | Çalışıyor, 11 tool | `mcpServer.js`: `axiom.learn/ask/verify/plan/agent/policy/approvals/approve/reason/compare/dream` |
| Lokal UI + Trust Receipt Viewer | Çalışıyor | V4-B4 `PASS`, `public/` |
| Conformance runner'ları | Çalışıyor | `npm run conformance:external`, `conformance:a2a` |
| **GitHub App** | **Çalışıyor ama hiçbir şey üretmiyor** | aşağıda |
| Public Trust Receipt (D3) | Kütüphane-içi | route/CLI/MCP tool/anahtar dağıtımı yok |
| TrustBench (C10), Certified Node (C9) | Taslak | runner yok, issuer yok |
| V5 kütüphanesinin tamamı | Erişilemez | `V5_IMPLEMENTATION_ENTRY: FAIL` |

### GitHub App'in gerçeği (ikinci turdaki hatamın düzeltmesi)

`lib/github-app-beta-handler.js`, PR `opened/reopened/synchronize` olayında:

```js
decision: 'beta_observation_only',
status:   'observed',
approvalStatus: 'pending',
reason:   'github_app_beta_observation_requires_review',
{ verdict: 'review' }
```

- **GitHub'a geri hiçbir şey yazmıyor.** `octokit`, `api.github`, comment, check-run: sıfır eşleşme.
- **`package.json`'da onu çalıştıran script yok** (`start/server/mcp` var, github-app yok).
- Yaptığı şey: imzayı doğrula, delivery GUID ile tekilleştir, "bir PR oldu" kaydını
  kanonik makbuz zincirine ekle.

Yani bu bir **dağıtım kanalı değil**, gerçek bir dış olay kaynağına karşı sınanmış bir
**güven sınırı egzersizi**. Mühendislik olarak sağlam (fail-closed auth, replay/crash
penceresi, 1MB akış sınırı, 413) — ama kullanıcıya dönen tek bir piksel yok.

**Sonuç: HUQAN olağanüstü güven *primitifleri* inşa etti, neredeyse sıfır *ürün döngüsü*.**
Four Fits'in tamamı bu tek cümlenin etrafında dönüyor.

---

## 1. Market → Product Fit

### Market — çerçevenin en zayıf halkası

| Alan | Durum |
|---|---|
| **Category** | Üç yönlü çakışma. README: "AI governance / agent-safety / verification layer". `docs/product-positioning.md`: "founder decision simulation — what breaks if I do this?". Kodun fiilî yönü: ajanlar arası doğrulanabilir güven + uyumluluk + sertifikasyon. Üçüncüsü en büyük yatırımı alıyor, hiçbir belgede kategori olarak yazılı değil. |
| **Who** | Tanımlı değil. Positioning "solo founder / OSS maintainer" diyor; ama solo founder `npm run conformance:a2a` çalıştırmaz. Kodun ima ettiği alıcı, ajan filosunu denetlemek zorunda olan ekip. İkisi aynı ürünü satın almaz. |
| **Problem** | **Net, keskin, gerçek.** Ajanın ne yaptığını kanıtlayamamak; riskli aksiyonun onaysız geçmesi. Çerçevenin en sağlam bileşeni ve tüm değerin kaynağı. |
| **Motivation** | Korku (ajan geri alınamaz bir şey yapar) + denetim zorunluluğu. Korku, kaza yaşamamış kullanıcıda satın alma üretmez. Bu, ödeme isteğini yapısal olarak geciktirir. |

### Product — güçlü ama teslim edilmiyor

| Alan | Durum |
|---|---|
| **Core value prop** | ALLOW / BLOCK / ESCALATE + Trust Receipt. Net, savunulabilir, rakiplerden gerçekten farklı. |
| **Hook** | Yazılı hook var, **teslim edilen hook yok.** Bugün en kısa yol: clone → `npm ci` → Node 20 → `better-sqlite3` native derleme → API key → MCP config → sonra "explicit relation marker" sınırına çarp. |
| **Time to value** | Zayıf ve son 228 commit'te **iyileşmedi**. Yapılan işlerin hiçbiri ilk-değer yolunu kısaltmadı. |
| **Stickiness** | Yapısal olarak güçlü: receipt zinciri + graph state + provenance lokalde birikir, çıkış maliyeti zamanla artar. Ürünün en iyi doğal retention mekanizması. |
| **Retention ölçümü** | **Yok.** Telemetri yok, hesap yok, hosted yüzey yok. |

### MPF hükmü

Balfour'un tek gerçek MPF kanıtı düzleşen retention eğrisi. HUQAN'da kohort yok.
Yani **"MPF var mı?" sorusunun cevabı bilinmiyor** — "hayır" değil, ölçülmemiş.
Bu, çerçevenin geri kalanını da askıda bırakıyor: ölçmeden kanal seçmek kumar olur.

İronik nokta: HUQAN'ın tüm tezi "kanıtsız iddiaya güvenme". Kendi ürün-pazar uyumu
hakkındaki iddiası ise şu an tamamen kanıtsız.

---

## 2. Product → Channel Fit

Balfour: *kanal ürüne uymaz, ürün kanala uyar.*

**Bugün fiilen çalışan tek kanal: MCP dizini.** Ürün zaten bir MCP sunucusu, 11 tool
sunuyor, Claude/Cursor config'i README'de. CAC ≈ 0. Ama:

> **MCP tool'larının adı hâlâ `axiom.*`.**
> README `HUQAN_API_KEY`'e geçmiş, RFC-001 kanonik adlandırmayı tanımlamış, repo HUQAN;
> ama kullanıcının **fiilen yazdığı şey** eski marka. Route'larda da karışım var:
> `/dogrula`, `/yukle`, `/llm-sor` ile `/verify`, `/upload` yan yana.
> Tek gerçek kanalın üstündeki isim, ürünün adı değil.

**Potansiyel kanal 2 — paylaşılabilir makbuz.** Lokal-first mimaride "başkasının göreceği
tek artefakt" bu. Parçalar hazır: D3 public receipt (redaksiyon politikalı, Ed25519 imzalı,
`PROVEN`), receipt-bundle export route (`/api/workbench/receipt-bundle`, B3 `PASS`),
Trust Receipt Viewer (B4 `PASS`), GitHub App'in PR olay akışı (C7).
**Dördü de bitmiş, hiçbiri birbirine bağlı değil.** Zincir kapanmadığı için viral döngü sıfır.

**Potansiyel kanal 3 — TrustBench (C10).** Klasik otorite kanalı: benchmark'ı yayınlayan
taraf kategoriyi tanımlar. Taslak metin dürüstlük açısından çok iyi (missing'i paydada
tutuyor, exit-code-sıfır'ı kanıt saymıyor) — ama runner yok, yayın yok.

**Uymayan kanallar:** paid ads (ARPU 0), teşvikli virality (ağ etkisi yok, davet edilecek
ikinci kullanıcı yok), outbound satış (SKU yok).

**Product-Channel hükmü:** ürün MCP'ye iyi oturuyor, ama o kanalı da yanlış isimle ve
ağır TTV ile kullanıyor. Diğer iki kanal inşa edilmemiş.

---

## 3. Channel → Model Fit (ARPU ↔ CAC)

Bugün ARPU 0 ↔ CAC ~0. **Tutarlı** — çerçevenin ikinci sağlam bileşeni, ama bunun sebebi
iyi tasarım değil, henüz para modeli olmaması.

AGPL doğal iki katman dayatıyor; C9 üçüncüsünü açıyor:

| Katman | ARPU | Uyumlu kanal | Durum |
|---|---|---|---|
| AGPL OSS / self-host | 0 | MCP, topluluk, GitHub | bugün burada |
| Ticari lisans / kurumsal | 10-50k$/yıl | otorite içeriği (TrustBench) + inbound + satış | tanımsız |
| Issuer / sertifikasyon (C9) | issuer ekonomisi | ağ etkisi | taslak |

**Tehlike bölgesi:** 20-50$/ay self-serve geliştirici katmanı. Düşük-CAC kanallar için fazla
sürtünmeli (kurulum + ödeme + lokal ürün), içerik+satış maliyeti için fazla ucuz. Atlanmalı.

**Yeni risk:** GitHub App barındırılan hale gelirse, marjinal maliyeti sıfır olmayan ilk
bileşen olur ve ARPU tanımlamayı zorunlu kılar. Self-host kaldığı sürece 0↔0 tutarlılığı korunur.

---

## 4. Model → Market Fit

`ARPU × müşteri × yakalanabilir % ≥ 100M$`

| Senaryo | ARPU | Gereken | Hüküm |
|---|---|---|---|
| A — geliştirici SKU | ~300$/yıl | ~333.000 ödeyen geliştirici | Gerçekçi değil. |
| B — kurumsal trust/compliance | ~50.000$/yıl | ~2.000 kurum | Matematik tutar. Satış-öncelikli şirket demek: hosted, çok kiracılı, SSO, uzaktan enforcement. |
| C — issuer / sertifikasyon ağı | kurum tarafı yüksek | daha az müşteri, daha yüksek bilet | Altyapısı (D3 + A2A + conformance + C9 + C10) fiilen inşa ediliyor. |

Kodun gittiği yer **C**. Ama README hâlâ şunu açıkça reddediyor:

> "a public agent marketplace or **certification network**", "a finished V5 shared-trust ecosystem"

Yani **repo, reddettiğini yazdığı şeyin altyapısını inşa ediyor.** Bu bir tutarsızlık değil,
bilinçli bir fren olabilir (`V5_IMPLEMENTATION_ENTRY: FAIL` tam olarak bu). Ama Balfour
açısından sonuç aynı: model seçilmemiş, dolayısıyla Model-Market Fit **yok**.

Balfour'un 2. dersi: birini değiştirirsen hepsini değiştir. C'yi seçmek pazarı
(alıcı: ajan çalıştıran kurum + ekosistem), ürünü (issuer servisi, anahtar dağıtımı),
kanalı (benchmark otoritesi) ve modeli birlikte değiştirir. Bugünkü tek-kişilik + AGPL +
lokal yapı bunu taşımaz — ama primitifleri inşa etmek yanlış değil, sıra doğru kurulmuş.

---

## Dört Fit Kanvası — kanıta dayalı

```
MARKET                PRODUCT                    CHANNEL                   MODEL
────────────────      ──────────────────────     ──────────────────────    ──────────────────
Kategori: 3 YÖNLÜ ✗   Değer: ALLOW/BLOCK/    ✅   MCP dizini      ✅         ARPU: 0
Kim:      TANIMSIZ ✗          ESCALATE+makbuz     ...ama tool'lar           Katman: TANIMSIZ ✗
Problem:  NET      ✅  Hook: yazili ✅            axiom.*  ✗                Ticari lisans: yok ✗
Motiv:    korku    ~         teslim  ✗           Paylasilabilir makbuz:    Issuer/C9: taslak
                      TTV:  zayif   ✗            4 parca hazir, 0 bag ✗
                      Stickiness:   ✅            TrustBench: taslak
                      Retention: OLCULMUYOR ✗    Paid/virality:  ✗
```

| Fit | Hüküm |
|---|---|
| Market → Product | **Kırık.** Kategori üç yönlü çakışık, alıcı tanımsız, TTV ağır, retention ölçülmüyor. |
| Product → Channel | **Kısmî.** MCP doğru kanal ve çalışıyor; ama eski marka altında ve tek başına. |
| Channel → Model | **Tutarlı ama boş.** 0 ↔ 0. Model olmadığı için henüz sınanmadı. |
| Model → Market | **Yok.** Model seçilmemiş; kod C'ye gidiyor, doküman C'yi reddediyor. |

Gerçekten güçlü olan şey dört fitten biri değil: **ürünün kendi iç tutarlılığı ve kanıt
disiplini** (module-reachability listesi, BLOCKED_GAP kültürü, exit-code'u kanıt saymayan
benchmark taslağı). Bu nadir ve değerli — ama Balfour'un ölçtüğü şey değil.

---

## Sıradaki 5 adım (öncelik sırasıyla, gerekçeli)

1. **Zinciri kapat: PR olayı → doğrulama → public receipt → PR'a geri yaz.**
   C7 + D3 + B3 + B4'ün dördü de bitmiş, aralarında bağ yok. Bu tek iş, ürünün ilk
   *görünür çıktısını* ve tek viral yüzeyini aynı anda yaratır. En yüksek getirili iş bu —
   ve `decision: 'beta_observation_only'`'i gerçek bir karara çevirir.
2. **Kategoriyi teke indir; MCP tool'larını `huqan.*` yap.**
   Tek gerçek kanalın üstündeki isim ürünün adı değil. `docs/product-positioning.md`
   228 commit geride ve hâlâ "founder decision simulation" diyor. Tek kategori, tek alıcı.
3. **TTV'yi < 5 dakikaya indir.** Native derleme gerektirmeyen giriş, API key'siz ilk deneyim,
   tek komut. TTV düzelmeden hiçbir düşük-CAC kanal çalışmaz — Balfour'un tüm kanal
   matematiği buna bağlı.
4. **Retention ölçümü kur.** GitHub App'in delivery store'u zaten kalıcı; "kaçıncı haftada
   hâlâ event geliyor" kohortu neredeyse bedava. MPF'i ilk kez ölçülebilir kılan şey bu.
   Ölçmeden 5. adımı yapma.
5. **Modeli yaz ve README ile kodu barıştır.** OSS(0) + ticari lisans + (opsiyonel) issuer.
   Ortadaki self-serve SaaS'ı açıkça reddet. README'nin "certification network iddia etmiyoruz"
   satırı ile C9/C10 yatırımı arasındaki gerilimi bilinçli bir cümleye dönüştür.

Gözden geçirme ritmi: Balfour erken aşamada aylık diyor; bu repoda 4 günde 228 commit
aktığı için **iki haftada bir** gerçekçi.

---

## Not: doğrulanamayanlar

`gh` bu ortamda kimlik doğrulaması yapamadı (HTTP 401), bu yüzden açık issue/PR listesi
analize dahil edilemedi. Yukarıdaki her iddia `origin/main` kaynak kodundan veya
repo dokümanından okundu.
