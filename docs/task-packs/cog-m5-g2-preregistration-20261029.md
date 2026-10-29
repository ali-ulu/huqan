# M5 G2 çift-süreç yönlendiricisi H1: ölçüm öncesi kayıt

İlgili iş: [#4068](https://github.com/ali-ulu/huqan/issues/4068) (epic [#4060](https://github.com/ali-ulu/huqan/issues/4060)).
Kapsam: COG-M5 çift-süreç yönlendiricisi (dual-process router) G2 aşaması — ön-kayıt yalnızca dokümantasyon; üretim kablolama/değiştirici eylem yetkisi yoktur.

Bu belge, ölçüm kodu ve karakterizasyon/uygulama testi çalıştırılmadan önce ayrı imzalı commit ile sabitlenir. Sonuçlar bu metne sonradan eklenmez; ayrı bir sonuç belgesi (PR-5) ve ilgili PR üzerinden raporlanır. Ön-kayıt, §9 ve §10'da istenen hipotez, eşikler, karar kuralları ve bütünlük korumaları burada **sonuç görülmeden** dondurulur.

## 1. Kaynak ve kapsam

- Başlangıç kaynak SHA: `1dfd2d32` (origin/main, dirty: false).
- Dokümantasyon değişikliği dışında sadece başlık yorumu güncellenecek dosya: `lib/cognition/dual-process-router.js` (satır 8 — yalnızca başlık yorumu).
- Yönlendirici çekirdeği (değiştirilmez): `lib/cognition/dual-process-router.js` (`SCHEMA huqan-cognition-dual-process-v1`).
- Danışmanlık katmanı (mevcut): `lib/agent-cognition-seam.js` (annotation-only, `executes:false`, `authority: ROUTING_ADVICE_ONLY`, `opts.cognition.dualProcess` ile opt-in).
- Eşli değerlendirme kontratı (mevcut): `lib/cognitive-lab-paired-delta.js`.
- Lab/karar yüzeyi (mevcut): `lib/cognitive-lab-cli.js`.
- G2 için **yeni** maliyet-öncelikli mirror değerlendirici: `lib/cognitive-lab-cost-evaluator.js` (henüz yok; PR-4'te yazılacak).

Mevcut çekirdek sabitleri olduğu gibi kullanılır. Üretim kodu, eşik, model, varsayılan, wiring, `reachability`/ledger/baseline, güvenlik kapıları veya onay akışı bu PR ile değişmez. Router **her zaman danışmanlık-only** (`executes:false`, `authority: ROUTING_ADVICE_ONLY`) kalır; güvenlik duvarı ve onay yürütücüsü son söz hakkını korur.

## 2. Donmuş yönlendirici kontratı

Aşağıdaki sabitler `lib/cognition/dual-process-router.js` içinde uygulandığı gibi **kesinlikle dondurulur**:

| Alan | Değer |
| --- | --- |
| `SCHEMA_VERSION` | `huqan-cognition-dual-process-v1` |
| `WEIGHTS.predictionError` | `0.35` |
| `WEIGHTS.uncertainty` | `0.25` |
| `WEIGHTS.novelty` | `0.20` |
| `WEIGHTS.arousal` | `0.20` |
| `S1_MAX_DEMAND` | `0.30` |
| `S2_MIN_DEMAND` | `0.60` |

**Sert kural sırası (donmuş):**

1. risk unknown/high/critical → `SYSTEM2` (risk `null` veya `RISK[risk] >= RISK.high`)
2. rota reddi (`route.refusalReason` tanımlı/değil null değil) veya `route.chosenCapabilityId` yok → `SYSTEM2` (`no_compiled_procedure`)
3. güven yetersiz-veri (`insufficient-data`) → `SYSTEM2` (`trust_insufficient_data`)
4. deneme-süresi (`probationary`) → en az `SYSTEM1_VERIFY` (talep `>= S2_MIN_DEMAND` ise `SYSTEM2`, aksi halde `SYSTEM1_VERIFY`)
5. bilinmeyen bileşen 1 olarak sayılır; tanınmayan güven durumu → `SYSTEM2` (`trust_unrecognized`) (sessiz kısayol yok)
6. yalnızca açıkça `trusted` ve düşük talep (`demand < S1_MAX_DEMAND`) → `SYSTEM1`; orta talep → `SYSTEM1_VERIFY`; yüksek talep → `SYSTEM2`

## 3. Hipotez H1 (§9, niyetle aynen)

> B4 transfer kohortunda, gerçekten yürütülen yönlendirici-tabanlı kol, gerçekten yürütülen her zaman-`SYSTEM2` koluna kıyasla **gözlenen görev başarısında** aşağıda kalmamalıdır (non-inferior) ve aynı anda çözülmüş görev başına maliyeti düşürmelidir. Karşılaştırma **aynı desteklenen görevler**, **aynı nitelik/ onay maliyetleri** üzerinden yapılacak; kullanılamayan/başarısız iş her iki kolda da görünür tutulacak ve başarısız iş maliyet kazancı üretmek için dışlanmayacaktır.

- **Aday kol (candidate):** gerçekten yürütülen router-tabanlı kol (router tavsiyesine göre `SYSTEM1`/`SYSTEM1_VERIFY`/`SYSTEM2` seçimi, ancak yürütme her zaman gerçek yürütme yolu üzerinden ve son söz güvenlik/onay kapılarındadır).
- **Taban kol (baseline):** gerçekten yürütülen her zaman-`SYSTEM2` kolu (aynı gerçek yürütme yolu, aynı nitelik/onay maliyetleri).
- **Kısıtlar:** aynı desteklenen görevler, aynı nitelik/ onay maliyetleri, başarısız/kullanılamayan iş her iki kolda görünür, başarısız iş dışlanarak maliyet kazancı üretmek yasaktır.

## 4. Bütünlük koruması (Integrity guard)

- **Güvenlik duvarı bypass = 0** ve **onay bypass = 0** olmalıdır. Herhangi biri > 0 ise deney **REJECT** edilir.
- Router asla eylem yetkisi kazanmaz; `executes:false` ve `ROUTING_ADVICE_ONLY` değiştirilemez.
- Yönlendirme, firewall kararını, risk sınıflandırmasını veya onay yetkisini zayıflatamaz/değiştiremez.

## 5. Donmuş eşli kontrat ve MİMARİ NOT (cost-mirror gereksinimi)

Mevcut eşli kontrat `lib/cognitive-lab-paired-delta.js`'den **sonuç görülmeden** dondurulur:

| Alan | Değer |
| --- | --- |
| `method` | `seeded-paired-bootstrap` |
| `resamples` | `2000` |
| `confidenceLevel` | `0.95` |
| `meaningfulEffect` | `0` |
| `nonInferiorityMargin` | `0.05` |
| `minimumSamples` | `10` |
| `direction` | `lower-brier-is-better` |

**Önemli not (ön-kayıt):** Mevcut değerlendirici çoğunlukla çözümlenmiş-primer (solved-primer) bağlamındadır ve maliyet non-inferiority için yetersiz kalabilir. Issue §9 gereği `lib/cognitive-lab-cost-evaluator.js` gerekli olabilir (**COST-PRIMARY mirror evaluator**). Bu deney **maliyet-öncelikli** olacak şekilde tasarlanacaktır.

**Maliyet sözleşmesi (bu belgede sonuç görülmeden DONDURULMUŞTUR):**

| Alan | Değer | Açıklama |
| --- | --- | --- |
| `costMetric` | `perTaskTotalCost` | Görev başına toplam maliyet = Lab bütçe zarfından model/araç/insan/token kullanımı (gerçek ölçüm). Tahmine dayalı toplamlar değil, gerçekten harcanan/hesaplanan maliyet. |
| `pairedCostMetric` | `pairedDelta(baselineMinusCandidate)` | Eşli fark `baseline - candidate`. Pozitif değer, aday kolun **daha ucuz** olduğu anlamına gelir (daha az maliyet). |
| `nonInferiorityMarginSuccess` | `0.05` | Başarı oranı için non-inferiority marjı (gözlenen başarı, non-inferior). |
| `minimumPairedSamples` | `24` | M3 B4 kohortu minimumTransfer'ına yakınsamak amacıyla **en az 24 eşli örnek** (aile/transfer düzeyinde paired örnekleme). |
| `decisionRule` | `nonInferiorIfSuccessCI_Lower >= -margin AND costAdvantageNotAtExpenseOfIntegrity` | Başarıda non-inferior olmalı; maliyet kazancı başarısız iş dışlanarak elde edilemez. Bütünlük ihlali durumunda REJECT. |
| `integrityRejection` | `firewall bypass>0 OR approval bypass>0 -> REJECT` | Bütünlük koruması ihlali durumunda deney reddedilir. |

`assertsGain` **asla** bu belgede `true` olarak ilan edilmez. `assertsGain` yalnızca ön-kayıtlı eşli delta ile `assertsGain:true` raporu mevcut olduğunda ve G3 kabulü verildiğinde (`issue §10`) ayrı bir PR'da değerlendirilebilir. Bu PR hiçbir varsayılan üretim davranışını değiştirmez.

## 6. Lab/ölçüm protokolü

- **Gerçekten yürütülmüş olmalı:** Her iki kol da **gerçek yürütme yolu** üzerinden gerçekten yürütülmelidir. Sadece tavsiye-only kol puanlanamaz.
- **İzole Lab:** Ölçüm öncelikle izole Cognitive Lab ortamında yapılacaktır.
- **Opt-in, varsayılan değişmez:** Üretim varsayılana geçiş yoktur; wiring/değer hiçbir şekilde değiştirilmez.
- **Aynı nitelik/onay maliyetleri:** Karşılaştırma koşulları eşit tutulacaktır.
- **Başarısız iş görünür:** Kullanılamayan/başarısız işler her iki kolda da raporlanacak, dışlanmayacaktır.
- **Bütünlük kanıtlanmalı:** firewall bypass ve approval bypass mutlaka ölçülüp raporlanacaktır.

## 7. PR-4 için önceden belirlenmiş kabul koşulları (§8)

PR-4 aşağıdaki maddeleri **karakterizasyon/test olarak** karşılamak zorundadır:

1. `SYSTEM2` tavsiyesi → kapsamlı snapshot → seçilmiş plan → onay → yürütme → gözlenen sonuç akışı test edilmelidir.
2. Deliberasyon kullanılamadığında veya politika tarafından reddedildiğinde sessiz `SYSTEM1` geri-düşmesi **olmayacak**, 'completed' gibi yanlış başarı beyanı **olmayacaktır**.
3. `SYSTEM1_VERIFY` ilk olarak kendi **nitelik doğrulamasını** çalıştıracaktır.
4. Mutasyon testi: `SYSTEM2` yürütücüsünü devre dışı bırakmak uçtan-uca testi **bozmalıdır**.
5. Mutasyon testi: Yüksek risk `SYSTEM1`'e yönlendirildiğinde test **başarısız olmalıdır**.

Bu koşullar PR-4 öncesinde/ile birlikte karşılanmadan G2 ölçümüne geçilmemelidir.

## 8. Sonuçların eklenmemesi ve takip

- Sonuçlar **bu belgeye sonradan eklenmez**. Sonuçlar ayrı bir sonuç belgesine (PR-5) yazılacaktır.
- PR `#4068` §10 kabul kararı verilene kadar açık kalacaktır.
- `assertsGain` yalnızca ön-kayıtlı paired delta (`assertsGain:true`) ve G3 kabulü sonrası ayrı PR'da değerlendirilecektir.
- Bu PR üretim kablolama, varsayılan değiştirme, ledger/baseline değişikliği yapmaz.

## 9. Bağlama notu

Bu PR sadece dokümantasyon değişikliğidir: (1) yeni `docs/task-packs/cog-m5-g2-preregistration-20261029.md` ve (2) `lib/cognition/dual-process-router.js` içinde **yalnızca satır 8 başlık yorumu** — `Frozen in the G2 preregistration (docs/task-packs/cog-m5-g2-preregistration-*.md).` ifadesini tam dosya adı `docs/task-packs/cog-m5-g2-preregistration-20261029.md` ile değiştirmek. Hiçbir sabit, fonksiyon, export veya test değişmez. Router hala danışmanlık-only (`executes:false`, `ROUTING_ADVICE_ONLY`) kalır; güvenlik duvarı ve onay yürütücüsü son söz hakkını korur. Wiring/değer/ledger/baseline değişmez.
