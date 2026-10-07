# R50 — Contradiction sensor ön-kaydı

**Status:** protokol, kaynak snapshot, etiketler ve eşikler ölçümden önce kilitlendi. Bu PR'da hiçbir A/B/C kolu çalıştırılmadı; ölçüm sonuçları PR2-PR4'te bu dosyanın sonuna eklenir.
**Base:** `origin/main` `045d724f` (issue [#3582](https://github.com/ali-ulu/huqan/issues/3582), roadmap anahtarı R50).
**Kapsam:** yalnız PR1 — donmuş ground-truth/evaluation sözleşmesi. Kollar, kalibrasyon, füzyon ve politika simülasyonu ayrı PR'lardır.

## 1. Soru

HUQAN'ın mevcut deterministic contradiction detector'ları, **outcome truth** üzerinde ölçüldüğünde ne kadar güvenilir? El ile verilmiş `confidence: 0.90/0.95` değerleri outcome probability gibi yorumlanmayacak; üç kol aynı donmuş holdout üzerinde karşılaştırılacak:

| Kol | Tanım |
|---|---|
| A | Mevcut fixed-confidence kuralları. Bugünkü detector coverage'ı ve bugünkü **beyan edilmiş** heuristic confidence. `probabilityKind = DECLARED_HEURISTIC` olarak işaretlenir; kalibre outcome probability olduğu iddia edilmez. |
| B | Aynı detector coverage ve aynı raw rule score; calibration split'te fit edilmiş donmuş score→P(contradiction) eşlemesi. |
| C | Preregistered deterministic feature'lar + HUQAN'a ait yerel `ridgeFit()` füzyonu + calibration. Raw füzyon çıktısı **score**'dur, probability değil; probability yalnız calibration split'te donmuş eşlemeden gelir. |

Temel invariantlar:

```text
rule signal != probability != policy
fusion intelligence != semantic discovery
```

C kolu yeni bir semantik ilişki keşfettiğini iddia etmez; yalnız mevcut sinyallerin ve preregistered metadata'nın insan etiketleriyle hangi kombinasyonlarda güvenilir olduğunu ölçer. Birincil karşılaştırma `C vs B`'dir; A'yı geçmek tek başına yeterli değildir.

**D kolu (R51):** #3583 (R51) hattı aynı donmuş holdout'a, öğretmenlerden öğrenmiş HUQAN'a ait bir anlam modelini D kolu olarak ekler. Bu ön-kayıt D kolunun **holdout'a erişim ve sızıntı kurallarını da dondurur**: D de train ve calibration ile fit edilir, holdout'u hiçbir eğitim/ayar/tuning aşamasında okuyamaz, ve eğitimde öğretmen olarak Jev/LLM/açık NLI modellerinin kullanılması **runtime bağımlılığı oluşturmadığı sürece** serbesttir. Bu dosyadaki "external model" yasağı yalnız runtime içindir.

## 2. Ground truth: donmuş corpus sözleşmesi

Kaynak snapshot, doğrudan `levh` sisteminden alınmış contradiction/gözden geçirme adaylarıdır. Her corpus kaydı **yalnız iddiaları** taşır:

```json
{
  "schemaVersion": "huqan-contradiction-eval-corpus-v1",
  "pairId": "pair:<hex16>",
  "pairDigest": "sha256:<hex64>",
  "pairGroupId": "group:<ad>",
  "source": { "system": "levh", "candidateId": "...", "snapshotDigest": "sha256:<hex64>", "triggerKind": "..." },
  "stored": { "text": "...", "subject": "...", "relation": "...", "sourceType": "...", "frameId": "..." },
  "incoming": { "text": "...", "subject": "...", "relation": "...", "sourceType": "...", "frameId": "..." },
  "split": "train",
  "samplingStratum": "representative"
}
```

Kayıt şekli **strict allowlist**'tir: tek bir fazla alan `corpus_leakage` ile reddedilir. Corpus; detector output, detector confidence, fusion score, model output, insan etiketi, split kimliği türevi feature veya policy band **içermez**. Etiketler ayrı artifact'tadır (`test/fixtures/contradiction-eval-v1.labels.json`), `pairId` ile anahtarlanır.

### Etiket semantiği

| Etiket | Anlamı |
|---|---|
| `CONTRADICTION` | Aynı entity/frame/slot kapsamında iki iddia birlikte doğru olamaz. |
| `NOT_CONTRADICTION` | Birlikte doğru olabilir; farklı kapsam/slot ya da yalnız lexical opposition olabilir. |
| `UNCERTAIN` | Karar için frame/time/entity/context yetersiz. |
| `INVALID_PAIR` | Malformed/duplicate/yanlış eşlenmiş/karşılaştırılamaz. |

Binary skorlamaya **yalnız** adjudicated `CONTRADICTION` ve `NOT_CONTRADICTION` girer. `UNCERTAIN` ve `INVALID_PAIR` yanlış prediction'a çevrilmez; exclusion reason olarak raporlanır. Mevcut conflict review `accepted/rejected` state'i detector correctness label'ı değildir ve bu korpusta **kullanılmamıştır**.

## 3. Freeze ve sızıntı kuralları

- Seçim kuralı `sha256-keyed-selection-v1`: her aday `sha256("contradiction-eval-v1|select|<seed>|<candidateId>")` anahtarına göre sıralanır, stratum hedefine göre ilk N alınır. Sıralama girdi sırasından bağımsızdır.
- İçerik dedup: `pairDigest`, `(stored, incoming)` iddia çiftinin kanonik digest'idir. Aynı içerik iki aday id'siyle gelirse tek pair'e iner ve **lexicographically küçük** `candidateId` tutulur.
- Split kuralı `sha256-group-bucket-v1`: `bucket = sha256("contradiction-eval-v1|split|<seed>|<pairGroupId>")` ilk 8 hex → uint32 → `% 100`. `bucket < 60` → `train`, `60..79` → `calibration`, `>= 80` → `holdout`. **Atama `pairGroupId` düzeyinde** yapılır, bu yüzden bir grup asla iki split'e düşemez (test bunu doğrular).
- Split ataması **etiket görmeyen** bir fonksiyondur; test bunu bir özellik olarak kilitler: tüm skorlanabilir etiketler ters çevrildiğinde hiçbir pair'in split'i değişmez.
- Seed `3582` olarak donmuştur ve builder'a dışarıdan geçilemez (`freeze_seed_locked`). Seed'i veya bucket sınırlarını değiştirmek ölçümü değiştirmektir.
- Holdout mühürlenir: `holdout.pairIds` ve `sealDigest` manifestte yayınlanır. `readerPolicy = train_and_calibration_only_until_final_evaluation`. Holdout hiçbir training/calibration/tuning aşamasında okunamaz; PR4 final değerlendirmesinde okunur.
- Kaynak snapshot kimliği **içerik kümesidir**, dosya sırası değil: adaylar `candidateId`'ye göre sıralanıp digest'lenir. Dosya yeniden sıralanırsa digest değişmez.
- Kaynak snapshot digest'i değişirse builder **sessizce yeni dataset üretmez**: `source_snapshot_mismatch` ile fail-closed olur. Yeni bir dataset ancak yeni bir `datasetVersion` (ve yeni bir ön-kayıt) ile doğar; `--refreeze` operatörün açık ve görünür kararıdır.
- **Blinded labeling contract:** etiketleyici yalnız iddia metnini ve metadata'yı görür; detector adı, heuristic confidence, A/B/C çıktısı, policy band, split ataması ve diğer etiketleyicinin etiketi gösterilmez. Bu korpusta etiketler, hiçbir detector bu pair'ler üzerinde **çalıştırılmadan** yazılmıştır; test, fixture yolunun `contradiction-rules`/`semantic-signals` modüllerini yüklemediğini mekanik olarak doğrular.
- **Holdout bağımsız inceleme sözleşmesi:** holdout etiketleri bağımsız bir gözden geçiren tarafından, split'ler donduktan sonra ve hiçbir kol çalıştırılmadan denetlenir; anlaşmazlık yalnız adjudication kaydıyla çözülür ve label dosyasının `provenance.adjudication` alanına işlenir. Bu PR'da durum `PENDING_INDEPENDENT_HOLDOUT_REVIEW`'dur ve öyle kalmalıdır: PR4 promotion gate'i bu alan `ADJUDICATED` olmadan yeşil sayılamaz.

## 4. Sample adequacy

Target sayı, veri snapshot'ı görülerek ön-kayıt öncesi belirlendi ve outcome'a bakılarak değiştirilmez. Hard rule:

- Split başına skorlanabilir minimum: `train >= 20`, `calibration >= 10`, `holdout >= 10`. Bu taban, Cognitive Lab kalibrasyon diliminin (`MIN_OBSERVED_RECORDS = 10`) altındadır: onun altındaki bir Brier/ECE bir ölçüm değil gürültüdür.
- Karşılanmıyorsa durum `INSUFFICIENT`'tır; builder `sample_insufficient` ile durur ve ölçülebilir görünen ama gürültü olan bir corpus üretmez.
- Split yeniden karıştırılmaz. Eksikse **daha fazla etiket toplanır** (kaynak snapshot büyütülür); az veri başarı/kazanç sayılmaz.

## 5. Metrikler

Detector ve kol bazında: TP/FP/TN/FN, precision, recall, false-positive rate, coverage, support n. Brier ve ECE **yalnız gerçek frozen pre-outcome probability** için hesaplanır; A kolunun beyan edilmiş heuristic confidence'ı parametrik olarak `DECLARED_HEURISTIC` işaretlenir ve Brier/ECE'ye sokulmaz. Risk sinyalleri contradiction ölçümüne sızmaz; evaluator yalnız contradiction-only sinyal alt kümesi üzerinde çalışır.

Exclusion sayaçları ayrı raporlanır: `UNCERTAIN`, `INVALID_PAIR`, eksik/ölçüm hatası. `lib/cognitive-lab-probability-calibration.js` (Brier/ECE, fail-closed `INSUFFICIENT`) ve `lib/cognitive-lab-paired-delta.js` (aynı decision seti, seeded paired-bootstrap CI, ECE non-inferiority) reuse edilir. CI/effect-size eşikleri burada, outcome görülmeden donar. Geçerli final durumlar: `MEANINGFUL_IMPROVEMENT`, `NO_MEANINGFUL_IMPROVEMENT`, `REGRESSION`, `INSUFFICIENT`. C'nin kazanması R50 close şartı değildir; ölçüm füzyonu reddedebilir (`FUSION_REJECTED_BY_MEASUREMENT`) ve issue yine başarıyla kapanabilir.

## 6. Feature sözleşmesi (PR3 için burada donar)

PR3 feature sırası, repo kodundaki `runContradictionRules` sırasıdır: `NUMERICAL_CONFLICT`, `VALUE_CONFLICT`, `TYPE_CONFLICT`, `NEGATION_CONFLICT`, `UNIT_CONFLICT`, `CAUSE_PREVENT_OPPOSITION`, `SEMANTIC_OPPOSITION`, `RELATION_INVERSION`, `PREDICATE_DRIFT`. Ardından bounded metadata: `contradictionSignalCount`, `maxSeverity`, `maxDeclaredConfidence`, `evidenceCount`, `sameSubject`, `sourceTypeKnown`, `sameSourceType`, `frameKnown`, `sameFrame`.

V1'de yasak: raw text token'ları, TF-IDF/embedding, opposition-pair kimliği, `candidateId`/kaynak yolu, insan etiketi/split id/reviewer id, external model/Jev/NLI skoru. `maxDeclaredConfidence` yalnız bir girdi feature'ıdır; probability olarak okunamaz.

## 7. Yetki sınırları

Bu iş yeni bir model veya epic değildir. Kapsam dışı: external model runtime bağımlılığı, network/LLM çağrısı, opposition vocabulary genişletme, `verify-native`/admission/canonical authority değişikliği, auto-block/auto-reject/auto-promotion, candidate çıktısını canonical memory'ye yazma, production `semantic-signals.js` davranışını değiştirme, "general semantic understanding" iddiası. C çıktısı mevcut model port sınırını korur: `kind = DETERMINISTIC`, `locality = LOCAL`, `authority = CANDIDATE_ONLY`, `canonical = false`, `modelCalls = 0`, `tokens = 0`, `externalCalls = 0`.

## 8. Donmuş PR1 artifact'ları

| Artifact | Rol |
|---|---|
| `test/fixtures/contradiction-eval-v1/source-snapshot.json` | Yazılan kaynak snapshot (yalnız iddialar, detector çıktısı yok). |
| `test/fixtures/contradiction-eval-v1/source-labels.json` | Yazılan etiketler (`candidateId` ile) + provenance. |
| `test/fixtures/contradiction-eval-v1.corpus.json` | Donmuş corpus (builder üretir). |
| `test/fixtures/contradiction-eval-v1.labels.json` | Donmuş etiketler (`pairId` ile) + provenance. |
| `test/fixtures/contradiction-eval-v1.manifest.json` | Digest'ler, split ataması, adequacy, holdout mührü, yetki sınırı. |
| `scripts/build-contradiction-eval-fixture.js` | Deterministik, fail-closed freeze. |
| `test/contradiction-eval-fixture.test.js` | Sözleşme testleri. |

Donmuş değerler (manifest ile birebir):

```text
seed            3582
selection       sha256-keyed-selection-v1
split           sha256-group-bucket-v1  (<60 train, <80 calibration, >=80 holdout)
candidates      118   (110 benzersiz pair; 8 authored duplicate dedup ile düştü)
selected        108
splits          train 73 (63 skorlanabilir: 22 C / 41 NC), calibration 20 (16: 5/11), holdout 15 (13: 5/8)
excluded        16 (UNCERTAIN 12, INVALID_PAIR 6 sınıfından gelen kayıtlar)
floors          train 20, calibration 10, holdout 10  -> ADEQUATE
digests         corpus b61c4500... labels adc95e19... split b2b27527... protocol b051b5e6...
                sourceSnapshot 25e7d939... holdout seal 060c9ff4...
```

## 9. PR1 kabul durumu

- [x] Donmuş kaynak snapshot + digest (içerik kümesi digest'i, sıradan bağımsız).
- [x] Deterministik seeded seçim (`sha256-keyed-selection-v1`).
- [x] Pair/group dedup (içerik digest'i ile 8 duplicate düştü).
- [x] Label-before-split leakage yok (split etiket görmeyen bir fonksiyon; ters etiket testi split'leri değiştirmiyor).
- [x] Blinded labeling contract (provenance'ta `blindedTo`; test fixture yolunun detector yüklemediğini doğrular).
- [x] Holdout bağımsız inceleme/adjudication sözleşmesi (durum `PENDING_INDEPENDENT_HOLDOUT_REVIEW`).
- [x] Corpus/label/split/protokol digest testleri.
- [x] Production davranışı değişmedi (`productionBehaviorChanged: false`; fixture yolu hiçbir runtime modülü çağırmaz).
- [x] Kaynak snapshot değişirse fail-closed (`source_snapshot_mismatch`).
- [x] Sample adequacy kapısı (`sample_insufficient`; donmuş corpus `ADEQUATE`).

## 10. Sınırlar (bu PR'ın iddia etmedikleri)

- **Sentetik ve katmanlı (stratified):** kaynak snapshot, `levh`'in canlı bir örnekleminden değil, etiketlenebilir sınıfları kapsayacak şekilde **elle yazılmış** 110 benzersiz pair'den oluşur. Doğal/representative bir örneklem değildir; `representative` stratum'ı pozitif ve negatif karışımı taşır ve lexical/scope/uncertain/malformed stratum'ları bilerek yanlıdır. Bu, A/B/C karşılaştırmasını geçerli kılar ama mutlak precision/recall değerlerini doğal dağılıma genelleştirmez.
- **Etiketleyici bu PR'ı yazan ajandır** (`agent:codebuff-r50-pr1`). Blinding **yapısaldır** (hiçbir detector bu pair'ler üzerinde çalıştırılmadan etiket yazıldı; test bunu mekanik olarak doğrular), epistemik değildir: etiketleyici detector ailelerinin adlarını bilmektedir. Holdout'un bağımsız adjudication'ı bu yüzden açık bir gereklilik olarak kayıtlıdır.
- PR1 hiçbir ölçüm sonucu üretmez; Brier/ECE, coverage veya kazanç iddiası bu PR'da yoktur.
- `UNCERTAIN` oranının yüksekliği (12 kayıt) örneklemin bir parçasıdır ve ölçümde exclusion olarak görünür; bu bir hata değildir.
- `scripts/build-contradiction-eval-fixture.js` yeni bir shipped paket yüzeyi açmaz: dev-only bir freeze aracıdır.

## 11. Sonuç

PR1 ölçüm yapmadığı için bu bölüm yalnız freeze durumunu kaydeder: corpus 108 pair ile dondu, split'ler `ADEQUATE` eşiğinin üzerinde, holdout mühürlendi ve manifest digest'leri ile birlikte yayınlandı. Doğrulama:

```bash
node scripts/build-contradiction-eval-fixture.js --check   # 0: donmuş dosyalar yeniden üretilebilir
node --test test/contradiction-eval-fixture.test.js        # 15/15 pass
```

A/B/C ölçümleri ve sonuç bölümü PR2 (A/B), PR3 (C) ve PR4 (karşılaştırma + politika simülasyonu) ile bu dosyaya eklenecektir; bu bölümün üstündeki hiçbir satır ölçümden sonra değiştirilemez.
