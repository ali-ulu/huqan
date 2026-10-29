# M10 merak yönlendiricisi H1: ölçüm öncesi kayıt

İlgili iş: [#4071](https://github.com/ali-ulu/huqan/issues/4071) (epic [#4060](https://github.com/ali-ulu/huqan/issues/4060)).
Kapsam: COG-M10 öğrenme-ilerlemesi merak yönlendiricisi — ön-kayıt yalnızca dokümantasyondur; üretim davranışı, varsayılan veya ölçülmüş kazanım iddiası yoktur.

Bu belge, ölçüm kodu ve Lab koşusu yazılmadan önce ayrı imzalı commit ile sabitlenir. Sonuçlar bu metne sonradan eklenmez; ayrı bir sonuç belgesi (PR-5) ve ilgili PR üzerinden raporlanır. §5 ve §9'daki hipotez, eşikler, örnek birimi ve karar kuralları burada **sonuç görülmeden** dondurulur.

## 1. Kaynak ve kapsam

- Başlangıç kaynak SHA: `1c7fc6d4` (origin/main, dirty: false).
- Merak çekirdeği (değiştirilmez): `lib/cognition/curiosity.js` (`SCHEMA huqan-cognition-curiosity-v1`; `learningProgress`, `rankHypothesesByCuriosity`).
- Seçim katmanı (değiştirilmez): `lib/dream-experiment-loop-hypotheses.js` (`selectHypotheses`, `MAX_HYPOTHESES`, `MAX_DREAM_CANDIDATES`).
- Döngü (değiştirilmez): `lib/dream-experiment-loop.js` (`startFromDreamResult`, `buildVerificationStep`, `persistTransition`).
- Opt-in bağlama (değiştirilmez): `lib/agent-v3-dream-loop-adapter.js`, `agent.v3.js` — yalnız `opts.cognition.curiosity === true`.
- Eşli değerlendirme kontratı (mevcut): `lib/cognitive-lab-paired-delta.js`.
- Lab yüzeyi (mevcut): `lib/cognitive-lab-cli.js`; M10 ölçüm koşucusu PR-5'te bu yüzeye eklenir.
- Ölçüm corpus'u ve koşucu bu PR'da **yoktur**; PR-5'te üretilir ve §4'teki ayrım kurallarına uymak zorundadır.

Mevcut çekirdek sabitleri olduğu gibi kullanılır. Üretim kodu, eşik, model, varsayılan, wiring, `reachability`/ledger/baseline, güvenlik kapıları veya onay akışı bu PR ile değişmez. Merak yönlendiricisi **her zaman** `SIGNAL_ONLY` kalır; doğrulama firewall + `kernel.verify` yolundan geçer.

## 2. Donmuş merak kontratı

Aşağıdaki sabitler `lib/cognition/curiosity.js` ve `lib/dream-experiment-loop-hypotheses.js` içinde uygulandığı gibi **kesinlikle dondurulur**:

| Alan | Değer |
| --- | --- |
| `SCHEMA_VERSION` | `huqan-cognition-curiosity-v1` |
| `LP_WINDOW` | `4` |
| `LP_SCALE` | `2` |
| `LP_MIN` | `0.02` |
| `EXPLORATION_BONUS` | `0.1` |
| `NOISE_VARIANCE_MAX` | `0.2` |
| `W_CURIOSITY` | `0.5` |
| `W_CONFIDENCE` | `0.5` |
| `MAX_DREAM_CANDIDATES` | `200` |
| `MAX_HYPOTHESES` / `DEFAULT_MAX_HYPOTHESES` | `10` / `3` |

**Davranış kuralları (donmuş):**

1. LP yalnız **aynı `probeSetId` + `frameRef`** kümesinde, iki **farklı `predictorVersion`**ın son iki `LP_WINDOW` penceresi karşılaştırıldığında ölçülür: `LP = max(0, mean(eski) − mean(yeni))`.
2. Predictor sürümü değişmediyse, pencere karışıksa veya karşılaştırılabilir iki pencere yoksa `learningProgress: null`, `learningProgressStatus: INSUFFICIENT`. Görevlerin kolaylaşması tek başına öğrenme sayılmaz.
3. Gürültü guard'ı: yeni pencerenin varyansı `> NOISE_VARIANCE_MAX` **ve** `LP < LP_MIN` ise `curiosity = 0`, `noiseGuard: true`. Sonlu örnekten bir bölgenin kesin öğrenilemez olduğu çıkarılmaz.
4. `explorationBonus = EXPLORATION_BONUS / (1 + n)`; `n` bölgenin karşılaştırılabilir gözlem sayısıdır. Keşif sırası tek başına öğrenme iddiası değildir.
5. `curiosity = clamp01(LP_SCALE × LP + explorationBonus)`; `score = W_CURIOSITY × curiosity + W_CONFIDENCE × confidence`. Dream `confidence` kalibre değildir; `probability`, `surpriseBits` veya `informationGain` alanına çevrilemez.
6. Sıra: kaynak havuzu `MAX_DREAM_CANDIDATES` giriş bütçesiyle sınırla → normalize/dedup → curiosity ranker → `MAX_HYPOTHESES` ve dış `maxHypotheses` kesimleri. Ranker iki kesimden **önce** çalışır.
7. Ranker aday ekler, siler veya yeniden adlandırırsa `REJECT` (`ranker_changed_candidate_set`) ve confidence sırası korunur. `ABSTAIN`/`REJECT` (bozuk geçmiş) aday-seti kontrolünden önce döndürülür; sıra yine confidence sırasıdır ve neden `state.curiosity` içinde görünür.
8. Bayrak yoksa (`opts.cognition.curiosity !== true`) sıra confidence sırasıyla **bayt-bayt aynıdır**; hiçbir hipotez eklenmez/silinmez, `MAX_HYPOTHESES`/`maxCycles` değişmez.
9. Ranker yalnız sıralar; `buildVerificationStep` ve `persistTransition` değişmez. Doğrulama yine firewall ve onay yolundan geçer.

## 3. Hipotez H1 (§9, niyetle aynen)

> Eşit doğrulama bütçesinde curiosity kolu, confidence koluna karşı **ayrı ve kapalı nihai holdout** üzerindeki tahmin hatasını ve bağımsız görev başarısını iyileştirir.

- **Aday kol (candidate):** `opts.cognition.curiosity === true`, merak yönlendiricisiyle sıralanan ve **gerçekten yürütülen** dream→verify yolu; aynı doğrulama bütçesi.
- **Taban kol (control):** bayrak kapalı; confidence sırasıyla seçilen ve **gerçekten yürütülen** aynı yol; aynı doğrulama bütçesi.
- **Ana ölçü A (tahmin hatası):** nihai holdout üzerinde görev başına mutlak tahmin hatası (MAE); düşük daha iyi.
- **Ana ölçü B (görev başarısı):** nihai holdout üzerinde bağımsız doğrulanmış görev başarı oranı; yüksek daha iyi.
- **Yardımcı ölçüler (etiket belirlemez):** `verified/rejected` sayısı, K içinde bilgilendirici sonuç, `noiseGuard` sayısı, seçilen görev zorluk dağılımı, maliyet ve gecikme.
- **Kapsam dışı iddialar:** öznel yaşantı, genel zeka, salt yeniden sıralamanın kendisi öğrenme kanıtı değildir; güncelleme yoksa LP `INSUFFICIENT` kalır.

## 4. İzleme / nihai holdout ayrımı (sızıntı koruması)

- **İzleme probe kümesi:** `probeSetId` + `frameRef` ile sabitlenmiş küme; yalnız LP ve merak sırasını yönlendirir. Nihai değerlendirme holdout'u değildir.
- **Nihai holdout:** kaynak/görev grubu düzeyinde izleme kümesinden ayrılır. `corpusDigest` ve grup düzeyi `groupDigest` değerleri, holdout açılmadan **önce** kalibrasyon manifestinde kaydedilir ve commit edilir.
- **Örtüşme yasak:** izleme probe'ları ile nihai holdout aynı `sourceGroup`'u paylaşamaz. `rankHypothesesByCuriosity(..., { finalHoldoutSourceGroups })` örtüşmeyi `REJECT` ile reddeder; Lab koşucusu bu kapıyı atlayamaz.
- **Erişim sınırı:** nihai holdout girdileri, etiketleri ve ara/toplu sonuçları ranker'a, `history`'ye, eğitime, eşik/hiperparametre seçimine veya model seçimine **verilmez**. Kollar, predictor/model sürümleri, eşikler ve bütçeler dondurulduktan sonra yalnız değerlendirme yolu holdout'u açar.
- **Yeniden kullanım:** sonuçlara göre yeni ayar yapılırsa o set geliştirme verisi olur; yeni bağımsız holdout olmadan doğrulayıcı kazanç iddiası kurulamaz. Tüketilmiş holdout tekrar kullanılmaz.
- **Negatif test:** holdout sonuçlarını adaptif döngüye beslemek izolasyon testini **bozmalıdır**; holdout etiketlerini değiştirmek değerlendirme öncesi sıralamayı veya donmuş modeli **değiştirmemelidir**.

## 5. Örnek birimi ve güç gerekçesi

- **Birim:** bağımsız eşli **grup** (kaynak grubu × görev ailesi). Tekil görevler bağımsız örnek sayılmaz; aynı gruptaki görevler birlikte taşınır.
- **Taban:** `minimumPairedGroups = 24`. Altında → `INSUFFICIENT`.
- **Güç formülü (dondurulmuş):** `N_required = ceil(((z_0.975 + z_0.80)² × σ̂²) / δ²)`, `δ = 0.05` (başarı için mutlak fark), `z_0.975 ≈ 1.96`, `z_0.80 ≈ 0.8416`; `σ̂` yalnız **izleme gruplarında** koşulan pilot koşudan gelir (holdout'a dokunmaz).
- **Kural:** `N = max(24, N_required)`. Gerçek eşli grup sayısı `N_required`ın altındaysa sonuç `INSUFFICIENT`'tır; pilot yalnız varyans tahmini içindir, kol/eşik/model seçmez.
- Pilot koşu holdout'u açamaz ve sonuçları bu belgeye eklenmez; yalnız `σ̂` ve `N_required` manifestte kaydedilir.

## 6. Donmuş eşli kontrat

Eşli farklar mevcut `lib/cognitive-lab-paired-delta.js` üzerinden alınır; kontrat sonuç görülmeden dondurulur:

| Alan | Değer |
| --- | --- |
| `method` | `seeded-paired-bootstrap` |
| `seed` | `40710` |
| `resamples` | `2000` |
| `confidenceLevel` | `0.95` |
| `meaningfulEffect` (hata) | `0` |
| `nonInferiorityMargin` (başarı) | `0.05` |
| `minimumSamples` | `24` (eşli grup) |
| `direction` | `lower-error-is-better`, `higher-success-is-better` |

Bilinmeyen alan, eksik alan veya skorlama anında seçilmiş eşik → `REJECT`. Eşleşmeyen kollar (farklı görev kümesi, farklı bütçe, farklı predictor sürümü seti) `REJECT` edilir.

## 7. Karar kuralları (sonuç görülmeden, öncelik sırası)

1. **REJECT** — bütünlük ihlali (`firewall bypass > 0` veya `approval bypass > 0`), kol uyuşmazlığı, izleme/holdout kaynak-grubu örtüşmesi, eksik `corpusDigest`/`groupDigest`/predictor sürümü.
2. **INSUFFICIENT** — eşli grup sayısı `N_required` altında, boş/kapalı holdout, karşılaştırılabilir çift yok, LP hiç ölçülmemiş (yalnız keşif sırası).
3. Aksi halde eşli bootstrap CIs hesaplanır:
   - `errorDelta = controlMAE − candidateMAE` (pozitif = aday daha iyi)
   - `successDelta = candidateSuccess − controlSuccess` (pozitif = aday daha iyi)
4. **GAIN** — `lower(errorDelta) > 0` **ve** `lower(successDelta) > 0`.
5. **HARM** — `upper(errorDelta) < 0` **veya** `upper(successDelta) < 0`. Zarar da kazanç kadar görünür raporlanır.
6. **NOT_CLEARED** — diğer tüm durumlar.
7. `assertsGain` bu belgede **asla** `true` değildir. Yalnız PR-5 sonuç belgesi `GAIN` + G3 birleşik kabulü raporlarsa, varsayılan/terfi kararı ayrı bir PR'da değerlendirilir (§10).

## 8. Antivakalar ve G3 katkısı

- **Kolay görev kayması:** aday kolun seçtiği setin grup düzeyi ortalama taban zorluğu, kontrolünkinden `0.05`'ten fazla düşükse etiket **NOT_CLEARED**'a çekilir; zorluk desili bazında ayrıştırılmış rapor zorunludur. Başarı artışı yalnız daha kolay görev seçmekten geliyorsa kazanç sayılmaz.
- **Gürültülü bölge ("noisy TV"):** yüksek varyanslı düz bölgeler terfi ettirilmemeli; iki kolda `noiseGuard` sayıları ve LP durumları raporlanır.
- **Yeni frame / ortam değişimi:** `frameRef`/`probeSetId`/`predictorVersion` değişimleri raporda görünür; kimliksiz legacy kayıtlar karşılaştırmaya girmez ve `INSUFFICIENT` üretir.
- **Restart / replay:** yeni süreç aynı journal'dan aynı karşılaştırılabilir geçmişi kurmalı; bilinmeyen kayıtlar sessizce doldurulmaz.
- **Eski beceriler:** mevcut dream hipotez kalite/semantik testlerinde non-inferiority raporlanır.
- **Doğrulama yolu:** `buildVerificationStep` ve `persistTransition` değişmez; firewall ve onay bypass sayaçları 0 olmalıdır.
- **Sızıntı negatif testleri:** §4'teki iki negatif test (holdout besleme, etiket değiştirme) PR-5'te çalıştırılır ve raporlanır.

## 9. Önceden belirlenen kabul koşulları (PR-5)

1. Her iki kol **gerçek yürütme yolu** üzerinden gerçekten koşar; yalnız-tavsiye kolu puanlanamaz.
2. Aynı corpus, aynı seed ile iki koşuda ve gerçek CLI girişi (`bin/huqan-cognitive-lab.js`) üzerinden bayt-bayt aynı JSON'u üretir (saat/rastgelelik/store yok).
3. Holdout izolasyonu kanıtlanır: kaynak-grubu örtüşmesi `REJECT`, holdout sonucu besleme izolasyon testini bozar, holdout etiketi değişimi değerlendirme öncesi sıralamayı değiştirmez.
4. Ranker mutasyon testi: aday ekleyen ranker `REJECT` + confidence sırası üretir (PR-2'deki test Lab koşusunda da yeşil).
5. Rapor zorunlu alanları: `corpusDigest`, `groupDigest`, izleme probe digest'i, predictor sürümleri, `N_required`, eşli grup sayısı, iki ana ölçünün nokta tahmini ve %95 CI'ları, bütünlük sayaçları, antivaka metrikleri, `GAIN`/`HARM`/`NOT_CLEARED`/`INSUFFICIENT`/`REJECT` etiketi.
6. `assertsGain`, varsayılan terfi, wiring, ledger/baseline ve güvenlik eşikleri PR-5'te **değişmez**.

## 10. Sonuçların eklenmemesi ve takip

- Sonuçlar bu belgeye sonradan eklenmez; PR-5 sonuç belgesine yazılır.
- #4071, §10 kabul kararı verilene kadar açık kalır.
- Varsayılan/terfi kararı yalnız ön-kayıtlı `GAIN` **ve** G3 birleşik kabulü sonrası, ayrı PR'da değerlendirilir.

## 11. Bağlama notu

Bu PR yalnızca dokümantasyon değişikliğidir: (1) yeni `docs/task-packs/cog-m10-curiosity-preregistration-20261030.md` ve (2) `lib/cognition/curiosity.js` içinde **yalnızca sabitlerin üstündeki iki satırlık yorum** — "(PR-4)" atfını bu dosya adıyla değiştirmek. Hiçbir sabit, fonksiyon, export, test veya davranış değişmez; wiring, ledger, baseline ve `opts.cognition.curiosity` semantiği aynı kalır.
