<!-- Program contract. Tracking: epic #4060, GitHub Project https://github.com/users/ali-ulu/projects/7. Module bodies live in issues #4061–#4071. -->

# HUQAN Bilişsel Mimari Programı: Uygulama Planı (COG)

**Kaynak tabanı:** `origin/main 94855e3e`, 2026-10-19.

**Kanıt dili (EVID-001):** GÖZLENDİ = kaynakta okundu. TÜRETİLDİ = okunan koddan çıkarıldı. VARSAYILDI = doğrulanmadı.


---

## Kararlar (Ali, 2026-10-19)

- **S1 → Manifest v2 ek blok.** `cognitiveMechanisms` (M1..M11: `ENABLED|DISABLED|NOT_MEASURED`); v1 manifestleri ve B1..B8 builder'ları aynen çalışır (Faz 0 PR-0c).
- **S2 → Ayrı epic.** #3306 kapalı; bu program onun ardılıdır (Cognitive Lab, scheduler #3311, B4 #3310, I5 #3469 temelinde).
- **S4 → Kod doğru, belge düzelsin.** Dream deney döngüsü varsayılan AÇIK kalır; checkpoint/belgedeki "opt-in" ifadesi docs PR'ında düzeltilir.
- **S12 → Core'a sabitle.** `lib/memory-cognitive-message.js`, `scripts/architecture-dependency-graph.js` Core `files` listesine açıkça eklenir (Faz 0 PR-0a); M1 mevcut K1 zarfını yeniden kullanır.
- Kalan açık sorular (S3, S5–S11) ilgili modül issue'sunda kapatılır.

## 0. Kaynak gerçekliği bulguları (plana girmeden önce bilinmesi gerekenler)

Bunlar planın kararlarını belirliyor. Bazıları görevde verilen öncüllerle çelişiyor.

1. **Dream deney döngüsü fiilen varsayılan olarak AÇIK; "opt-in" değil (GÖZLENDİ).**
   - `agent.v3.js:43` → `this.dreamExperimentLoop = opts.dreamExperimentLoop !== false;`
   - `lib/dream-experiment-loop.js:342-346` → `loopEnabled` yalnız `false` verilirse ya da graph'ta `runMutationOnce` yoksa kapanıyor.
   - `docs/current-agent-checkpoint.json` (#969) ve görev tanımı bunu "opt-in" diye anlatıyor. Bu bir kaynak çelişkisi; bakımcıya raporlanmalı.
   - M10 planı döngünün varsayılan açık olduğunu varsayıyor.
2. **Cognitive Lab manifesti yalnız B1..B8'i kabul ediyor (GÖZLENDİ).** `lib/cognitive-lab-manifest.js` içindeki `MECHANISM_IDS` ve `validateMechanisms` hepsini zorunlu tutuyor, bilinmeyen kimliği reddediyor. Yani yeni modüller manifest değişmeden kendi mekanizma bayrağını alamaz (bkz. Faz 0 PR-0c; S1 kararı: manifest v2).
3. **`agent.v3.js` 386 satır; 400 satırlık tavan var (GÖZLENDİ).** `docs/architecture-policy.md` §2 ve `scripts/check-file-size.js` bu tavanı uyguluyor. Bağlantı en çok 2 çağrı satırı ekleyebilir; mantık bir seam dosyasına gitmeli.
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
- Tüm çekirdekler `lib/cognition/` altında saf ve deterministiktir (Core halkası). I/O ve graph okumaları çağıran tarafta (adapter/seam) kalır.
- Faz 1–3'te yeni kalıcı yazım yoktur. Değerler `prediction-outcome-pairs` ve experience journal'dan türetilen okuma modelleridir; ikinci otorite değildir.
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
                       (urgency/informationGain)  (retention adayları)   (hipotez sırası)
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
7 eylem    : MEVCUT AgentV3 döngüsü → firewall → executor (DEĞİŞMEZ)
8 sonuç    : file-effect-sensor / recordOutcome / experience journal
9 hafıza   : M9 value ledger (türetilmiş), M8 reward olayları (türetilmiş)
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
Paralellik: M4, M9 biter bitmez başlayabilir; M1, Faz 1 ile paralel yürüyebilir (fromPredictionError adapter'ı M2 sonrası).
```

## 5. Ortak kurallar (tüm issue'lar için geçerli)

- **Halka:** `lib/cognition/*` → Core. Yalnız Core modülleri require edilebilir: düz `lib/*.js` (`memory-`/`sqlite-` hariç) ve `schemas/`. Uyarı: bu kural `lib/memory-cognitive-message.js`'i de dışarıda bırakır (bkz. M1, S12).
- **Saflık:** `fs`, `child_process`, `net`, `http`, `../graph`, `../kernel`, `Date.now`, `Math.random` yasak. Zaman `now`/`at` parametresiyle, rastgelelik gerekiyorsa `createPairedSampler` (mulberry32) ile gelir. Bunu tek bir test (`test/cognition-purity.test.js`) statik taramayla zorlar.
- **Çıktı sözlüğü** (`lib/cognition/contract.js`):
  - `COGNITION_STATUS = { MEASURED, ABSTAIN, INSUFFICIENT, REJECT }`
  - `authority` alanı ∈ `SIGNAL_ONLY | OBSERVATION_ONLY | PROPOSAL_ONLY | ROUTING_ADVICE_ONLY | CANDIDATE_ONLY`
  - Çıktılar `Object.freeze`'lidir; girdiler mutate edilmez.
- **Opt-in:** AgentV3 tarafında tek ad alanı `opts.cognition = { predictionError, reward, value, percept, salience, workingMemory, workspace, dualProcess, curiosity }` kullanılır. `lib/cognition/cognition-config.js::resolveCognitionConfig` bunu katı biçimde çözer; bilinmeyen anahtar REJECT olur. Bayrak yoksa davranış byte-byte değişmez. Çevrimdışı modüller kendi giriş noktasında bayrak alır.
- **Seam:** AgentV3 bağlantısı `lib/cognition/agent-seam.js` (`prepareCognition`, `observeStepCognition`) üzerinden yapılır. `agent.v3.js`'e en çok 2 çağrı satırı eklenir.
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

## 9. Açık sorular

- **S1 (kapandı):** Cognitive Lab mekanizma kimlikleri → manifest v2 `cognitiveMechanisms` (M1..M11); bkz. Kararlar ve PR-0c.
- **S2 (kapandı):** #3306 ile ilişki → ayrı epic (#4060), #3306'nın ardılı; bkz. Kararlar.
- **S3:** `opts.cognition` tek ad alanı mı, `cognitiveScheduler` emsali gibi düz bayraklar mı? Plan tek ad alanını öneriyor.
- **S4 (kapandı):** Dream döngüsü varsayılan açık kalır; belge düzeltilir (checkpoint #969 girdisi güncellendi); bkz. Kararlar.
- **S5:** M10 çapraz koşu geçmişi için dream transition'larına `relation` alanı eklemek kalıcı şema değişikliği sayılır mı?
- **S6:** M4 "kullanım" verisi nereden gelecek? Seçenekler: recall okumalarını sayan yeni bir sayaç (yeni yazım yolu, ayrı onay gerekir) ya da audit `QUERY` olayları (trust-calibration "QUERY doğrulama değildir" diyor; kullanım için uygun olabilir). Karar verilene kadar kullanım "bilinmiyor = 1" kabul edilir.
- **S7:** AgentV3 step raporları `effectVerification`/dosya-etkisi gözlemi taşıyor mu? Bu gözlem external-action guard makbuzlarında var; step raporlarında doğrulanmadı.
- **S8:** SYSTEM2 yolunda `symbolic-world-model.compare` için `model` anlık görüntüsünü (forward + evaluatePolicy) AgentV3 bağlamında kim üretecek?
- **S9:** Maliyet-primer ve non-inferiority deneyleri (M5, M4) için b6 evaluator parametreleştirilmeli mi, yeni evaluator mı yazılmalı?
- **S10:** `terfi --from-replay` yeni bir operatör bayrağı; ürün yüzeyi kararı gerekir.
- **S11:** M4 için CLI `memory-lifecycle consolidate` retention bayrağı açılacak mı?
- **S12 (kapandı):** `lib/memory-cognitive-message.js` Faz 0 PR-0a'da `scripts/architecture-dependency-graph.js` Core `files` listesine sabitlenir; M1 K1 zarfını yeniden kullanır. Bkz. Kararlar.

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

