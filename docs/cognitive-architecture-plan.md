<!-- Program contract. Tracking: epic #4060, GitHub Project https://github.com/users/ali-ulu/projects/7. Module bodies live in issues #4061–#4071. -->

# HUQAN Bilişsel Mimari Programı: Uygulama Planı (COG)

**İlk kaynak keşfi:** `origin/main 94855e3e`, 2026-10-19. **Plan düzeltmesi:** 2026-10-19; doğrulanan main `21bc2c0a85def1706781eed1bcdaf8862e8e20d0`. Aşağıdaki işler uygulama planıdır; COG modüllerinin tamamlandığı veya kazanç sağladığı iddia edilmez.

**Kanıt dili (EVID-001):** GÖZLENDİ = kaynakta okundu. TÜRETİLDİ = okunan koddan çıkarıldı. VARSAYILDI = doğrulanmadı.


---

## Kararlar (Ali, 2026-10-19)

- **S1 → Manifest v2 ek blok.** `cognitiveMechanisms` (M1..M11: `ENABLED|DISABLED|NOT_MEASURED`); v1 manifestleri ve B1..B8 builder'ları aynen çalışır (Faz 0 PR-0c).
- **S2 → Ayrı epic.** #3306 kapalı; bu program onun ardılıdır (Cognitive Lab, scheduler #3311, B4 #3310, I5 #3469 temelinde).
- **S4 → Kod doğru, belge düzelsin.** Dream deney döngüsü varsayılan AÇIK kalır; checkpoint/belgedeki "opt-in" ifadesi docs PR'ında düzeltilir.
- **S12 → Core'a sabitle.** `lib/memory-cognitive-message.js`, `scripts/architecture-dependency-graph.js` Core `files` listesine açıkça eklenir (Faz 0 PR-0a); M1 mevcut K1 zarfını yeniden kullanır.
- **S3 → Tek ad alanı:** AgentV3 için `opts.cognition`; çevrimdışı replay ve retention kendi operatör yüzeylerinde kalır. Bilinmeyen/uyumsuz bayraklar reddedilir.
- **2026-10-19 plan düzeltmesi:** önce G1 uçtan uca geri bildirim dilimi; ardından M11/M6, M5'in gerçek yürütme yolu ve çevrimdışı modüller. G3 birleşik sistem kabulü olmadan epic tamamlanmaz. Ayrıntılar §7 ve modül issue'larındadır.
- S5–S11 için sorumlular ve uygulama önkoşulları §9'da belirlenmiştir; açık bağlama kalemi tamamlanmış yetenek olarak raporlanamaz.

## 0. Kaynak gerçekliği bulguları (plana girmeden önce bilinmesi gerekenler)

Bu bölüm ilk kaynak keşfinin tarihli bulgularıdır; çözüm kararları yukarıdaki kararlar ve §7/§9'da yer alır. Tarihli dosya/satır/sayaç bilgileri uygulama sırasında yeniden ölçülür.

1. **Dream deney döngüsü fiilen varsayılan olarak AÇIK; "opt-in" değil (GÖZLENDİ).**
   - `agent.v3.js:43` → `this.dreamExperimentLoop = opts.dreamExperimentLoop !== false;`
   - `lib/dream-experiment-loop.js:342-346` → `loopEnabled` yalnız `false` verilirse ya da graph'ta `runMutationOnce` yoksa kapanıyor.
   - `docs/current-agent-checkpoint.json` (#969) ve görev tanımı bunu "opt-in" diye anlatıyor. Bu bir kaynak çelişkisi; bakımcıya raporlanmalı.
   - M10 planı döngünün varsayılan açık olduğunu varsayıyor.
2. **Cognitive Lab manifesti yalnız B1..B8'i kabul ediyor (GÖZLENDİ).** `lib/cognitive-lab-manifest.js` içindeki `MECHANISM_IDS` ve `validateMechanisms` hepsini zorunlu tutuyor, bilinmeyen kimliği reddediyor. Yani yeni modüller manifest değişmeden kendi mekanizma bayrağını alamaz (bkz. Faz 0 PR-0c; S1 kararı: manifest v2).
3. **`agent.v3.js` 386 satır; 400 satırlık tavan var (GÖZLENDİ).** `docs/architecture-policy.md` §2 ve `scripts/check-file-size.js` bu tavanı uyguluyor. Mantık Application halkasındaki ince seam'e gider. İki yaşam döngüsü noktası kullanılır: sıradaki adımdan önce hazırlık, gözlenmiş sonuçtan sonra güncelleme. 400 satır tavanı korunur; satır sayısı uğruna gerekli kontrol akışı atlanmaz.
4. **`lib/cognition/` dizini hiçbir halka kuralına uymuyor (GÖZLENDİ).** `scripts/architecture-dependency-graph.js` içindeki `RULES` alt dizinleri yakalamıyor; Core yalnız düz `lib/*.js` kalıbını tutuyor. Atanmamış modül gate'i düşürür. Faz 0'da Core `dirs` listesine `lib/cognition/` eklenmeli.
5. **`lib/memory-*.js` Adapters halkasında (GÖZLENDİ, `pattern: /^lib\/(memory|sqlite)-/`).** Core'daki `lib/cognition/*` modülleri `memory-recency-decay.js`, `memory-consolidation.js` ya da `memory-cognitive-message.js`'i **require edemez**. Karar: yaşlanma faktörünü çağıran (Adapters) hesaplayıp saf çekirdeğe parametre olarak geçer.
   - **Uygulamadan önce teyit edin:** M1 `memory-cognitive-message.js`'teki `validateCognitiveMessage`'ı yeniden kullanmayı öneriyor. Bu dosya da `memory-` önekli, yani Adapters. Core'daki `percept.js` onu bu kurala göre require edemez. S12 kararı: dosya Faz 0 PR-0a'da Core `files` listesine açıkça sabitlenir (açık dosya girdisi kalıptan önce eşleşir); M1 doğrulamayı doğrudan yeniden kullanır.
6. **Bellek kayıtlarında kullanım sayacı yok (GÖZLENDİ).** `lib/memory-*.js` içinde `accessCount`, `lastAccessed` ya da `usageCount` yok. M4'ün "kullanım" boyutu için veri kaynağı yok (Açık soru S6).
7. **Risk skoru (0–100) kalibre olasılık değil (GÖZLENDİ).**
   - `prediction-outcome-pairs.js` bunu "risk estimate" olarak tanımlıyor.
   - `docs/task-packs/cognitive-lab-entry-20261001.md` "Belief posterior veya verify verdict certainty doğrudan outcome prediction p olamaz" diyor.
   - Bu yüzden M2 risk skorunu yalnız kategorik hataya çevirir.
8. **Bu alanda zaten bir program var (GÖZLENDİ).** #3306 programı: I1 scheduler #3311, B4 #3310, I5 #3469, K0/K1 #3470/#3471. ENGINEERING-001 gereği issue açmadan önce `gh issue list --search "3306"` ile çakışma kontrol edilmeli (S2 kararı: ayrı epic, #3306'nın ardılı).
9. **Ortak bilişsel zarf zaten var (GÖZLENDİ).** `lib/memory-cognitive-message.js` (K1) içinde `validateCognitiveMessage`, `compareReferenceFrames`, `REFERENCE_FRAME_FIELDS` bulunuyor. M1 yeni bir zarf **icat etmemeli**, bunun üstüne kurulmalı. Halka uyarısı için madde 5'e bakın.
10. **NOT_YET_WIRED defteri şu an 6 kayıt (GÖZLENDİ).** Kaynak: `config/reachability-baseline.json`, `measuredNotYetWired: 6`, ölçüm 2026-10-19. Checkpoint hâlâ 9 diyor; eskimiş.
    - Bağlama statiktir: bir modül `agent.v3.js` grafına require ile girdiği anda (opt-in olsa bile) erişilebilir sayılır.
    - Ledger'da kalırsa "stale acknowledgement" hatası verir. Yani "bağlanınca çıkar" kuralı otomatik zorlanıyor.

---

## 1. Program özeti

HUQAN'a insan beyninin bilişsel döngüsünden esinlenen 11 **sinyal/sıralama/öneri** modülü eklenir: tahmin hatası, ödül, değer, algı, dikkat, çalışma belleği, global workspace, Sistem1/Sistem2, pekiştirme, unutma ve merak.

Hiçbir modül eylem yetkisi almaz:
- Firewall (`evaluateAgentActionFirewall`), risk sınıflandırıcı (`classifyAgentAction`), onay kapıları ve `reflective-promotion` admission'ı son söz olarak kalır.
- Saf çekirdekler `lib/cognition/` altında Core halkasındadır. Application seam'i `lib/agent-cognition-seam.js`; graph okuyan adapter'lar `lib/cognition-prediction-error-pairs.js` ve `lib/cognition-value-ledger-pairs.js` olarak bu dizinin dışındadır. Halka atamaları açıkça yapılır; adapter'lar Core saflık istisnası sayılamaz.
- Faz 1–3'te ikinci bir kalıcı biliş deposu yoktur. Doğrulanmış sonuçlar mevcut yetkili prediction-outcome / experience yollarından kaydedilir; değer ve dikkat durumu bu kayıtlardan yeniden türetilir. Checkpoint mevcut koşu durumunu taşır; yeni olay alanı gerekiyorsa uyumluluk ve yazım sahibi aynı bağlama işinde gösterilir.
- Her modül önce opt-in'dir. Cognitive Lab'de paired-delta ile kazanç kanıtlanmadan varsayılan yapılmaz.

## 2. Mimari diyagram

```
                         ┌──────────────── MEVCUT OTORİTELER (son söz) ─────────────────┐
                         │ agent-action-firewall · risk-classify · approval runtime      │
                         │ reflective-promotion/canary-admission · Graph.runMutationOnce │
                         └───────────────▲───────────────────────────────▲──────────────┘
                                         │ (yalnız mevcut kuyruk/öneri)  │ (yalnız aday girdi)
 SENSÖRLER (mevcut)                      │                               │
 file-effect-sensor ─┐            ┌──────┴──────── lib/cognition (Core, saf) ──────┴─────────┐
 browser-observer ───┤  adapters  │ M1 percept ─► M7 salience ─► M11 working-memory ─► M6 GW │
 ingest/company ─────┼──────────► │      ▲             ▲  ▲                         │ yayın  │
 step report ────────┤            │ M2 prediction-error│  │                         ▼        │
 prediction-outcome ─┘            │      │            M9 value-ledger ◄── M8 reward  M5 S1/S2│
                                  │      └──────────────┴────────────────────────────┘ öneri │
                                  │ Faz4 (çevrimdışı): M3 replay · M4 forgetting · M10 merak  │
                                  └──────┬───────────────────┬──────────────────┬────────────┘
                                         ▼                   ▼                  ▼
                       cognitive-scheduler       memory-consolidation   dream-experiment-loop
                       (urgency; merak ayrı iz)  (retention adayları)   (hipotez sırası)
                       experience/router          → MemoryLifecycle      cli-promote (terfi)
                                                    .archive (fişli, geri alınabilir)
 ÖLÇÜM: cognitive-lab-manifest · paired-delta · b4/b6-evaluator · budget-envelope
```

## 3. Bilişsel döngü (HUQAN eşlemesi)

```
1 algıla   : sensör/step report ──► M1 percept (K1 CognitiveMessage + reference frame)
2 tahmin   : step/hipotez/prosedür beklentisi (risk skoru, p, LearnedCausalEngine.forward, beklenen dosya etkisi)
3 hata     : M2 prediction-error (signedError/magnitude/surprise) ; M8 rpe = r − V(M9)
4 dikkat   : M7 salience (sürpriz+hedef+risk+uyarılma+yenilik−alışma)
5 sahne    : M11 working-memory (sınırlı, sönümlü) ─► M6 global workspace (ateşleme+yayın)
6 S1/S2    : M5 dual-process-router → derlenmiş prosedür (router.decideRoute) | plan+dünya modeli+onay
7 eylem    : sıradaki adım öncesi güncel öneriyi uygula → mevcut firewall/onay → executor
8 sonuç    : file-effect-sensor / recordOutcome / experience journal
9 hafıza   : gözlenmiş sonucu mevcut journal'a bağla → M9'u geçmişten güncelle → sonraki adımda M7/M5 tüketir
10 çevrimdışı: M3 öncelikli replay → aday → reflective-promotion ; M4 unutma → archive ; M10 merak → Dream hipotez sırası
```

## 4. Faz bağımlılık grafiği

```
Faz 0 (altyapı, M2 issue'su içinde PR-0a/0b/0c)
  │
Faz 1:  M2 ──► M8 ──► M9            (M9, M8'in rewardForOutcome'unu import eder; M8'in beklentisi çağırandan, M9'dan gelir → döngü yok)
          │      │      │
Faz 2:  M1 ◄─(M2)│      │
          └──► M7 ◄─────┘ (M2 özet + M9 arousal)
                 └──► M11 ──► M6
Faz 3:  M5 ◄── M2, M9, M7  (M6 aboneliği opsiyonel)
Faz 4:  M3 ◄── M2, M8, M9 ;  M4 ◄── M9 (+M3 replay etiketi opsiyonel) ;  M10 ◄── M2 (+M3 opsiyonel)
İlk davranış kabulü G1: M1 + M2 + M8 + M9 + M7 + mevcut scheduler + gerçek sonuç adapter'ı.
M11/M6 bağlaması ve genişleme G1 sonrası; M5 için G2; epic kapanışı için G3.
M4/M10 saf çekirdekleri bağımsız hazırlanabilir; varsayılan/başarı kararı G1 ve kendi ölçümlerini bekler.
```

## 5. Ortak kurallar (tüm issue'lar için geçerli)

- **Halka:** `lib/cognition/*` → Core. Yalnız Core modülleri require edilebilir: düz `lib/*.js` (`memory-`/`sqlite-` hariç) ve `schemas/`. S12 kararıyla saf `lib/memory-cognitive-message.js` Core `files` listesine açıkça sabitlenir. I/O adapter'ları ve `lib/agent-cognition-seam.js` ayrı halka atamalarıyla dizinin dışında tutulur.
- **Saflık:** `fs`, `child_process`, `net`, `http`, `../graph`, `../kernel`, `Date.now`, `Math.random` yasak. Zaman `now`/`at` parametresiyle, rastgelelik gerekiyorsa `createPairedSampler` (mulberry32) ile gelir. Bunu tek bir test (`test/cognition-purity.test.js`) statik taramayla zorlar.
- **Çıktı sözlüğü** (`lib/cognition/contract.js`):
  - `COGNITION_STATUS = { MEASURED, ABSTAIN, INSUFFICIENT, REJECT }`
  - `authority` alanı ∈ `SIGNAL_ONLY | OBSERVATION_ONLY | PROPOSAL_ONLY | ROUTING_ADVICE_ONLY | CANDIDATE_ONLY`
  - Çıktılar `Object.freeze`'lidir; girdiler mutate edilmez.
- **Opt-in:** AgentV3 tarafında tek ad alanı `opts.cognition = { predictionError, reward, value, percept, salience, workingMemory, workspace, dualProcess, curiosity }` kullanılır. `lib/cognition/cognition-config.js::resolveCognitionConfig` bunu katı biçimde çözer; bilinmeyen anahtar REJECT olur. Bayrak yoksa davranış byte-byte değişmez. Çevrimdışı modüller kendi giriş noktasında bayrak alır.
- **Seam:** `lib/agent-cognition-seam.js` (Application) iki yaşam döngüsü noktası sağlar. `prepareCognition` opt-in koşuda her sıradaki adım seçilmeden önce mevcut uygun kuyruğu güncel sinyallerle yeniden değerlendirir; `observeStepCognition` sonucu kaynak kaydıyla bağlayıp bir sonraki kararda kullanılacak durumu günceller. Bayrak kapalıyken mevcut sıra korunur. Onay bekleyen/başlamış adımlar, bütçeler ve kalan iş listesi korunur.
- **NOT_YET_WIRED:** Yeni modül çekirdek PR'ında `lib/module-reachability.js::NOT_YET_WIRED`'e gerekçeyle eklenir. `config/reachability-baseline.json` içindeki `measuredNotYetWired`/`unreachableTotal` aynı PR'da yeniden ölçülür. Bağlama PR'ında kayıt çıkarılır. Paralel PR'lar bu sayaçta çakışır, bu yüzden bu PR'lar sıralanmalı.
- **Branch:** AGENTS.md §3'teki stile uyulur: `productization/pr-cog-m2-prediction-error-core` gibi.
- **PR kapsamı:** Çekirdek (kod+test), bağlama (runtime), ön-kayıt (yalnız docs) ve Lab sonucu ayrı PR'lardır (AGENTS.md §8).
- **Ölçüm:** Her modülün bir ön-kaydı olur: `docs/task-packs/cog-mX-<ad>-preregistration-2026MMDD.md`. B6 belgesi şablon alınır ve eşikler ölçümden önce kilitlenir. Değerlendirici olarak mevcut `lib/cognitive-lab-b6-evaluator.js::evaluate` (ikili solved-rate, paired bootstrap), `lib/cognitive-lab-paired-delta.js::pairedCalibrationDelta` (Brier/ECE) ve B4 evaluator yeniden kullanılır. Yeni evaluator yalnız metrik farklıysa yazılır.

---

## 6. Faz 0: Ortak altyapı (M2 issue'sunun ilk PR'ları; epic'te de listelenir)

- **PR-0a (runtime-dışı gate):**
  - `scripts/architecture-dependency-graph.js` → Core kuralının `dirs` listesine `'lib/cognition/'`; `files` listesine `'lib/memory-cognitive-message.js'` (S12).
  - `scripts/architecture-tracker-baseline.json` güncellenir.
  - `lib/cognition/contract.js`: `COGNITION_STATUS`, `AUTHORITY`, `clamp01`, `round6`, `freezeResult`.
  - `test/cognition-purity.test.js`.
- **PR-0b:** `lib/cognition/cognition-config.js` (`resolveCognitionConfig`, `COGNITION_FLAGS`) ve `test/cognition-config.test.js`.
- **PR-0c (S1 kararı):** Cognitive Lab manifestine bilişsel mekanizma kimlikleri:
  - `huqan-cognitive-lab-manifest-v2` içinde ek bir `cognitiveMechanisms` bloğu (`M1..M11`: `ENABLED|DISABLED|NOT_MEASURED`).
  - v1 manifestleri aynen kabul edilmeye devam eder.
  - B1..B8 builder'ları değişmez.

---



## 7. Uçtan uca teslim ve birleşik sistem kabulü

### G1 — İlk kapalı geri bildirim döngüsü (sahip: #4065; veri bağı: #4061/#4064; geçmiş: #4062/#4063)

İlk dilim: M1 → M2 → M8/M9 → M7 → mevcut scheduler → yetkili eylem → bağımsız gözlenmiş sonuç. M11/M6 bu dilimin önkoşulu değildir. Görev, yalnız sinyal üretmekle tamamlanmaz.

- Eylem öncesi beklenti; workspace, run, step/decision, görev/frame, kaynak ve model/prosedür sürümüne bağlanır. Sonradan gelen sonuç aynı kimlikle eşleşir; başka scope, bozuk kanıt, yinelenen veya sırası değişmiş olay öğrenmeyi çoğaltamaz.
- Sonuç önceki tahminden sonra gözlenmiş olmalıdır. Beklenen ödül yalnız o sonuçtan önceki geçmişten hesaplanır. Step'in `ok` raporu, self-verification veya eksik sonuç gerçek başarıya yükseltilemez; gözlem yoksa ABSTAIN/INSUFFICIENT.
- `observeStepCognition` sonrasında sıradaki adım seçilmeden önce `prepareCognition` güncel sinyali tüketir. Bütün uygun adımlar korunur; öneri yürütme yetkisi vermez.
- İlk değişen öğrenilmiş nesne M9'un geçmişten türetilen değer/destek durumudur; etkisi M7'nin sonraki seçimine izlenebilir biçimde yansır. M2 yalnız hata ölçer. Genel nöral ağırlık veya dünya modeli eğitimi bu sonuçtan çıkarılamaz.
- Gerçek üretim girişinden çalıştırılan senaryo: kontrollü beklenmedik sonuç → sonraki uygun seçim değişir → aynı bütçede hedef hata azalır. Baseline ve anti-vaka bulunur. Bildirimi/güncellemeyi etkisizleştiren dar mutasyon bu davranış testini kırmalıdır.
- Yeni süreç + Graph/journal reopen sonrasında aynı kaynak geçmişi aynı türetilmiş durumu üretir. Checkpoint yalnız kaldığı yerden devamı kanıtlar; ayrıca yeni koşuda geçmişten kazanımın korunması sınanır.
- Ölçülen düzelme, dondurulmuş ve öğrenmede kullanılmayan bağımsız görevlerde doğrulanır. Davranış farkı tek başına gain değildir.

### G2 — Gerçek Sistem 2 yolu (sahip: #4068)

M5'in tavsiye aşaması `ADVICE_ONLY` olarak raporlanır; Sistem 2'yi yürütmüş sayılmaz. Application sahibi mevcut `CausalRuntime`ı workspace/frame, journal ve receiver policy ile sağlar. Tek tutarlı snapshot üzerinden `CausalRuntime.compare/rollout` (veya mevcut `CausalSimulator.comparePlans/rolloutPlan` cephesi) kullanılır; sonuç mevcut plan/onay/yürütme akışına bağlanır.

Runtime, desteklenen plan veya gözlem yoksa görünür `deliberation_unavailable`/UNKNOWN ile durulur; sessiz S1 dönüşü ve yapılmamış iş için completed yoktur. Her gerçek eylemde güncel firewall/onay yeniden çalışır. M6 uzmanı kuyruğa yeni adım ekleyemez; plan kabulü yalnız mevcut yetkili host akışının sorumluluğudur.

G2 testi yüksek talep → doğrulanmış snapshot → alternatif plan seçimi → onay/yürütme → gözlenen sonuç zincirini ve unavailable/denial yolunu gerçek bağımlılıklarla göstermelidir. Maliyet üstünlüğü ancak aynı davranışı yürüten kollar arasında ölçülür; tavsiye kaydından maliyet kazancı çıkarılamaz.

### G3 — Program kapanış kapısı (sahip: #4060; bütün modüller katkı verir)

- Kollar: mevcut HUQAN; seçilmiş COG bileşimi; etkin bileşenlerin bağımlılıklarını koruyan tek-tek çıkarma karşılaştırmaları. İmkânsız bayrak birleşimleri deney kolu yapılamaz. Modül gain'leri toplanarak sistem gain'i ilan edilmez.
- Corpus: sınırları ilan edilmiş gerçek görevlerden türetilen bağımsız örnekler, başarısızlık/unknown/anti-vakalar ve daha sonra koşulan değişmiş ortam. Sentetik kontrol seti ayrıca raporlanır. Aynı görevin tekrarları bağımsız örnek sayılamaz.
- Eğitim, kalibrasyon, değerlendirme ve değişim dilimleri kaynak/grup düzeyinde ayrılır; eşikler, seed, budget, korunan eski beceriler ve ölçüm birimi sonuç görülmeden donar. Örnek sayısı ilan edilmiş asgari anlamlı etki ve güç hesabıyla gerekçelenir; küçük örnekler yalnız pilot/karakterizasyondur.
- Birincil ölçüm: bağımsız gözlenmiş görev başarısı/hata oranı. Maliyet: model/araç çağrısı, süre ve bellek ayrı raporlanır. Kuyruk sırası, tutulan öğe veya informative-result sayısı yardımcı ölçümdür.
- Bütünlük: sıfır yetki/onay bypass'ı, yanlış iş tamamlandı bildirimi ve scope sızıntısı. Bunlardan biri REJECT; küçük örneklem arkasına gizlenemez.
- Ortam değişiminden sonra uyum süresi; restart sonrası kazanım; eski görevlerde önceden belirlenen non-inferiority sınırı ve unutmanın yol açtığı geri yükleme ihtiyacı ölçülür.
- Nihai durum: `NOT_MEASURED | INSUFFICIENT | MEASURED_NO_GAIN | GAIN | REJECT`. GAIN yalnız ön-kayıtlı ortak kapı geçilirse; varsayılanı açma ayrı değerlendirilir.

### Tamamlanma kontrolü

- [ ] G1 gerçek sonuç, sonraki karar ve süreçler arası yeniden kurma zinciriyle geçti.
- [ ] G2 tavsiye aşamasından ayrı gerçek plan/yürütme ve unavailable yollarıyla geçti.
- [ ] M9 beklenen ödülü başarı olasılığına dönüştürmüyor; sonraki olay geçmişe sızmıyor.
- [ ] M4 bilinmeyen önemi açık uygunluk korumasıyla tutuyor.
- [ ] M10 aday kesiminden önce sıralıyor; sabit probe setinde ilerlemeyi görev seçimi değişiminden ayırıyor.
- [ ] G3 bileşim, maliyet, değişen ortam, restart ve eski beceri ölçümleri kaynak SHA/manifest ile raporlandı.
- [ ] Varsayılan/opt-in/donanım-dağıtım durumu ile ölçülmüş gain ayrı yazıldı.

### Bu programdan sonraya bırakılan kapasite

Sürekli nöral temsil/plastisite öğrenimi, iç ihtiyaçlardan hedef üretimi, geniş duyusal-motor çevrim ve farklı alanlar arasında genel aktarım bu 11 modülün teslimi sayılmaz. İleriki program bunların her biri için öğrenilen nesneyi, veri kaynağını, güncelleme kuralını, kabul ölçümünü ve mevcut yetki sınırını ayrı tanımlamalıdır. Bu kapsam sınırı G1–G3'ü veya mevcut güvenlik kapılarını gevşetmez.

## Modül issue'ları

- [ ] #4061 Faz 1 · Tahmin hatası (COG-M2)
- [ ] #4062 Faz 1 · Ödül / RPE (COG-M8)
- [ ] #4063 Faz 1 · Değer defteri (COG-M9)
- [ ] #4064 Faz 2 · Ortak algı (COG-M1)
- [ ] #4065 Faz 2 · Dikkat/salience (COG-M7)
- [ ] #4066 Faz 2 · Çalışma belleği (COG-M11)
- [ ] #4067 Faz 2 · Global workspace (COG-M6)
- [ ] #4068 Faz 3 · Sistem1/2 (COG-M5)
- [ ] #4069 Faz 4 · Pekiştirme (COG-M3)
- [ ] #4070 Faz 4 · Unutma (COG-M4)
- [ ] #4071 Faz 4 · Merak (COG-M10)

**Project:** https://github.com/users/ali-ulu/projects/7 · **İlk iş:** #4061 PR-0a (halka kuralı + contract + purity testi)

## 8. Riskler ve azaltımlar

- **Antropomorfik aşırı iddia** ("beyin gibi düşünüyor").
  - Azaltım: EVID-001 dili kullanılır; her modül için gain ancak paired-delta `assertsGain:true` ise söylenir. Checkpoint `forbiddenClaims`'e "HUQAN has a brain-like cognitive architecture proven" eklenir.
- **Sinyalin kapıya sızması** (öğrenen kendi eşiğini gevşetir, B8).
  - Azaltım: purity testi ve "sinyal → firewall/risk/trust girdisi yok" testleri. Risk yalnız salience'ı artırır.
- **Dosya boyutu ve fan-out tavanı.** `agent.v3.js` 386 satır, `dream-experiment-loop.js` 368 satır.
  - Azaltım: seam dosyası, satır bütçesi kabul kriterlerinde.
- **Halka ihlali.** Core → Adapters/Application require'ı. `memory-cognitive-message.js` kalıp gereği Adapters halkasında.
  - Azaltım: Faz 0 PR-0a'da halka kuralı; `memory-cognitive-message.js` Core `files` listesine sabitlenir (S12); diğer `memory-*` modülleri için çağıran hesaplar ve parametre geçirir.
- **Paylaşılan sayaç çatışması.** `config/reachability-baseline.json` paralel PR'larda çakışır.
  - Azaltım: ledger değiştiren PR'lar sıralanır; Project'te "ledger kilidi" alanı.
- **Checkpoint şişmesi.** `state.cognition` her checkpoint'e yazılır.
  - Azaltım: tüm izler sınırlı (`MAX_*`); şema sürümü uyuşmazsa sıfırdan başlanır.
- **Düşük örnek gücü** (B6'da holdout n=9).
  - Azaltım: ön-kayıtta sabit minimumlar; INSUFFICIENT dürüstçe raporlanır.
- **Manifest değişikliğinin dalgası.** B1..B8 builder'ları etkilenebilir.
  - Azaltım: v2 eklemeli; v1 kabul edilmeye devam eder (S1).
- **Kopya otorite.** Value ledger kalıcılaşabilir.
  - Azaltım: Faz 1–3'te yeni `runMutationOnce` öneki yasak; türetilmiş model.
- **Dream "opt-in" belgesi yanlış** (Bulgu 1).
  - Azaltım: S4 kararı: kod doğru, belge düzeltildi; M10 etkisini bayrağa bağlar.

## 9. Kararlar ve bağlama sahipleri

- **S1/S2/S3/S4/S12 karara bağlandı:** v2 ek blok; ayrı epic; tek `opts.cognition`; Dream varsayılan açık; saf K1 Core'a açık atama. Bunlar yeniden açık soru gibi ele alınmaz.
- **S5 — #4071:** Çapraz koşu geçmişi mevcut olay kaydından türetilir. Relation/frame veya model sürümü eksikse bilinmeyen kalır; alan gerekiyorsa eklemeli şema, eski kayıt replay'i ve gerçek producer aynı PR'da kanıtlanır. Yeni biliş deposu kurulmaz.
- **S6 — #4070:** İlk dilimde kullanım bilinmiyorsa `usage=1` ve uyarı; yeni sayaç yok. Önem bilinmiyorsa `eligible=false` sert koruması. Audit QUERY'nin doğruluğu/kapsamı ayrıca kanıtlanmadan kullanım kaynağı kabul edilmez.
- **S7 — #4064/#4061, G1 önkoşulu:** Gerçek effect/outcome producer → aynı decision/step kimliği → ajan gözlemi zinciri bağlanır. Eksik receipt veya salt `ok` raporu ABSTAIN olur; alanın var olduğu varsayılamaz.
- **S8 — #4068, G2 önkoşulu:** Application seam/host mevcut CausalRuntime'ı sağlar; Core yalnız doğrulanmış snapshot/sonuç verisini tüketir. Bağlama ve unavailable yolu teslim edilmeden M5 yalnız tavsiyedir.
- **S9 — #4068/#4070:** Önce mevcut evaluator'ın amaç yönü/non-inferiority sözleşmesi yeniden kullanılır; farklı matematik gerçekten gerekirse dar ayrı evaluator. Başarı ve maliyet ölçümü birbirinin yerine geçirilemez.
- **S10 — #4069:** Planlanan `terfi --from-replay --dry-run` yalnız listeleme içindir; gerçek öneri/terfi mevcut açık operatör akışında. Uygulama ve arayüz kapsamı kendi PR'ında görünür olur.
- **S11 — #4070:** Mevcut MemoryLifecycle üzerinde opt-in retention ve varsayılan dry-run. CLI/MCP açılması ayrıca somut yüzey/uyumluluk kabulüyle yapılır; kütüphane testi arayüz teslimi sayılmaz.

---

## 10. GitHub Project alan önerisi

**Project:** "HUQAN Bilişsel Mimari (COG)". Bir epic: `[COG] Bilişsel mimari programı`. 11 issue: `[COG-M1]` … `[COG-M11]`.

| Alan | Tür | Değerler |
|---|---|---|
| Faz | Single select | `Faz 0 Altyapı`, `Faz 1 Öğrenme sinyali`, `Faz 2 Omurga`, `Faz 3 Karar`, `Faz 4 Çevrimdışı` |
| Modül | Single select | `M1 Algı` … `M11 Çalışma belleği` |
| Boyut | Single select | `S`, `M`, `L` |
| Durum | Single select | `Backlog`, `Bağımlılık bekliyor`, `Ön-kayıt`, `Çekirdek PR`, `Bağlama PR`, `Lab ölçümü`, `Varsayılan kararı`, `Bitti` |
| Lab sonucu (ek) | Single select | `NOT_MEASURED`, `INSUFFICIENT`, `MEASURED-kazanç yok`, `GAIN`, `REJECT` |
| Bağlama (ek) | Single select | `NOT_YET_WIRED`, `opt-in bağlı`, `varsayılan` |
| Ledger kilidi (ek) | Checkbox | `reachability-baseline` değiştiren açık PR var mı |

- Etiketler: `program:cog`, `faz:1`..`faz:4`, `modul:m1`..`modul:m11`.
- Issue başlık biçimi: `[COG-M2] Tahmin hatası sinyali — lib/cognition/prediction-error.js`.

