# REFACTOR-4D: Plugin Boundary Contract Acceptance Criteria

> **Gate:** REFACTOR-4D_IMPLEMENTATION_CONTRACT_ACCEPTANCE
> **Durum:** Acceptance criteria — complete
> **Canonical main SHA:** `740760799edfd268dc9af4000ebc727663d69ad1`
> **Branch:** `refactor/4d-1-contract-acceptance`
> **Source reality:** `docs/refactor/refactor-4d-plugin-boundary-source-reality.md`

---

## 1. Plugin Boundary Contract Objectives

1. PluginManager kayıt akışı ve hook sözleşmesini test edilebilir şekilde sabitle.
2. Kernel→Plugin ve Plugin→Kernel arayüzü için public/private sınırı netleştir.
3. Required/optional capability davranışını fail-open/fail-closed matrisinde açıkça testle.
4. Private `_` alan ve `_nodes` erişimini minimum güvenli public seam'e çek.
5. Manifest/runtime metadata kopukluğunu belgele ve uyumluluğu koru.

Bu bölüm yön gösterir; kapanış şartı yalnızca Bölüm 2'deki ölçülebilir
kriterlerdir.

---

## 2. Acceptance Criteria

Her kriter PASS/FAIL olarak ölçülür. Belirsiz bırakılmış kriter kabul edilmez.

### AC-1: EVENTS contract

| # | Şart | PASS | FAIL |
|---|------|------|------|
| 1.1 | `plugin.js` içindeki canonical `EVENTS` dizisinin uzunluğu | tam olarak **16** | 16 dışında herhangi bir değer |
| 1.2 | EVENTS isimleri | `beforeLearn`, `afterLearn`, `beforeAsk`, `afterAsk`, `beforeDream`, `afterDream`, `beforeEmbedding`, `afterEmbedding`, `beforeIntrospect`, `afterIntrospect`, `beforePlan`, `afterPlan`, `beforeTask`, `afterTask`, `beforeAgentRun`, `afterAgentRun` — sıra ve isim birebir aynı | herhangi bir ekleme, silme, yeniden adlandırma |
| 1.3 | `afterVerify` ve `beforeVerify` | EVENTS içinde **yok** | listeye eklenmiş |
| 1.4 | 4D kapsamında yeni hook | **tanımlanmaz** | herhangi bir yeni event adı eklenmiş |
| 1.5 | `init` | EVENTS dışında kalır, `register()` sırasında ayrı çağrılır | EVENTS'e taşınmış |

### AC-2: Hook execution semantics

| # | Şart | PASS | FAIL |
|---|------|------|------|
| 2.1 | `emit()` fail-open | bir handler throw ederse hata yakalanır, `console.error` yazılır, kalan handler'lar çalışmaya devam eder | istisna çağırana sızar veya zincir kırılır |
| 2.2 | `emit()` dönüş değeri | girdi `data` referansı değişmeden döner | handler dönüşü ile değiştirilir |
| 2.3 | `emitStrict()` fail-closed | handler istisnası **yakalanmaz**, çağırana propagate olur | try/catch eklenerek yutulur |
| 2.4 | `emitStrict()` pipeline | handler dönüşü `undefined` değilse `nextData` olarak zincirlenir, `undefined` ise önceki değer korunur | zincirleme davranışı değişir |
| 2.5 | Legacy uyumluluk | `llm-memory` plugin'inin `afterAsk` ve `afterLearn` davranışı değişmeden çalışır | mevcut çağrı imzası veya sırası değişir |

### AC-3: Registration and loading

| # | Şart | PASS | FAIL |
|---|------|------|------|
| 3.1 | `requires` içindeki capability eksik | `register()` **throw** eder, mesaj eksik capability adını içerir | sessizce geçilir veya yalnızca warn üretir |
| 3.2 | `optional` içindeki capability eksik | `console.warn` üretilir ve registration **devam eder** | throw eder veya hiç uyarı vermez |
| 3.3 | Production manifest enforcement aktif ve doğrulanmamış plugin | `register()` **throw** eder, `error.code === 'PLUGIN_UNVERIFIED_REGISTRATION'` | doğrulanmamış plugin kayıt olur |
| 3.4 | `load()` sırasında hash/imza uyuşmazlığı | **yalnızca o plugin** skip edilir, hata loglanır, **diğer plugin'lerin yüklenmesi devam eder** | tüm yükleme durur veya bozuk plugin yüklenir |
| 3.5 | `load()` sırasında `require()` hatası | aynı fail-open davranışı: o plugin skip, diğerleri yüklenir | yükleme tümüyle durur |
| 3.6 | Aynı isimli plugin ikinci kez | sessizce skip edilir (mevcut davranış korunur) | duplicate kayıt oluşur |

### AC-4: Capability boundary

| # | Şart | PASS | FAIL |
|---|------|------|------|
| 4.1 | `kernel.hasCapability()` public davranışı | imza ve dönüş semantiği değişmeden kalır | davranış değişir |
| 4.2 | Plugin içi capability sorgusu | yalnızca public `kernel.hasCapability()` üzerinden yapılır | private alana doğrudan erişilir |
| 4.3 | Required capability semantiği | en az bir adlandırılmış contract test tarafından kapsanır | testsiz kalır |
| 4.4 | Optional capability semantiği | en az bir adlandırılmış contract test tarafından kapsanır | testsiz kalır |
| 4.5 | `capability:enabled` | EVENTS dışında olduğu için ulaşılamaz durumu **belgelenir, 4D'de düzeltilmez** — yetkili uygulama kapsamı dışındadır | 4D içinde EVENTS'e eklenir veya guard değiştirilir |

### AC-5: Private access migration

| # | Şart | PASS | FAIL |
|---|------|------|------|
| 5.1 | Migration granülaritesi | her PR'da **tek sınırlı consumer** | birden fazla consumer aynı PR'da |
| 5.2 | Public seam ekleme | yalnızca mevcut public API yetersizse, **en küçük** seam eklenir | geniş yeni API yüzeyi açılır |
| 5.3 | Davranış kanıtı | parity testleri gözlemlenebilir davranışın değişmediğini kanıtlar | parity testi yok |
| 5.3a | Explicitly Approved Isolation Narrowing | yalnızca `docs/refactor/acceptance-amendment-4d-ingestmanual-narrowing.md` (PR #85) ile yetkilendirilen `ingestManual` use-case'inde: (1) mevcut davranış source audit ile kanıtlanmış, (2) davranışın public/binding contract olmadığı kanıtlanmış, (3) narrowing güvenlik veya tenant/workspace izolasyonunu güçlendiriyor, (4) yeni geniş public API açılmıyor, (5) characterization testiyle daraltma kapsamı ölçülüyor, (6) üç mutation guard'ın üçü de RED (raw `_nodes` / `getNodes('tenant-a')` / explicit `'default'` argümanının düşürülmesi — bkz. amendment Bölüm 5.4), (7) insan onayı (amendment PR bağımsız review) var, (8) PR açıklamasında "parity" değil "intentional narrowing" deniyor | koşullardan herhangi biri eksik |
| 5.4 | Toplu migration | **yasaktır** | tek PR'da toplu `_nodes`/`_` erişim değişimi |
| 5.5 | Kapsanan private erişimler | `graph._nodes` (company-brain, contradiction-alert, devil-advocate, discovery-engine, idea-mri), `_companyIngestState` (company-brain, repo-memory), `_parsePredicate()` (company-brain, contradiction-alert) — her biri ayrı PR'da | envanter dışı erişim sessizce değiştirilir |

> **AC-5.3a açıklaması:** AC-5.3 unchanged'dır; AC-5.3a onun yanına eklenen
> dar bir istisnadır. AC-5.3'ü gevşetmez. İstisna yalnızca `ingestManual`
> use-case'i için yetkilendirilmiştir; gelecekteki narrowing durumları için
> precedent olarak kullanılabilir, ama her seferinde ayrı bir amendment
> kararı gerekir. Detaylı koşullar ve characterization test tasarımı
> `docs/refactor/acceptance-amendment-4d-ingestmanual-narrowing.md`
> Bölüm 4 ve Bölüm 9'da verilmiştir.

### AC-6: Manifest / runtime compatibility

| # | Şart | PASS | FAIL |
|---|------|------|------|
| 6.1 | Mevcut 10 `.manifest.json` | yalnızca `sha256` alanı içeren biçim çalışmaya devam eder | zorunlu yeni alan eklenir |
| 6.2 | Legacy inline runtime metadata | hook/capability/metadata `.js` içinde inline tanımlı kalabilir | manifest'e taşınması zorunlu kılınır |
| 6.3 | Shared-key imzalı manifest doğrulama | HMAC doğrulama yolu kapsamda kalır ve testlidir | kaldırılır veya testsiz bırakılır |
| 6.4 | Yeni manifest platformu / permission sistemi | **eklenmez** | yeni şema veya izin modeli girer |

### AC-7: Plugin compatibility

| # | Şart | PASS | FAIL |
|---|------|------|------|
| 7.1 | PluginManager-managed 10 plugin | `company-brain`, `contradiction-alert`, `devil-advocate`, `discovery-engine`, `experiment-planner`, `idea-mri`, `llm-memory`, `replication-checker`, `repo-memory`, `result-analyzer` — her biri mevcut `requires`/`optional` capability önkoşulları altında mevcut load/register davranışını korur | mevcut davranış değişir |
| 7.1a | Default capability setinde yüklenemeyen plugin'ler | `company-brain`, `contradiction-alert`, `repo-memory` — default sette yüklenememeleri beklenen davranıştır, regresyon sayılmaz | bu davranış "bozuk" olarak işaretlenir veya değiştirilir |
| 7.1b | `idea-mri` | `requires: []` olduğu için yüklenir | yüklenemez duruma düşer |
| 7.2 | `llm-memory` | `afterAsk` / `afterLearn` davranışı uyumlu kalır | davranış değişir |
| 7.3 | `sandboxRunner` | PluginManager kapsamı **dışında** kalır | PluginManager'a bağlanır |
| 7.4 | Compatibility inventory | açıklanamayan regresyon yok | açıklamasız fark var |

### AC-8: Scope protection

| # | Şart | PASS | FAIL |
|---|------|------|------|
| 8.1 | `afterVerify` / `beforeVerify` | eklenmez | eklenir |
| 8.2 | 4E1, 4E2, 4E3, 4E4 işleri | bu gate'te yapılmaz | herhangi biri karışır |
| 8.3 | Dependency / package / release değişikliği | yapılmaz | `package.json`, lockfile veya release artefaktı değişir |
| 8.4 | İlişkisiz refactor | yapılmaz | kapsam dışı dosya değişir |

---

## 3. Gate Completion

`REFACTOR-4D_PLUGIN_BOUNDARY_CONTRACT_TESTS` yalnızca aşağıdaki şartların
**tamamı** sağlandığında GREEN olur:

1. Bölüm 2'deki her acceptance kriteri, bir veya daha fazla **adlandırılmış
   evidence** ile eşleştirilmiştir (kriter → evidence haritası PR açıklamasında
   yer alır). Evidence türleri:
   - automated contract test
   - targeted regression test
   - compatibility test
   - changed-files scope review
   - diff inspection
   - source-reality verification
   - CI/security/benchmark result

   Runtime davranış kriterleri automated test ile eşleştirilmelidir.
   Process ve scope-protection kriterleri explicit review evidence ile
   eşleştirilebilir.

   Örnekler:
   - AC-2.1 → automated fail-open test
   - AC-3.1 → automated required-capability test
   - AC-5.1 → single-consumer changed-files review
   - AC-5.3 → automated parity test (gözlemlenebilir davranış değişimi yok)
   - AC-5.3a → intentional narrowing characterization test + üç mutation guard + legacy fallback compatibility testi (yalnızca `ingestManual` use-case'i için, amendment PR #85 yetkisiyle)
   - AC-8.2 → forbidden-scope diff review
   - AC-8.3 → package/lockfile absence review
2. Hedefli contract testler geçer.
3. Tam test suite (`npm test`) geçer.
4. Security Checks başarılıdır.
5. Benchmark Regression başarılıdır **(koşullu)** — bkz. Bölüm 4. Yalnızca
   performance-sensitive değişiklikler için gerçek benchmark çalışması
   gerekir; diğer PR'larda `NOT_APPLICABLE` kabul edilir.
6. Compatibility inventory'de açıklanamayan regresyon yoktur.

Bu altı şarttan biri eksikse gate GREEN sayılmaz.

---

## 4. Conditional CI Gate Policy

`Benchmark Regression` gate'i her PR'da blocking kontrol olarak çalışmaz.
`docs/refactor/refactor-4d-contract-acceptance.md` ile birlikte
`.github/workflows/benchmark.yml` aşağıdaki koşullu politikayı uygular:

| Yüzey | Tetiklenen CI | Zorunlu mu? |
|---|---|---|
| Runtime değişiklikleri (`kernel.js`, `graph.js`, `plugin.js`, `plugins/**`, `lib/**`, `nlp/**`, `packages/**`, `migrations/**`, `schemas/**`, vb.) | `npm test` + `Benchmark` | Her ikisi de zorunlu |
| Test dosyaları (`test/**`, `*.test.js`, `*.spec.js`) | `npm test` | Zorunlu; benchmark `NOT_APPLICABLE` |
| Performance-sensitive alt küme (`benchmarks/**`, `graph.js`, `kernel.js`, `storage.js`, `causalSimulator.js`, `finalizer.js`, `rustGraph.js`, `lib/memory-store.js`, `lib/ingest.js`, `lib/causal/*`, `lib/provenance-*.js`, `lib/receipt/*`) | `npm test` + `Benchmark` | Her ikisi de zorunlu |
| Docker / package / deploy (`Dockerfile`, `docker-compose.yml`, `.dockerignore`, `package.json`, `package-lock.json`) | `Docker build` | Zorunlu; benchmark `NOT_APPLICABLE` |
| Docs-only (README, `docs/**`, COMMENTS, vb.) | Hiçbiri | Tüm gate'ler `NOT_APPLICABLE` |
| Karma değişiklikler | En az bir yüzey için tetiklenen gate'ler | Tetiklenen gate'ler zorunlu |

### 4.1 Status check surface'ları

Her üç gate (`npm test (runtime/test)`, `Benchmark`, `Docker build`) her
PR'da görünür durumdadır. Bir yüzey için değişiklik yoksa, ilgili job
`-skip` varyantı çalışır ve `NOT_APPLICABLE` summary'si yayınlar. Bu
sayede branch protection required status checks listesi sabit kalır;
docs-only PR'lar "skipped" yüzünden blocklanmaz.

### 4.2 Security Checks

`Security Checks` (`.github/workflows/security.yml`) bu koşullu politikaya
tabi değildir. Her PR'da ve her `main` push'unda zorunlu olarak çalışır.

### 4.3 Manual rerun

Bir PR'da `NOT_APPLICABLE` olarak işaretlenen bir gate'i manuel olarak
çalıştırmak için Actions sekmesinden `Benchmark Regression` workflow'unu
`Run workflow` ile tetiklemek yeterlidir. Bu, özellikle docs-only görünümlü
ama dolaylı olarak performansı etkileyebilecek değişiklikler için
güvenlik ağı sağlar.

### 4.4 Policy değişiklikleri

Bu politika `.github/workflows/benchmark.yml` ve bu dokümanla birlikte
sürdürülür. İki dosya senkron kalır; birinde yapılan değişiklik diğerinde
de yansıtılmalıdır. Politika değişikliği ayrı bir `chore/ci-*` branch'inde
yapılır ve runtime/migration koduyla aynı PR'a karıştırılmaz.
