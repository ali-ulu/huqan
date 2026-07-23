# REFACTOR-4D: Plugin Boundary Source Reality

> **Gate:** REFACTOR-4D_PLUGIN_BOUNDARY_SOURCE_REALITY  
> **Durum:** Read-only inventory  
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

### 1.3 16 Declared Hook

```js
const EVENTS = [
  'init',                 // Plugin yüklendiğinde çağrılır
  'beforeLearn',          // Öğrenme öncesi (pipeline, emitStrict)
  'afterLearn',           // Öğrenme sonrası
  'beforeVerify',         // Doğrulama öncesi
  'afterVerify',          // Doğrulama sonrası — HİÇBİR PLUGIN'DE YOK
  'beforeIntrospect',     // İç gözlem öncesi
  'afterIntrospect',      // İç gözlem sonrası
  'beforeBackup',         // Yedekleme öncesi
  'afterBackup',          // Yedekleme sonrası
  'beforeRestore',        // Geri yükleme öncesi
  'afterRestore',         // Geri yükleme sonrası
  'onEdgeAdded',          // Kenar eklendiğinde
  'onContradiction',      // Çelişki tespit edildiğinde
  'onConflict',           // Çakışma durumunda
  'capability:enabled',   // Yetenek etkinleştirildiğinde
  'beforeCapabilityRun',  // Yetenek çalıştırılmadan önce
];
```

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
4. `_validatePluginDependencies` → eksik capability varsa **throw** (fail-closed)
5. Opsiyonel capability'ler kontrol edilir, eksikse `console.warn`
6. `plugin.init(kernel, this)` çağrılır (varsa)
7. Her EVENTS hook'u için plugin'de o isimde fonksiyon varsa `_handlers[event]`'e eklenir

### 1.6 Hook Tetikleme

| Metod | Desen | Hata Davranışı |
|-------|-------|----------------|
| `emit(event, data)` | Her handler'a `plugin[event](kernel, data)` | **Fail-open**: hata `console.error` ile loglanır, sonraki handler'lar çalışır, orijinal `data` döner |
| `emitStrict(event, data)` | Pipeline: her handler'ın dönüş değeri sonrakine `nextData` olarak geçer | **Fail-closed değil**: handler throw ederse `emitStrict` patlar. `undefined` dönerse değişiklik olmaz. |

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
| `enableCapability()` | `capability:enabled` | `emit()` |
| `learn()` | `beforeLearn` | `emitStrict()` → pipeline, dönüş değeri payload'u modifiye eder |
| `introspect()` | `beforeIntrospect`, `afterIntrospect` | `emit()` |
| `proposeNode()` | Yok (kernel iç callback) | Plugin'ler doğrudan `kernel.proposeNode()` çağırır |
| `proposeEdge()` | Yok (kernel iç callback) | Plugin'ler doğrudan `kernel.proposeEdge()` çağırır |

### 2.3 Kernel'ın Plugin'lere Açtığı Yüzey

| Kernel Metodu | Görünürlük |
|---------------|------------|
| `usePlugin(plugin)` | Public — plugin.enable() veya test helper'ları için |
| `listCapabilities()` | Public — pluginManager'a delege eder |
| `getCapability(name)` | Public — pluginManager'a delege eder |
| `runCapability(name, input, opts)` | Public — `requireCapability('pluginCapabilities')` gate'li |
| `proposeNode(label, opts)` | Public — plugin'ler için admission-gated node yazımı |
| `proposeEdge(from, to, relation, opts)` | Public — plugin'ler için admission-gated edge yazımı |
| `hasCapability(name)` | Public |
| `enableCapability(name)` | Public |
| `graph` | Public (doğrudan erişim) |

### 2.4 Plugin'lerin Kernel'a Erişim Desenleri

**DOĞRUDAN ERİŞİM (private/internal API):**
- `kernel._companyIngestState` — `company-brain` tarafından okunur/yazılır
- `kernel._parsePredicate()` — `company-brain` tarafından çağrılır
- `kernel.extractFacts()` — `company-brain`, `llm-memory-plugin` tarafından çağrılır
- `kernel.graph._nodes` — `company-brain` tarafından doğrudan okunur
- `kernel.graph.getEdges()`, `kernel.graph.getInEdges()`, `kernel.graph.getStats()` — public API

**DELEGE ERİŞİM (public API):**
- `kernel.runCapability()` — `llm-memory-plugin` içinde `companyBrain` capability'sini çağırmak için
- `kernel.learn()`, `kernel.verify()` — plugin'ler kernel'a geri çağrı yapar

---

## 3. Plugin Envanteri (11 Plugin)

| # | Plugin | Dosya | Gereksinimler | Opsiyonel | Kernel Erişimi | `afterVerify` |
|---|--------|-------|---------------|-----------|----------------|---------------|
| 1 | `company-brain` | `company-brain.js` | `graph`, `companyMode` | `llm`, `temporal`, `evidenceRanking`, `contradictionDetection` | Ağır (internal API) | Yok |
| 2 | `contradiction-alert` | `contradiction-alert.js` | `temporal`, `graph` | — | `kernel.graph` read-only | Yok |
| 3 | `devil-advocate` | `devil-advocate.js` | `graph` | `evidenceRanking` | `kernel.graph` read-only | Yok |
| 4 | `discovery-engine` | `discovery-engine.js` | `graph` | — | `kernel.graph` read-only | Yok |
| 5 | `experiment-planner` | `experiment-planner.js` | `graph` | — | `kernel.graph` read-only | Yok |
| 6 | `idea-mri` | `idea-mri.js` | `graph` | `evidenceRanking` | **Test-only** (runtime'da kullanılmıyor) | Yok |
| 7 | `llm-memory-plugin` | `llm-memory-plugin.js` | `llm`, `graph` | — | `kernel.learn()`, `kernel.runCapability()`, `kernel.extractFacts()` | Yok |
| 8 | `replication-checker` | `replication-checker.js` | `graph` | — | `kernel.graph`, `kernel.runCapability()` | Yok |
| 9 | `repo-memory` | `repo-memory.js` | `companyMode` | `graph`, `github` | `kernel._companyIngestState` | Yok |
| 10 | `result-analyzer` | `result-analyzer.js` | `graph` | — | `kernel.graph` read-only | Yok |
| 11 | `sandbox-runner` | `plugins/` içinde değil, `sandboxRunner.js` root'ta, PluginManager üzerinden değil | N/A | N/A | N/A | Yok |

### 3.1 Manifest Dosyaları

Tüm 11 `.manifest.json` dosyası **sadece `sha256`** içerir. Hook, capability, veya metadata manifest'te değil, doğrudan `.js` dosyasında inline olarak tanımlanır.

### 3.2 Hook Kullanım Dağılımı

| Hook | Kullanan Plugin Sayısı | Plugin'ler |
|------|----------------------|------------|
| `init` | 2 | `company-brain`, `llm-memory-plugin` |
| `beforeLearn` | 1 | `company-brain` |
| `afterLearn` | 1 | `contradiction-alert` |
| `beforeVerify` | 1 | `devil-advocate` |
| `afterVerify` | **0** | **HİÇBİR PLUGIN'DE YOK** |
| `beforeBackup` | 0 | — |
| `afterBackup` | 0 | — |
| `beforeRestore` | 0 | — |
| `afterRestore` | 0 | — |
| `beforeIntrospect` | 0 | — |
| `afterIntrospect` | 0 | — |
| `onEdgeAdded` | 0 | — |
| `onContradiction` | 0 | — |
| `onConflict` | 0 | — |
| `capability:enabled` | 0 | — |
| `beforeCapabilityRun` | 0 | — |

**Kullanılmayan 10 hook** mevcut: `afterVerify`, `beforeBackup`, `afterBackup`, `beforeRestore`, `afterRestore`, `beforeIntrospect`, `afterIntrospect`, `onEdgeAdded`, `onContradiction`, `onConflict`, `capability:enabled`, `beforeCapabilityRun`.

### 3.3 Plugin Capability'leri

| Plugin | Capability Adı | Komut | Açıklama |
|--------|---------------|-------|----------|
| `company-brain` | `companyBrain` | `company-brain` | Şirket hafızası sorgulama |
| `company-brain` | `ingestStatus` | `ingest-status` | Ingestion durumu |
| `devil-advocate` | `devilsAdvocate` | — | Karşıt görüş analizi |
| `discovery-engine` | `discoveryEngine` | — | Keşif motoru |
| `idea-mri` | `ideaMri` | — | Fikir MRI analizi (test-only) |
| `replication-checker` | `replicationChecker` | — | Tekrarlanabilirlik kontrolü |
| `result-analyzer` | `resultAnalyzer` | — | Sonuç analizi |
| `sandbox-runner` | `sandboxRunner` | — | Sandbox çalıştırıcı (root'ta) |

### 3.4 Ulaşılamayan/Kullanılmayan Plugin Yüzeyleri

1. **`idea-mri`**: Runtime'da yüklenmez — `evidenceRanking` optional capability'si devre dışı, plugin test-only durumda
2. **10 adet hook** hiçbir plugin tarafından kullanılmaz
3. **`experiment-planner`**: `requires: ['graph']` ama sadece test'te görünür, runtime kullanımı belirsiz
4. **4 manifest.json dosyasına karşılık gelen plugin'ler** (`company-brain`, `contradiction-alert`, `repo-memory`) `companyMode` veya `temporal` capability eksikliğinden yüklenemez durumda (CI loglarında görüldü: "Plugin yuklenemedi")

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
- `afterVerify` hook'u `plugin.js`'de tanımlı (EVENTS array'inde) ama **hiçbir plugin'de implementasyonu yok**
- `devil-advocate` plugin'i `beforeVerify` hook'unu kullanır (verify öncesi karşıt görüş enjekte eder)
- `emit()` fail-open olduğu için `afterVerify`'da bir plugin hatası verify sonucunu etkilemez

**Düzeltme döngüsü için eksikler:**
1. `afterVerify` hook'unu kullanacak plugin yok
2. `emit()` fail-open — düzeltme döngüsünde hata yutulursa verify sonucu değişmez
3. `emitStrict()` pipeline — dönüş değeri manipülasyonu mümkün ama verify sonrası feedback loop için yetersiz (verify sonucu değiştikten sonra tekrar verify çağrısı yapacak mekanizma yok)
4. Plugin'lerin verify sonucunu değiştirip kernel'a geri beslemesi için `kernel.verify()` çağrısı yapması gerekir → döngüsel çağrı riski

**Sonuç:** Mevcut altyapı `afterVerify` hook'unu teknik olarak destekler, ancak bunu gerçek bir düzeltme döngüsüne dönüştürmek için:
- `emitStrict` pipeline modeline geçiş veya yeni bir `emitCorrective` mekanizması gerekir
- Döngü koruması (max iterasyon, çağrı derinliği limiti) eklenmelidir
- Plugin'lerin verify sonucu üzerinde yazma yetkisi olup olmadığı netleştirilmelidir

---

## 6. Kaynak Gerçeklik Özeti

1. **Manifest vs Runtime kopukluğu:** Manifest dosyaları sadece SHA256 içerir, tüm metadata plugin JS dosyasındadır. Manifest'ten bağımsız doğrulama yapılamaz.
2. **Fail-open ağırlıklı sistem:** `emit()`, `load()` hataları, opsiyonel capability eksikliği — hepsi fail-open. Sadece `register()` aşamasındaki dependency check ve production enforcement fail-closed.
3. **Kernel internal API erişimi:** 2 plugin (`company-brain`, `repo-memory`) `kernel._companyIngestState` gibi private alanlara yazıyor. `company-brain` ayrıca `kernel._parsePredicate()` private metodunu çağırıyor.
4. **10 kullanılmayan hook:** 16 hook'tan 10'u hiçbir plugin tarafından kullanılmaz.
5. **`afterVerify` yok:** Hook tanımlı ama implementasyon yok.
6. **4 plugin production'da yüklenemez durumda:** `company-brain`, `contradiction-alert`, `repo-memory` (missing capability), `idea-mri` (test-only).
7. **Plugin bağımlılıkları zincirleme:** `llm-memory-plugin` → `kernel.runCapability('companyBrain')` → `company-brain` plugin'i. İkisi de yüklü değilse sessizce başarısız olur.
8. **Sandbox ayrı konumda:** `sandboxRunner.js` root'ta, PluginManager üzerinden değil; plugin sisteminin parçası değil.

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
          SHA256: 70d108b4c73ebc855f5d305cba001dc3d9fc27580c1afc42be0e44e6befd9256
