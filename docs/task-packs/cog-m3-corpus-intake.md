# M3/B4 — Gerçek görev kaynağı uygunluk envanteri

İş: [#4465](https://github.com/ali-ulu/huqan/issues/4465). Program: [#4060](https://github.com/ali-ulu/huqan/issues/4060).
Durum: `NOT_READY`; H1 deneyi `NOT_RUN`; `assertsGain:false`.
Bu teslim yalnız gözlenen açık issue havuzunda kaynak uygunluğunu tarar.
Corpus tamamlanmış, oracle hazırlanmış veya bağımsız denetçi atanmış değildir.

## Yerel SQLite journal envanteri

2026-11-02 08:31:56 UTC'de canonical clone ve desktop worktree altında .db, .sqlite ve .sqlite3 uzantılı dosyalar; node_modules, .git, test ve tests hariç tutularak tarandı. Üç SQLite dosyası salt okunur açıldı: yalnız canonical clone içindeki memory.db dosyasında experience_journal tablosu vardı ve bu tablonun satır sayısı 0'dı; diğer iki dosyada tablo yoktu. Bu nedenle incelenen üç SQLite kaydında doğrulanmış uygun support sayısı 0'dır.

Durum EMPTY_IN_SCANNED_SQLITE_SOURCES olarak kaydedildi. Bu, yalnız belirtilen iki ağaçta bulunan ve tarama kapsamına giren SQLite dosyalarındaki bulgudur; JSON journal dosyaları veya tüm makine hakkında yokluk iddiası değildir. Görev payload'ı okunmadı, SQLite'a yazılmadı. Ayrıntılı envanter ve dosya boyutları eşlik eden JSON'dadır.

## Gözlenen havuz ve sınır

`ali-ulu/huqan` public deposunda `gh issue list --state open --limit 100`
çalıştırıldığında, JSON'da kaydedilen 2026-11-01 18:53:13.098 UTC gözleminde altı açık issue
gözlendi: #4470, #4465, #4396, #4395, #4394 ve #4060. #4465 bu işin
koordinasyon/öz değerlendirme kaydı olduğundan aday havuzundan ayrı tutuldu.
Diğer beş issue'nun gövdeleri incelendi: bu havuzda uygun bounded Coder
görevi yok; sonuç **0 kabul / 5 ret**. Bu bulgu yalnız bu havuza ilişkindir,
tüm public depolar veya diğer kaynak havuzları hakkında hüküm değildir.

Her gövdenin gözlenen sürümü, gövde SHA-256'sı ve ret gerekçesi
[eşlik eden JSON envanterindedir](cog-m3-corpus-intake.json). JSON bu belgeyle
birlikte kaynak kaydıdır; runtime manifest, ön-kayıt veya deney kilidi değildir.

| Issue | Gövdeye dayalı ret gerekçesi | Görev öncesi SHA | Aile bağımsızlığı | Split |
| --- | --- | --- | --- | --- |
| [#4470 — G3 closure-gate ölçümleri](https://github.com/ali-ulu/huqan/issues/4470) | Ölçüm/closure boyutlarını tarif ediyor; sınırlı Coder yolunda çözülebilecek özgün açık hata/bakım girdisi veya orijinal görev örneği sunmuyor. | Bilinmiyor | Bilinmiyor | Yok |
| [#4396 — Duygu-sohbet-eylem döngüsü](https://github.com/ali-ulu/huqan/issues/4396) | Bağımsız G1/G2/G3 deney planı; bounded Coder hata görevi ve orijinal açık görev örneği yok. | Bilinmiyor | Bilinmiyor | Yok |
| [#4395 — Doğal sohbet fizibilitesi](https://github.com/ali-ulu/huqan/issues/4395) | Model, inference ve gerçek conversation yolu fizibilitesi; M3'ün sınırlı Coder görev girdisi yok. | Bilinmiyor | Bilinmiyor | Yok |
| [#4394 — Laya denetimi ve distillation](https://github.com/ali-ulu/huqan/issues/4394) | Öğretmen/veri/eğitim ve model değerlendirmesi; bounded Coder hata görevi örneği yok. | Bilinmiyor | Bilinmiyor | Yok |
| [#4060 — COG program epic](https://github.com/ali-ulu/huqan/issues/4060) | Program kabul kapıları ve koordinasyon; özgün, tekil Coder bakım/hata görevi değil. | Bilinmiyor | Bilinmiyor | Yok |

`sourceCommit` değeri `34824d75a50114e6580d6d58878b708e90af76a6`, tarama
anındaki HUQAN kod tabanıdır; issue öncesi kod veya görev öncesi artefakt SHA
değildir. Gövdelerden görev öncesi SHA, ortak ancestor ve aile bağımsızlığı
kanıtı çıkmadı. #4465'in kendisi aday değerlendirmesi değildir; JSON'da ayrı
`excluded` kaydı olarak tutulur. `reviewed`/incelenmiş olma kaydı, bağımsız
harici denetçinin var olduğu iddiası taşımaz.

## Ayrı dış qualification adayı

[date-fns/date-fns#4346 — Negative fractional month amounts can subtract an extra month](https://github.com/date-fns/date-fns/issues/4346), ilk HUQAN havuzundan ayrı bir dış adaydır. Durumu `PENDING_EVIDENCE` / `NOT_QUALIFIED`; kabul edilmiş aile veya split değildir. İlk havuzun **0 kabul / 5 ret** sonucu değişmez. Görev öncesi sabit kaynak SHA'sı `717ce0a807ea4c6b540d015b5c408723175b2838`; ilgili yollar `pkgs/core/src/addMonths/index.ts` ve `pkgs/core/src/subMonths/index.ts`.

Issue'nun özgün örnekleri `new Date(2026, 2, 31)` için yerel takvimde `addMonths(date, -0.5)` → 2026-03-31, `addMonths(date, -1.5)` → 2026-02-28 ve `subMonths(date, 0.5)` → 2026-03-31 bekler. Bunlar kaynak görevin gereksinimleridir; bağımsız oracle veya çalıştırma sonucu değildir. Statik kaynak okunmuştur; runtime çalıştırılmamıştır. Issue ayrıca sıfıra kırpılan miktarlarda DST geri alma çevresindeki mevcut sıfır artış davranışının korunmasını ister.

Qualification için üç bağımsız mühürlü source support, learned method ve procedure hash kanıtı; operatör yetkisi; gerçek native kabul, rollback ve restart kanıtı; ayrı oracle gereklidir. Soy, aile bağımsızlığı ve önceki maruziyet `UNKNOWN`; split yoktur. Mevcut sentez sınırı tüm Coder görevlerinin desteklenmediği anlamına gelmez: bu aday için öğrenilmiş `replace_text` yöntemi kanıtı yoktur. Bu envanter yalnız bu Markdown ve eşlik eden JSON dosyasını kapsar.

## Sonraki adım ve sabit sınırlar

Bir sonraki somut kaynak çalışması, ayrı ve dondurulmuş gerçek operatör görevi
veya bağımsız depo aday havuzudur. İlk uygun gerçek görev qualification ve
oracle ayrımı için incelenebilir; 24 holdout ile 8 transfer ailesi ayrıca
köken denetimi ve sonuç öncesi kilit ister. Bu issue taramasındaki görevleri
sentetik Coder görevlerine dönüştürmek veya uygun örnek gibi etiketlemek yoktur.

M3 ön-kaydı ([bağlantı](cog-m3-replay-preregistration-20261027.md)) ve aile
değerlendirme sözleşmesi ([bağlantı](cog-m3-family-evaluation-contract.md))
korunur: 24 bağımsız holdout + ayrıca 8 bağımsız transfer ailesi, `K=32`,
ayrı oracle, source/qualification/evaluation ayrımı, ön kilit ve aynı gerçek
approval/promotion/admission/native Coder kabul-rollback yolu. H1 `NOT_RUN`,
corpus `NOT_READY`, `assertsGain:false`; bu envanter bunları değiştirmez.
G3 closure-gate issue #4470 ayrı ve bu teslimle kapanmaz.

## Yeni native qualification follow-up (yerel ve yalnızca qualification kaydı)

İlk Express dış adayına daha sonra ayrı bir native qualification kaydı eklendi; önceki gözlem ve sınırları değiştirilmedi. Kanıt `BugsJS/express` issue #2458 için kaynak commit `3387916efcac19302188151a24927a0405a373e8` üzerinde, `2026-11-03T19:35:31.537Z` tarihinde oluşturulan `express-reviewed:c1` run’ıdır (`sealed:true`, `closed:true`, `learningEligibility:positive_procedure`). Operatör inceleme politikası `OPERATOR_AUTHORIZED_REVIEW` idi; 2 sonlu program değerlendirildi, 1’i seçildi.

Native kontrolde tek GET ve tek POST önce/sonra HTTP 200, `Allow: GET,POST`, exit 0 verdi. Yinelenen GET senaryosu önce HTTP 200 ve `Allow: GET,GET,POST` ile exit 1 (beklenen assertion: `Allow must not contain duplicate methods`), sonrasında HTTP 200 ve `Allow: GET,POST` ile exit 0 verdi. Bu, aynı bug’ın tekrarlı incelemesidir; bağımsız support değildir ve `independence` `UNKNOWN` kalır.

Hash temsilleri ayrıdır: kaynak çalışma kopyasının ham UTF-8 kaynak öncesi SHA-256 değeri `499160f16cd25c2ee453be9845b56866b2f06e1bda08ff3965071fbf21a5d3d3`; v3 türetiminin LF-normalize edilmiş girdisi `3867c0f5ac5216d4c4056aceac3e528c1fac08e2fb1e3b28ae719695e950cf5a`, çıktısı `64d4295d77da4f0e6349147d8c4d2454c3e446eee5695f8aac4edc9f6d7cbb8e`’dir. Ham çalışma kopyası özeti, Git blob'unun bayt özeti değildir. Run source hash `9f31f2b97b64bc7bee253e5c7f79a5ffb476bc8dfde0b1fca3e1cb2dc8962df0`, record hash `559df79ca152cc3afe218e961d0acbd3893266fd8c346a304f56c8150386c1a0`’dır. Kontrol artefaktları JSON’daki kapsam klasörüne göreli `m3-string-array-qualification-reviewed/checks/` yolları ve SHA-256 değerleriyle listelenmiştir; kapsam `LOCAL_NOT_PUBLISHED`’dır.

Kayıt `localQualificationOnly:true`, `remembered:false`, `promoted:false`, `corpusAccepted:false` ve `assertsGain:false` olarak kalır. İlk havuzun 0 kabul / 5 ret sayımları, adayın mevcut durum alanları ve M3 `NOT_READY` / `NOT_RUN` sınırları değişmez. Uygulama referansı PR #4499’un gözlem sırasında main’e birleşmemiş `18b99c623295678b23cbd60a073262c78a9ab466` commitidir; bu koşum sonrasında bağlanan bir referanstır, sonuç öncesi kilit değildir. Bu kayıt main’de kodun mevcut olduğu iddiası taşımaz. Bu doküman envanteridir; runtime manifest veya deney ön kaydı değildir.
