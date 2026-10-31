# M4 unutma (retention) H1: ölçüm öncesi kayıt

İlgili iş: [#4070](https://github.com/ali-ulu/huqan/issues/4070) (epic [#4060](https://github.com/ali-ulu/huqan/issues/4060)).
Kapsam: COG-M4 geri alınabilir unutma politikası — ön-kayıt yalnızca dokümantasyondur; üretim davranışı, varsayılan veya ölçülmüş kazanım iddiası yoktur.

Bu belge, ölçüm kodu ve Lab koşusu yazılmadan önce ayrı imzalı commit ile sabitlenir. Sonuçlar bu metne sonradan eklenmez; ayrı bir sonuç belgesi (PR-4) ve ilgili PR üzerinden raporlanır. §3, §6 ve §7'deki hipotez, eşikler, örnek birimi ve karar kuralları burada **sonuç görülmeden** dondurulur.

## 1. Kaynak ve kapsam

- Başlangıç kaynak SHA: `c2ba9af8` (origin/main, dirty: false).
- Unutma çekirdeği (değiştirilmez): `lib/cognition/forgetting-score.js` (`SCHEMA huqan-cognition-forgetting-v1`; `retentionScore`, `rankForgetCandidates`).
- Opt-in seçici (değiştirilmez): `lib/memory-consolidation.js` (`selectConsolidationCandidates`, `opts.retention`).
- Geri alınabilir arşiv yolu (değiştirilmez): `lib/memory-lifecycle.js` (`consolidate`, `archive`, `restore`) — fişli (`receipt`), dry-run varsayılan.
- Yaşlanma (değiştirilmez): `lib/memory-recency-decay.js` (`recencyFactor`, yarı-ömür 90 gün).
- Eşli değerlendirme kontratı (mevcut): `lib/cognitive-lab-paired-delta.js`.
- Lab yüzeyi (mevcut): `lib/cognitive-lab-cli.js`; M4 ölçüm koşucusu PR-4'te bu yüzeye eklenir.
- Ölçüm corpus'u ve koşucu bu PR'da **yoktur**; PR-4'te üretilir ve §4'teki ayrım kurallarına uymak zorundadır.

Mevcut çekirdek sabitleri olduğu gibi kullanılır. Üretim kodu, eşik, model, varsayılan, wiring, `reachability`/ledger/baseline, güvenlik kapıları veya onay akışı bu PR ile değişmez. Unutma **her zaman** geri alınabilir arşivdir; `restore` ile geri döner, silme yoktur.

## 2. Donmuş retention kontratı

Aşağıdaki sabitler `lib/cognition/forgetting-score.js` ve `lib/memory-consolidation.js` içinde uygulandığı gibi **kesinlikle dondurulur**:

| Alan | Değer |
| --- | --- |
| `SCHEMA_VERSION` | `huqan-cognition-forgetting-v1` |
| `USAGE_FLOOR` | `0.2` |
| `USAGE_HALF` | `2` |
| `FORGET_THRESHOLD` | `0.05` |
| `REPLAY_PROTECT_DAYS` | `30` |
| `REPLAY_PROTECT_FLOOR` | `0.5` |
| `PROTECTED_KINDS` | `['policy','capability']` |
| `DEFAULT_RETENTION_HALF_LIFE_DAYS` | `90` |
| `DEFAULT_CANDIDATE_STATUSES` | `['superseded']` |
| `DEFAULT_LIMIT` / `MAX_LIMIT` | `50` / `500` |

**Davranış kuralları (donmuş):**

1. `retention = importance * recency * usage`. `importance` yalnız açık `importance` **ve** beyan edilmiş `importanceSource` ile bilinir; confidence veya |valence| yerine geçemez.
2. Bilinmeyen önem → `ABSTAIN` (`importance_unknown`), `eligible=false`; yaşlanma bu korumayı geçemez.
3. Bilinmeyen `recency`/`uses` indirim uygulamaz (faktör 1) ve `unknownComponents` içinde raporlanır.
4. Uygunluk korumaları sırayla: `active` değilse, `policy`/`capability` ise, `pinned` ise, dependency görünümü boolean değilse veya `dependencyProtected` ise → `eligible=false` (skor ne olursa olsun).
5. Yakın replay (`replayedWithinDays ≤ 30`) skoru `REPLAY_PROTECT_FLOOR`'a yükseltir.
6. Korumaları geçen ve `retention < FORGET_THRESHOLD` olan kayıt adaydır; sıra `retention asc`, `createdAt asc`, `memoryId`.
7. `opts.retention` yoksa veya `enabled !== true` ise seçici **bayt-bayt aynıdır** (yalnız `superseded`).
8. Mutasyon yalnız `MemoryLifecycle.archive` (fişli) üzerinden; `opts.dryRun === false` olmadan hiçbir şey arşivlenmez.

## 3. Hipotez H1 (§9, niyetle aynen)

> Unutma sonrası held-out sorgularda recall@k **non-inferior** (marj §6) iken varsayılan okuma kümesi **küçülür**.

- **Aday kol (candidate):** `opts.retention.enabled === true`; `MemoryLifecycle.consolidate({ dryRun:false, retention })` düşük skorlu `active` kayıtları fişli arşive taşır. Gerçek arşiv/geri-yükleme yolu üzerinden **gerçekten yürütülür**.
- **Taban kol (control):** `retention` yok; varsayılan seçici (yalnız `superseded`). Aynı gerçek yol, aynı sorgu seti, aynı `k`.
- **Ana ölçü A (kalite):** held-out sorgular üzerinde `recall@k` (doğru kayıt ilk `k` içinde); düşük daha kötü. Karar **non-inferiority** ile verilir.
- **Ana ölçü B (etki):** varsayılan okuma kümesi boyutu (arşiv sonrası görünür `active` kayıt sayısı); küçülme beklenir.
- **Guard (bütünlük):** sonradan geri yükleme gereken arşiv oranı (`restoreRate`) ≤ `RESTORE_RATE_MAX` (§6).
- **Yardımcı ölçüler (etiket belirlemez):** arşivlenen kayıt sayısı, `ABSTAIN` sayısı, koruma nedenleri, dry-run `total`/`scanned`.
- **Kapsam dışı iddialar:** unutmanın genel zeka/öğrenme kazancı olduğu; salt okuma kümesini küçültmenin tek başına kazanç sayıldığı; M4 sinyalinin üretim kararıyla ilişkisi.

## 4. İzleme / nihai holdout ayrımı (sızıntı koruması)

- **İzleme probe kümesi:** kalibrasyon/pilot split; yalnız `sigma` ve `N_required` tahminini besler. Nihai değerlendirme holdout'u değildir.
- **Nihai holdout:** kaynak/görev grubu düzeyinde izleme kümesinden ayrılır. `corpusDigest` ve grup düzeyi `groupDigest` değerleri, holdout açılmadan **önce** kalibrasyon manifestinde (`wx`, tek kullanımlık) kaydedilir ve commit edilir.
- **Örtüşme yasak:** izleme probe'ları ile nihai holdout aynı `sourceGroup`'u paylaşamaz; koşucu örtüşmeyi `REJECT` ile reddeder.
- **Erişim sınırı:** nihai holdout girdileri, etiketleri ve ara/toplu sonuçları seçiciye, `retention` eşiklerine veya model/eşik seçimine **verilmez**. Eşikler, yarı-ömür ve bütçe dondurulduktan sonra yalnız değerlendirme yolu holdout'u açar.
- **Yeniden kullanım:** sonuçlara göre yeni ayar yapılırsa o set geliştirme verisi olur; yeni bağımsız holdout olmadan doğrulayıcı kazanç iddiası kurulamaz. Tüketilmiş holdout tekrar kullanılmaz.
- **Negatif test:** holdout sonuçlarını adaptif döngüye beslemek izolasyon testini **bozmalıdır**; holdout etiketlerini değiştirmek değerlendirme öncesi seçimi **değiştirmemelidir**.

## 5. Örnek birimi ve güç gerekçesi

- **Birim:** bağımsız eşli **grup** (kaynak grubu × sorgu ailesi). Tekil kayıtlar/sorgular bağımsız örnek sayılmaz; aynı gruptaki kayıtlar birlikte taşınır.
- **Taban:** `minimumPairedGroups = 24`. Altında → `INSUFFICIENT`.
- **Güç formülü (dondurulmuş):** `N_required = ceil(((z_0.975 + z_0.80)² × σ̂²) / δ²)`, `δ = 0.05` (recall@k için mutlak marj), `z_0.975 ≈ 1.96`, `z_0.80 ≈ 0.8416`; `σ̂` yalnız **kalibrasyon gruplarında** koşulan pilot koşudan gelir (holdout'a dokunmaz).
- **Kural:** `N = max(24, N_required)`. Gerçek eşli grup sayısı `N_required`ın altındaysa sonuç `INSUFFICIENT`'tır; pilot yalnız varyans tahmini içindir, eşik/kol seçmez.
- Pilot koşu holdout'u açamaz ve sonuçları bu belgeye eklenmez; yalnız `σ̂` ve `N_required` manifestte kaydedilir.

## 6. Donmuş eşli kontrat

Eşli farklar mevcut `lib/cognitive-lab-paired-delta.js` üzerinden alınır; kontrat sonuç görülmeden dondurulur:

| Alan | Değer |
| --- | --- |
| `method` | `seeded-paired-bootstrap` |
| `seed` | `40701` |
| `resamples` | `2000` |
| `confidenceLevel` | `0.95` |
| `meaningfulEffect` (recall@k) | `0` |
| `nonInferiorityMargin` (recall@k) | `0.05` |
| `minimumSamples` | `24` (eşli grup) |
| `direction` | `higher-recall-is-better` |
| `recallK` | `3` |
| `RESTORE_RATE_MAX` | `0.05` |

Bilinmeyen alan, eksik alan veya skorlama anında seçilmiş eşik → `REJECT`. Eşleşmeyen kollar (farklı sorgu seti, farklı `k`, farklı corpus) `REJECT` edilir.

## 7. Karar kuralları (sonuç görülmeden, öncelik sırası)

1. **REJECT** — bütünlük ihlali (`firewall bypass > 0` veya `approval bypass > 0`), kol uyuşmazlığı, izleme/holdout kaynak-grubu örtüşmesi, eksik `corpusDigest`/`groupDigest`, **geri alınamayan mutasyon** (fişsiz arşiv veya `restore` ile dönmeyen kayıt).
2. **INSUFFICIENT** — eşli grup sayısı `N_required` altında, boş/kapalı holdout, karşılaştırılabilir çift yok.
3. Aksi halde eşli bootstrap CIs hesaplanır:
   - `recallDelta = candidateRecall@k − controlRecall@k` (pozitif = aday daha iyi)
   - `shrink = controlReadSetSize − candidateReadSetSize` (pozitif = aday okuma kümesini küçültmüş)
4. **GAIN** — `lower(recallDelta) > −margin` (non-inferior) **ve** `mean(shrink) > 0` **ve** `restoreRate ≤ RESTORE_RATE_MAX`.
5. **HARM** — `upper(recallDelta) < −margin` (recall anlamlı düşük). Zarar da kazanç kadar görünür raporlanır.
6. **NOT_CLEARED** — diğer tüm durumlar (ör. non-inferior ama okuma kümesi küçülmedi).
7. `assertsGain` bu belgede **asla** `true` değildir. Yalnız PR-4 sonuç belgesi `GAIN` + G3 birleşik kabulü raporlarsa, varsayılan/terfi kararı ayrı bir PR'da değerlendirilir (§10).

## 8. Antivakalar ve G3 katkısı

- **Uniform önem:** her kayıt aynı (yüksek) öneme sahipse hiçbir kayıt `FORGET_THRESHOLD` altına inmez → `shrink = 0` → **NOT_CLEARED** (kazanç uydurulmaz).
- **Gerekli-kayıt corpus'u:** düşük skorlu kayıtlar sorgu hedefleriyle çakışıyorsa recall düşer → **HARM**.
- **Bilinmeyen önem:** `importanceSource` yoksa `ABSTAIN`; arşivlenmez → `shrink = 0` → **NOT_CLEARED**.
- **Koruma (pin/dependency):** `pinned`/`dependencyProtected`/`policy`/`capability` kayıtlar hiç arşivlenmez; `skipped` nedenleri raporda görünür.
- **Geri alınabilirlik:** her arşiv fişli ve `restore` ile dönmelidir; dönmeyen kayıt `REJECT`'tir. `dryRun` varsayılanı değişmez.
- **Sızıntı negatif testleri:** §4'teki iki negatif test (holdout besleme, etiket değiştirme) PR-4'te çalıştırılır ve raporlanır.
- **Restart / replay:** yeni süreç aynı corpus/seed ile aynı karşılaştırılabilir durumu kurmalı; bilinmeyen kayıtlar sessizce doldurulmaz.

## 9. Önceden belirlenen kabul koşulları (PR-4)

1. Her iki kol **gerçek yürütme yolu** üzerinden gerçekten koşar (`MemoryLifecycle.consolidate`/`archive`/`restore`); yalnız-tavsiye kolu puanlanamaz.
2. Aynı corpus, aynı seed ile iki koşuda ve gerçek CLI girişi (`bin/huqan-cognitive-lab.js`) üzerinden bayt-bayt aynı JSON'u üretir (saat/rastgelelik/store sızıntısı yok).
3. Holdout izolasyonu kanıtlanır: kaynak-grubu örtüşmesi `REJECT`, holdout sonucu besleme izolasyon testini bozar, holdout etiketi değişimi değerlendirme öncesi seçimi değiştirmez.
4. Mutasyon testi: aday kolda arşiv adımını devre dışı bırakmak uçtan-uca ölçümü **bozmalıdır** (aday == taban → `shrink = 0`).
5. Rapor zorunlu alanları: `corpusDigest`, `groupDigest`, `N_required`, eşli grup sayısı, `recallDelta` nokta tahmini ve %95 CI, `shrink` ortalaması, `restoreRate`, bütünlük sayaçları, antivaka metrikleri, `GAIN`/`HARM`/`NOT_CLEARED`/`INSUFFICIENT`/`REJECT` etiketi.
6. `assertsGain`, varsayılan terfi, wiring, ledger/baseline ve güvenlik eşikleri PR-4'te **değişmez**.

## 10. Sonuçların eklenmemesi ve takip

- Sonuçlar bu belgeye sonradan eklenmez; PR-4 sonuç belgesine yazılır.
- #4070, §10 kabul kararı verilene kadar açık kalır.
- Varsayılan/terfi kararı yalnız ön-kayıtlı `GAIN` **ve** G3 birleşik kabulü sonrası, ayrı PR'da değerlendirilir.

## 11. Bağlama notu

Bu PR yalnızca dokümantasyon değişikliğidir: (1) yeni `docs/task-packs/cog-m4-retention-preregistration-20261031.md` ve (2) `lib/cognition/forgetting-score.js` içinde **yalnızca sabitlerin üstündeki yorum** — "(PR-1)" atfını bu dosya adıyla değiştirmek. Hiçbir sabit, fonksiyon, export, test veya davranış değişmez; wiring, ledger, baseline ve `opts.retention` semantiği aynı kalır.
