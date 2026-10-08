# AXIOM v0.9.1 Memory Core

## Memory Core Nedir?
Memory Core, AXIOM'un deterministik, agentic, izole ve SQLite destekli kalıcı (persistent) hafıza motorudur. LLM tabanlı çıkarımları doğrulamak, graph bağlantıları ile karmaşık düşünce zincirlerini depolamak, audit ve provenance yetenekleriyle her bir bilgi parçasının (memory) kökenini garanti altına almak üzere tasarlanmıştır.

## PR-M1 → PR-M6 İle Gelen Kabiliyetler
1. **PR-M1:** Zod tabanlı memory schema validation eklendi.
2. **PR-M2:** `kernel.memory` API yapısı ve temel hook'lar sağlandı.
3. **PR-M3:** `better-sqlite3` tabanlı, transaction güvenli SQLite persistence eklendi.
4. **PR-M4:** metadata ve type tabanlı detaylı arama/sorgulama (query/search) helpers eklendi.
5. **PR-M5:** memory graph (idempotent linkleme) ve temporal query özellikleri eklendi.
6. **PR-M6:** provenance logları, audit tracking ve workspace izolasyonu sıkılaştırıldı.

## kernel.memory API Özeti

### Temel Metotlar
* `store(memory, options)`: Yeni bir hafıza objesini kaydeder.
* `get(id)`: Belirtilen id ve mevcut workspace ile memory döndürür.
* `list()`: Workspace'e ait tüm silinmemiş kayıtları döndürür.
* `query(predicate)`: Filtreleme mantığı uygulayarak liste döndürür.
* `search(criteria)`: Metadata ve string match araması yapar.

### Mutasyonlar
* `patchMetadata(id, patch)`: Yeni bir kayıt (provenance) oluşturarak metadata günceller.
* `tombstone(id)`: İlgili id'ye sahip kaydı `type: "deleted"` ile geçersiz kılar (soft-delete).
* `supersede(oldId, newMemory)`: Eski bir kaydın yerine yeni bir kayıt ekler ve "supersedes" ilişkisi kurar.

### Graph ve Temporal API
* `linkMemories(sourceId, targetId, relation, metadata)`: İki hafıza arasına deterministik, idempotent bir graph ilişkisi ekler.
* `queryLinks(filter)`: Spesifik ilişkileri ve node'ları filtreler.
* `linksForMemory(id, direction)`: Bir node'a ait in/out/all yönlü linkleri getirir.
* `eventsForMemory(id)`: İlgili node etrafındaki event tabanlı olayları döndürür.
* `timeline(options)`: Başlangıç/Bitiş zamanına göre kronolojik memory veya link dökümü verir.
* `memoriesBetween(startTime, endTime)`: Belirli bir zaman aralığında kaydedilmiş anıları listeler.

## Mimari Prensipler

### SQLite Persistence
Sistem asenkron çalışan, senkron-gibi API sunan `better-sqlite3` modülünü kullanır. Tüm state RAM üzerindeki cache'de tutulurken anlık olarak veritabanına WAL mode ile kalıcı olarak yazılır. Atomicity (transaction rollback) ile tam güvence sağlanır.

### Workspace Isolation
Her bir hafıza bir `workspaceId` değerine bağlanır. Tüm CRUD işlemleri internal `_makeMemoryKey(workspaceId, id)` mekanizması ile gerçekleştirilir, cross-workspace memory leak riski tamamen ortadan kaldırılır.

### Provenance / Audit / Event Modeli
Hiçbir hafıza "overwrite" (üzerine yazma) edilmez. `patchMetadata`, `supersede` veya `tombstone` operasyonları her zaman yeni bir `audit` eventi veya `causalChain` kopyası içeren yepyeni bir immutable obje (yeni createdAt, agentId vs.) üretir.

### Deterministic Ordering
Sorgu sonuçları `[workspaceId, createdAt, id]` veya benzer tutarlı anahtarlara dayalı deterministik bir siralama ile döner. 

### Idempotent Link Behavior
Graph linkler, `sha256(workspaceId + fromId + toId + relation)` fonksiyonuyla hashlenir. Bu sayede aynı link birden çok kez atılmaya çalışılırsa işlem no-op (etkisiz) olarak idempotent sonuçlanır, unique ID yaratma çatışması engellenir.

### Deleted / Tombstoned Behavior
Tombstoned (`type: "deleted"`) edilen bir hafıza `list()`, `query()` vb. genel işlemlerde dönmez ancak `get(id)` ile spesifik arandığında bulunur, bu sayede soft-delete prensibiyle graph integrity korunur.

### Negatif Kapsam (Neler Henüz Yok?)
* **Semantic/Vector Search:** Şu an string match/regex ve metadata üzerinden Exact Match arama yapılır, embedding tabanlı vector search yoktur.
* **AI Summary:** Memory özetleme/kümeleme.
* **Clustering:** K-means tarzı memory gruplama işlemleri.

## Kayıt Deposu (MemoryStore) ve Graf (Graph) Ayrımı

Ürün iki ayrı kalıcılık yüzeyi taşır ve bunlar kasten ayrıdır:

* **Graf** (`nodes`/`edges`): birincil CLI kullanımı. `learn`/`öğret` ve `save`/`kaydet` buraya yazar; `huqan.search`, `reason`, `compare`, `ask` graf üzerinde okur.
* **MemoryStore kayıt deposu** (`kernel.memory`): `memory-query <text>` komutu ve `huqan.memory_query` MCP tool'u bu depoyu sorgular (`lib/memory-query-read.js` → `MemoryStore.query`). `get`, `list`, `query`, `tombstone`, `supersede`, `linkMemories` metotları buradadır.

**Önemli:** `learn`/`save` **kasten** MemoryStore'a yazmaz. Bu, kanonla sabitlenmiş bir sözleşmedir (bkz. `test/refactor-2e-learn-memory-admission-contract.test.js`, "learn never routes canonical writes through MemoryStore"): birincil `learn` yolu graf yazar, kayıt deposunu değil. Bu yüzden yalnızca CLI `learn`/`save` kullanan bir operatör `memory-query` çalıştırdığında doğal olarak `0 of 0` görür — graf doludur ama sorgulanan kayıt deposu boştur.

### Kayıt Deposunu Ne Doldurur?

Depoya yeni bir **başlangıç (kanonik)** kaydı yazan tek üretim çağrısı `lib/error-prevention/store.js`'teki `memoryStore.store(...)`'dur; buna SDK köprüsü `createErrorPrevention` (`index.js` → `lib/error-prevention/`) üzerinden erişilir. Bir MCP tool'u veya açılışta çalışan bir loader başlangıç kaydı **yazmaz** (bkz. `docs/audits/direct-mutation-inventory.md`). Buna karşılık **`memory-lifecycle supersede` bir istisnadır**: mevcut bir kaydı yeni bir **replacement record** ile değiştirir ve bu replacement record depoya yazılır.

Depo şu yollarla dolabilir:

1. **SDK/API yolu:** `createErrorPrevention(memoryStore)` ile `storeContent(...)` çağırmak (üretimde bilinen tek başlangıç-kaydı yazıcısı).
2. **`memory-lifecycle supersede`:** **zaten var olan** bir kaydı, depoya yazılan yeni bir replacement record ile değiştirir; ilk kaydı yaratamaz.
3. **Mevcut kalıcılık dosyası:** yapılandırılmış `memory-store.json` (JSON backend) veya `memoryStoreDbPath` (SQLite backend) hazır kayıtlarla açılışa verilebilir. `MemoryStore` açılışta bu dosyayı hidratlar (`kernel.js` → `new MemoryStore({ memoryStorePath, memoryStoreDbPath })`).

### Beklenen Kullanım

* **Graf sorgusu için:** `learn`/`öğret` ile öğret, ardından `huqan.search <text>` / `reason` / `ask` kullan.
* **Kayıt deposu sorgusu için:** kayıtları SDK/`createErrorPrevention` yolundan ya da hazır bir `memory-store.json`/SQLite ile doldur, sonra `memory-query <text>` çalıştır.

`memory-query`'nin grafı da taraması **kasıtlı olarak yapılmaz**: iki yüzeyin karıştırılması `memory-lifecycle` tombstone/supersede sözleşmesini ve grafın admission semantiğini bozar.
