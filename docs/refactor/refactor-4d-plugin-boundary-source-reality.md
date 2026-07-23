# REFACTOR-4D: Plugin Boundary Source Reality

> **Gate:** REFACTOR-4D_PLUGIN_BOUNDARY_SOURCE_REALITY
> **Durum:** Read-only inventory (düzeltme v4)
> **Önceki gate:** REFACTOR-4C1_PACKAGE_TYPE_SURFACE_GREEN
> **Canonical main SHA:** `c76a6417a0fd4e06fd43d768a925fd82faace751`
> **Branch:** `docs/refactor-4d-plugin-inventory`

---

## 1. PluginManager Yüzeyi (`plugin.js`, 280 satır)

### 1.1 Export'lar

| Export | Tür | Açıklama |
|--------|-----|----------|
| `PluginManager` | class (default) | Ana plugin sistemi |
| `PluginManager.hashFile` | static function | SHA-256 dosya hash'i |
| `PluginManager.hmacSign` | static function | HMAC-SHA256 imza |
| `PluginManager.verifyPluginFile` | static function | Plugin bütünlük doğrulaması (hash + opsiyonel HMAC) |
| `PluginManager.isRuntimePluginFile` | static function | `.js` ama `.test.js`/`.spec.js` değil |

### 1.2 Constructor (satır 125-136)

```
this.kernel = kernel
this.plugins = []                          // kayıtlı plugin nesneleri
this._handlers = {}                        // { eventName: [plugin, ...] }
this.pluginSigningKey = env AXIOM_PLUGIN_SIGNING_KEY
this.productionPluginEnforcement = (NODE_ENV === 'production' || env AXIOM_PLUGIN_PRODUCTION_ENFORCEMENT === '1')
this.strictPlugins = productionPluginEnforcement OR env AXIOM_PLUGIN_STRICT !== '0'
```

Tüm 16 EVENTS hook'u için boş array initialize edilir.

### 1.3 16 Declared Hook (canonical `plugin.js` @ `c76a641`)

```js
const EVENTS = [
  'beforeLearn',
  'afterLearn',
  'beforeAsk',
  'afterAsk',
  'beforeDream',
  'afterDream',
  'beforeEmbedding',
  'afterEmbedding',
  'beforeIntrospect',
  'afterIntrospect',
  'beforePlan',
  'afterPlan',
  'beforeTask',
  'afterTask',
  'beforeAgentRun',
  'afterAgentRun',
];
```

**Not:** `init` EVENTS listesinde değildir. `register()` sırasında ayrı çağrılır (canonical `plugin.js` @ `c76a641`).
**Not:** `beforeVerify`, `afterVerify`, `beforeBackup`, `afterBackup`, `beforeRestore`, `afterRestore`, `onEdgeAdded`, `onContradiction`, `onConflict`, `capability:enabled`, `beforeCapabilityRun` — hiçbiri EVENTS listesinde yoktur.

### 1.4 Plugin Yükleme Akışı (`load(dir)`)

1. Dizin taranır, `isRuntimePluginFile` ile `.js` dosyaları filtrelenir
2. Her dosya için:
   - `verifyPluginFile()` → hash/imza doğrulaması (fail → skip, hata loglanır)
   - `require(filePath)` → plugin modülü yüklenir
   - `__verification` non-enumerable property olarak eklenir
   - `this.register(plugin)` çağrılır
3. `require()` hatası → plugin skip, hata loglanır (fail-open: diğer plugin'ler yüklenmeye devam eder)

### 1.5 Plugin Kayıt Akışı (`register(plugin)`)

1. `!plugin || !plugin.name` → erken dönüş, hata yok
2. Aynı isimli plugin zaten kayıtlıysa → sessizce skip
3. Production enforcement aktifse → `_hasVerifiedProvenance` kontrolü, başarısızsa **throw** (fail-closed: registration durur)
4. `_validatePluginDependencies` → eksik required capability varsa **throw** (fail-closed)
5. Opsiyonel capability'ler kontrol edilir, eksikse `console.warn`
6. `plugin.init(kernel, this)` çağrılır (varsa)
7. Her EVENTS hook'u için plugin'de o isimde fonksiyon varsa `_handlers[event]`'e eklenir

### 1.6 Hook Tetikleme

| Metod | Desen | Hata Davranışı |
|-------|-------|----------------|
| `emit(event, data)` | Her handler'a `plugin[event](kernel, data)` | **Fail-open**: hata `console.error` ile loglanır, sonraki handler'lar çalışır, orijinal `data` döner |
| `emitStrict(event, data)` | Pipeline: her handler'ın dönüş değeri sonrakine `nextData` olarak geçer | Handler throw ederse `emitStrict` patlar. `undefined` dönerse değişiklik olmaz. |

### 1.7 Plugin Dependencies Kontrolü

- `plugin.requires`: string[] — eksik capability → **throw** (fail-closed)
- `plugin.optional`: string[] — eksik capability → `console.warn` (fail-open)
- Her iki kontrol de `this.kernel.hasCapability(capability)` ile yapılır

### 1.8 Capability API

- `listCapabilities()`: `plugin.capabilities` array'ini flatMap'ler
- `getCapability(name)`: isme veya komuta göre capability arar
- `runCapability(name, input, opts)`: capability'yi bulur → plugin.run(kernel, input, opts) çağrısı

---

## 2. Kernel-Plugin Arayüzü (`kernel.js`)

### 2.1 PluginManager Başlatma

```js
this.plugins = new PluginManager(this);
if (opts.loadPlugins !== false) {
  const pDir = path.join(__dirname, 'plugins');
  if (fs.existsSync(pDir)) this.plugins.load(pDir);
}
```

### 2.2 Kernel'dan Plugin Hook Çağrıları

| Kernel Metodu | Hook | Mekanizma |
|---------------|------|-----------|
| `learn()` | `beforeLearn` | `emitStrict()` → pipeline, dönüş değeri payload'u modifiye eder |
| `introspect()` | `beforeIntrospect`, `afterIntrospect` | `emit()` |

**Not:** `enableCapability()` → `capability:enabled` emit'i `kernel.js`'de bulunur ama bu hook EVENTS listesinde olmadığı için `_handlers`'da karşılığı yoktur; hiçbir plugin tetiklenmez.

### 2.3 Kernel'ın Plugin'lere Açtığı Yüzey

| Kernel Metodu | Görünürlük |
|---------------|------------|
| `usePlugin(plugin)` | Public — plugin.enable() veya test helper'ları için |
| `listCapabilities()` | Public — pluginManager'a delege eder |
| `getCapability(name)` | Public — pluginManager'a delege eder |
| `runCapability(name, input, opts)` | Public — `requireCapability('pluginCapabilities')` gate'li |
| `proposeNode(id, label, provenance, opts)` | Public — plugin'ler için admission-gated node yazımı |
| `proposeEdge(from, to, relation, opts)` | Public — plugin'ler için admission-gated edge yazımı |
| `hasCapability(name)` | Public |
| `enableCapability(name)` | Public |
| `graph` | Public (doğrudan erişim) |
| `extractFacts(text, nodes)` | Public |
| `learnFromLLM(text, opts)` | Public |

### 2.4 Plugin'lerin Kernel'a Erişim Desenleri

**DOĞRUDAN ERİŞİM (private/internal API):**

| Plugin | Private Alan/Metod | Erişim Türü |
|--------|-------------------|-------------|
| `company-brain` | `kernel._companyIngestState` | Oku + Yaz |
| `company-brain` | `kernel._parsePredicate()` | Çağrı |
| `company-brain` | `kernel.graph?._nodes` | Oku |
| `repo-memory` | `kernel._companyIngestState` | Oku + Yaz |
| `contradiction-alert` | `kernel._parsePredicate()` | Çağrı |
| `contradiction-alert` | `kernel.graph?._nodes` | Oku |
| `devil-advocate` | `kernel.graph?._nodes` | Oku |
| `discovery-engine` | `kernel.graph?._nodes` | Oku |
| `idea-mri` | `kernel.graph?._nodes` | Oku |

**DELEGE ERİŞİM (public API):**

| Plugin | Public Metod | Kullanım |
|--------|-------------|----------|
| `company-brain` | `kernel.proposeNode()`, `kernel.proposeEdge()`, `kernel.graph.getEdges()`, `kernel.graph.getInEdges()`, `kernel.graph.getStats()`, `kernel.extractFacts()` | Graph yazma + okuma |
| `repo-memory` | `kernel.proposeNode()`, `kernel.proposeEdge()` | Graph yazma |
| `contradiction-alert` | `kernel.graph.getEdges()`, `kernel.extractFacts()` | Graph okuma |
| `devil-advocate` | `kernel.graph.getEdges()`, `kernel.extractFacts()` | Graph okuma |
| `discovery-engine` | `kernel.extractFacts()` | Fact çıkarma |
| `idea-mri` | `kernel.extractFacts()` | Fact çıkarma |
| `llm-memory (llm-memory-plugin.js)` | `kernel.learnFromLLM()`, `kernel.graph.getStats()` | Öğrenme + istatistik |
| `experiment-planner` | `kernel.hasCapability()` | Capability kontrolü |
| `replication-checker` | `kernel.hasCapability('evidenceRanking')` | Capability kontrolü |
| `result-analyzer` | `kernel.hasCapability('evidenceRanking')` | Capability kontrolü |

---

## 3. Plugin Envanteri (10 PluginManager-managed + 1 ayrı)

### 3.1 Plugin Tablosu

| # | Plugin | `requires` | `optional` | `init()` | `run()` | Hook'lar | Kernel Internal API |
|---|--------|------------|------------|----------|---------|----------|---------------------|
| 1 | `company-brain` | `['graph', 'companyMode']` | `['llm', 'temporal', 'evidenceRanking', 'contradictionDetection']` | Evet | Evet | Yok | `_companyIngestState`, `_parsePredicate()`, `graph._nodes` |
| 2 | `contradiction-alert` | `['graph', 'temporal']` | `['llm', 'evidenceRanking']` | Hayır | Evet | Yok | `_parsePredicate()`, `graph._nodes` |
| 3 | `devil-advocate` | `['graph']` | `['llm', 'evidenceRanking']` | Evet | Evet | Yok | `graph._nodes` |
| 4 | `discovery-engine` | Yok | Yok | Hayır | Evet | Yok | `graph._nodes` |
| 5 | `experiment-planner` | Yok | Yok | Hayır | Evet | Yok | Yok |
| 6 | `idea-mri` | `[]` | `['llm', 'graph', 'evidenceRanking']` | Hayır | Evet | Yok | `graph._nodes` |
| 7 | `llm-memory (llm-memory-plugin.js)` | Yok | Yok | Evet | Hayır | `afterAsk`, `afterLearn` | Yok |
| 8 | `replication-checker` | Yok | Yok | Hayır | Evet | Yok | Yok |
| 9 | `repo-memory` | `['graph', 'companyMode']` | `['llm', 'temporal', 'evidenceRanking']` | Hayır | Evet | Yok | `_companyIngestState` |
| 10 | `result-analyzer` | Yok | Yok | Hayır | Evet | Yok | Yok |

**Ayrı bileşen (PluginManager dışında):**

| Bileşen | Dosya | PluginManager ile İlişki |
|---------|-------|--------------------------|
| Sandbox runtime | `sandboxRunner.js` (root) | PluginManager üzerinden yüklenmez, ayrı mimari |

### 3.2 Manifest Dosyaları

Tüm 10 `.manifest.json` dosyası **sadece `sha256`** içerir. Hook, capability, veya metadata manifest'te değil, doğrudan `.js` dosyasında inline olarak tanımlanır.

### 3.3 Hook Kullanım Dağılımı

| Hook | Kullanan Plugin Sayısı | Plugin'ler |
|------|----------------------|------------|
| `beforeLearn` | 0 | — |
| `afterLearn` | 1 | `llm-memory (llm-memory-plugin.js)` |
| `beforeAsk` | 0 | — |
| `afterAsk` | 1 | `llm-memory (llm-memory-plugin.js)` |
| `beforeDream` | 0 | — |
| `afterDream` | 0 | — |
| `beforeEmbedding` | 0 | — |
| `afterEmbedding` | 0 | — |
| `beforeIntrospect` | 0 | — |
| `afterIntrospect` | 0 | — |
| `beforePlan` | 0 | — |
| `afterPlan` | 0 | — |
| `beforeTask` | 0 | — |
| `afterTask` | 0 | — |
| `beforeAgentRun` | 0 | — |
| `afterAgentRun` | 0 | — |

**Kullanılmayan 14 hook:** `beforeLearn`, `beforeAsk`, `beforeDream`, `afterDream`, `beforeEmbedding`, `afterEmbedding`, `beforeIntrospect`, `afterIntrospect`, `beforePlan`, `afterPlan`, `beforeTask`, `afterTask`, `beforeAgentRun`, `afterAgentRun`.

### 3.4 Plugin Capability'leri

| Plugin | Capability Adı | Komut |
|--------|---------------|-------|
| `company-brain` | `companyBrain` | `company-brain` |
| `company-brain` | `ingestStatus` | `ingest-status` |
| `contradiction-alert` | `contradictionAlert` | `celiski` |
| `devil-advocate` | `devilAdvocate` | `tartis` |
| `discovery-engine` | `discoveryEngine` | `discover` |
| `experiment-planner` | `experimentPlanner` | `plan-experiment` |
| `idea-mri` | `ideaMri` | `mri` |
| `replication-checker` | `replicationChecker` | `check-replication` |
| `repo-memory` | `repoMemory` | `repo-memory` |
| `result-analyzer` | `resultAnalyzer` | `analyze-result` |

### 3.5 Default Capability Setinde Yüklenemeyen Plugin'ler

Default Kernel capabilities'te `companyMode: false` ve `temporal: false` olduğu için:

| Plugin | Eksik Required Capability | Sonuç |
|--------|--------------------------|-------|
| `company-brain` | `companyMode` | Yüklenemez (throw) |
| `contradiction-alert` | `temporal` | Yüklenemez (throw) |
| `repo-memory` | `companyMode` | Yüklenemez (throw) |

**Not:** `idea-mri` `requires: []` olduğu için default'ta yüklenir. Opsiyonel capability eksikliği registration'ı engellemez, yalnız `console.warn` üretir.

### 3.6 Ulaşılamayan/Kullanılmayan Plugin Yüzeyleri

1. **14 kullanılmayan hook:** 16 hook'tan 14'ü hiçbir plugin tarafından kullanılmaz
2. **3 plugin default'ta yüklenemez:** `company-brain`, `contradiction-alert`, `repo-memory` (missing required capability)
3. **`kernel.enableCapability()` → `capability:enabled` emit'i:** EVENTS listesinde olmadığı için hiçbir plugin tetiklenmez

---

## 4. Plugin Hata Davranışı Matrisi

| Aşama | Hata Türü | Davranış | Sınıflandırma |
|-------|-----------|----------|---------------|
| `load()` — verifyPluginFile | Hash/imza uyuşmazlığı | Plugin skip, `console.error` | Fail-open (diğer plugin'ler yüklenir) |
| `load()` — require() | Module yükleme hatası | Plugin skip, `console.error` | Fail-open |
| `register()` — production enforcement | Manifest yok | **throw** | Fail-closed (registration durur) |
| `register()` — dependency check | Eksik required capability | **throw** | Fail-closed |
| `register()` — optional check | Eksik optional capability | `console.warn` | Fail-open |
| `emit()` — handler throw | Plugin hatası | `console.error`, sonraki handler'lar çalışır | Fail-open |
| `emitStrict()` — handler throw | Plugin hatası | **throw** (pipeline kırılır) | Fail-closed (çağıran kodda) |
| `runCapability()` — capability bulunamaz | Unknown capability | **throw** | Fail-closed |
| `runCapability()` — plugin.run throw | Plugin execution hatası | **throw** (plugin.run'dan yayılır) | Fail-closed |

---

## 5. `PLUGIN_VERIFY_CORRECTION_LOOP_CANDIDATE` Altyapı Sınırı

**Mevcut durum:**
- `afterVerify` hook'u **EVENTS listesinde tanımlı değil** (canonical `plugin.js` @ `c76a641`)
- `beforeVerify` hook'u da **tanımlı değil**
- `devil-advocate` plugin'i `beforeVerify` kullanmıyor; sadece `init()` ve `run()` var
- Mevcut hook sözleşmesinde verify öncesi/sonrası plugin müdahalesi için hook yoktur

**Düzeltme döngüsü için eksikler:**
1. `afterVerify`/`beforeVerify` hook'u sözleşmede yok — önce EVENTS listesine eklenmesi gerekir
2. `emit()` fail-open — düzeltme döngüsünde hata yutulursa verify sonucu değişmez
3. `emitStrict()` pipeline — dönüş değeri manipülasyonu mümkün ama verify sonrası feedback loop için yetersiz (verify sonucu değiştikten sonra tekrar verify çağrısı yapacak mekanizma yok)
4. Plugin'lerin verify sonucunu değiştirip kernel'a geri beslemesi için `kernel.verify()` çağrısı yapması gerekir → döngüsel çağrı riski

**Sonuç:** Mevcut altyapı `afterVerify` hook'unu **teknik olarak desteklemiyor** — hook sözleşmesinin kendisi bulunmuyor. Düzeltme döngüsü için:
- EVENTS listesine `afterVerify`/`beforeVerify` eklenmesi gerekir
- `emitStrict` pipeline modeline geçiş veya yeni bir `emitCorrective` mekanizması gerekir
- Döngü koruması (max iterasyon, çağrı derinliği limiti) eklenmelidir
- Plugin'lerin verify sonucu üzerinde yazma yetkisi olup olmadığı netleştirilmelidir

---

## 6. Kaynak Gerçeklik Özeti

1. **Manifest vs Runtime kopukluğu:** Manifest dosyaları sadece SHA256 içerir, tüm metadata plugin JS dosyasındadır. Manifest'ten bağımsız doğrulama yapılamaz.
2. **Fail-open ağırlıklı sistem:** `emit()`, `load()` hataları, opsiyonel capability eksikliği — hepsi fail-open. Sadece `register()` aşamasındaki dependency check ve production enforcement fail-closed.
3. **Kernel internal API erişimi geniş kapsamlı:** 6 plugin (`company-brain`, `repo-memory`, `contradiction-alert`, `devil-advocate`, `discovery-engine`, `idea-mri`) `kernel._` veya `kernel.graph?._nodes` gibi private alanlara erişiyor.
4. **14 kullanılmayan hook:** 16 hook'tan 14'ü hiçbir plugin tarafından kullanılmaz. Sadece `afterLearn` ve `afterAsk` kullanılıyor (ikisi de `llm-memory (llm-memory-plugin.js)` tarafından).
5. **`afterVerify` hook sözleşmesi yok:** Hook EVENTS listesinde tanımlı değil, "declared but unused" değil "not declared" durumundadır.
6. **3 plugin default'ta yüklenemez:** `company-brain`, `contradiction-alert`, `repo-memory` (missing required capability). `idea-mri` yüklenir (`requires: []`).
7. **Plugin bağımlılıkları:** Plugin'ler arasında runtime capability çağrısı zinciri yoktur. Her plugin bağımsız çalışır.
8. **Sandbox ayrı konumda:** `sandboxRunner.js` root'ta, PluginManager üzerinden değil; plugin sisteminin parçası değil.
9. **`capability:enabled` emit'i boşa çalışıyor:** `kernel.js`'de `emit('capability:enabled', ...)` çağrılıyor ama bu event EVENTS listesinde olmadığı için hiçbir handler tetiklenmez.

---

## 7. Doğrulanmayanlar

| Madde | Sebep |
|-------|-------|
| Plugin'lerin production ortamındaki gerçek davranışı | Sadece CI logları ve kaynak kod analizi |
| `AXIOM_PLUGIN_SIGNING_KEY` ile imzalı plugin yükleme | Test ortamında imzalı plugin yok |
| `emitStrict` pipeline'ın gerçek dönüş değeri zinciri | Sadece kod analizi; `beforeLearn` dışında kullanılmıyor |
| Plugin'lerin eşzamanlı yükleme race condition'ları | Test ortamında tek thread |

---

## 8. Sonraki Gate için Zarf

```
[BAĞLAM]  REFACTOR-4D_PLUGIN_BOUNDARY_SOURCE_REALITY tamamlandı.
          Canonical main: c76a6417a0fd4e06fd43d768a925fd82faace751
[GÖREV]   REFACTOR-4D_IMPLEMENTATION: Plugin boundary contracts
          (bu inventory'deki bulgulara dayalı)
[KABUL]   TBD — Lead Engineer tanımlayacak
[YASAK]   Plugin refactorı, yeni hook, afterVerify implementasyonu,
          4E4 işleri, LLM feedback loop
[SÜRÜM]   docs/refactor/refactor-4d-plugin-boundary-source-reality.md
          SHA256: (commit sonrası doldurulacak)