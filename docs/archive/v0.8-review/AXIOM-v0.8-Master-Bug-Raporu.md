# AXIOM v0.8.0 — MASTER BUG RAPORU

**Tarih:** 6.2.2026
**Kapsam:** v0.8-trust-kernel (HEAD `ea341e1`, 9 commit: v0.7 + PR-1..PR-8 + PR-8.5)
**Birleşik kaynak:**
- Rapor A: Statik kod analizi + akış inceleme (~120 madde)
- Rapor B: Çalıştırma zamanı smoke + cross-reference (27 madde, BUG-V8-1..15, BUG-V7-1..5, TUT-V8-1..7, K-1+)

**Yöntem:** Salt okunur. Hiçbir dosyaya dokunulmadı, kod yazılmadı, düzeltme yapılmadı.

**Önceki rapor:** `AXIOM-v0.8-Review-Bug-Raporu.md` (Rapor A)
**Bu rapor:** Rapor A + Rapor B birleşik, yeniden kategorize, sprint sıralı

---

## Yönetici Özeti

| Metrik | Değer |
|---|---|
| Toplam bulgu | ~150 |
| **Kritik (release blocker)** | **14** |
| Yüksek | 35 |
| Orta | 85 |
| Düşük | 15+ |
| Tutarsızlık | 7 |
| Kod kalitesi (kesik) | 1+ (devamı bekleniyor) |
| v0.7'den devam eden | 5 |
| **Test durumu** | **485 PASS / 1 FAIL** (BUG-V8-1) |
| Sözdizimi (`node --check`) | 27/27 OK + 15 yeni OK |
| HTTP smoke (trust endpoint) | 6/6 OK ama **auth bypass** |
| Yeni dosya (eksik review) | 7 |

**Öncelik:** 14 kritik bug düzeltilmeden v0.8.0 release edilemez. RC smoke doc'u 486/486 yeşil bekliyor; gerçek durum 485+1.

---

## 1. KRİTİK BULGULAR (14) — Release Blockers

Düzeltmeden v0.8.0 release edilemez.

| ID | Konum | Kanıt | Özet |
|---|---|---|---|
| BUG-V8-1 | provenance.test.js:116 | smoke FAIL | Workspace scoping test regresyonu, multi-tenant kırık |
| BUG-V8-2 | server.js:734-806 | HTTP smoke | Trust endpoint'lerinde auth bypass |
| TUT-V8-6 | requestGuards.js:requireApiKey | kod okuma | AXIOM_API_KEY undefined → tüm auth bypass |
| BUG-V8-3 | lib/audit-log.js:100-112 | kod okuma | Boş string workspaceId → cross-tenant sızıntı |
| BUG-V8-4 | lib/provenance-query.js:184,205 | HTTP smoke | canonical:true hardcoded |
| BUG-V8-5 | lib/conflict-detector.js:routeCandidateClaim | kod okuma | 3 non-atomic call (audit/graph drift) |
| BUG-V7-1 | server.js:62-68 + cli.js:createKernel | smoke | AXIOM_USE_SQLITE=false tam uygulanmıyor |
| BUG-V7-5 | server.js:454 + getV2StatusData | kod okuma | computeTestStatus cache stale (486/486 gösteriyor) |
| KERNEL-1 | kernel.js:335 | kod okuma | REJECT audit workspaceId kayıp, cross-workspace sızıntı |
| KERNEL-2 | kernel.js:329,347 | kod okuma | targetId: text raw text → PII audit log'a sızar |
| KERNEL-12 | kernel.js:412 | kod okuma | tur.celiski field SQLite şemasında yok, save() sırasında kaybolur |
| GRAPH-9 | graph.js:848-967 | kod okuma | save() SQLite transaction + JSON write transaction dışı |
| GRAPH-13 | graph.js:932-945 | kod okuma | insertAuditEvent ON CONFLICT yok, duplicate insert |
| GRAPH-10 | graph.js:958 | kod okuma | fs.writeFileSync atomik değil, crash → memory.json bozulur |

### Detaylar

#### BUG-V8-1 [KRİTİK] Test regresyonu: workspace scoping
- **Konum:** `provenance.test.js:116` "keeps workspace scoped provenance isolated"
- **Kanıt:** `node --test` → 1 FAIL: `assert.ok(scopedNode)` → `scopedNode = null`
- **Senaryo:** `kernel.learn('kedi hayvandir', { provenance: { workspaceId: 'workspace-a' } })` → `graph.getNode('kedi', 'workspace-a')` null
- **Kök neden:** v0.7 KERNEL-9-12 hatası devam ediyor; `addNode`'a `workspaceId` verilip `addEdge`'e verilmiyor; `buildProvenance` trust policy ile `workspaceId` sıfırlanıyor olabilir
- **Etki:** Multi-tenant izolasyonu kırık, release blocker
- **RC smoke doc:** 486/486 yeşil bekliyor — fail
- **Aksiyon:** `addEdge` çağrısına `workspaceId` propagate et; `buildProvenance` trust policy öncesi workspaceId snapshot

#### BUG-V8-2 + TUT-V8-6 [KRİTİK] Trust endpoint'lerinde auth bypass
- **Konum:** `server.js:734-806` (`/api/provenance`, `/api/audit`, `/api/candidate-claims`, `/api/trust-receipt`), `lib/requestGuards.js:requireApiKey`
- **Kanıt:** HTTP smoke: `curl http://localhost:PORT/api/provenance?targetId=kedi` (API key olmadan) → 200 OK
- **Etki:** Hassas audit/provenance/trust verisi izinsiz erişilebilir, tenant izolasyon bypass
- **Kök neden:** 4 trust endpoint'inde `requireApiKey` middleware çağrılmamış; `requestGuards.js` env boş ise bypass
- **Aksiyon:** 4 endpoint'e `requireApiKey` middleware ekle; env boş ise hard-fail et (warn değil)

#### BUG-V8-3 [KRİTİK] Audit log cross-tenant sızıntı
- **Konum:** `lib/audit-log.js:100-112`
- **Kanıt:**
  ```js
  } else if (normalizedFilters.workspaceId === '') {
    normalizedFilters.workspaceId = undefined; // ← boş string → tüm workspace'ler
  }
  // line 112:
  if (normalizedFilters.workspaceId !== undefined && event.workspaceId !== ...) {
    // filter devre dışı
  }
  ```
- **Etki:** `getAuditEvents({workspaceId:''})` ile tüm tenant'ların audit event'leri alınabilir
- **Aksiyon:** empty string'i default workspace olarak değerlendir; undefined filter semantiğini netleştir (no filter vs all filter karışmamalı)

#### BUG-V8-4 [KRİTİK] Trust receipt canonical:true hardcoded
- **Konum:** `lib/provenance-query.js:184` (node), `:205` (edge)
- **Kanıt:** HTTP smoke: `GET /api/trust-receipt?provenanceId=foo` response'unda `canonical: true`; soft-delete/shadowed/quarantined kayıtlar bile canonical görünüyor
- **Etki:** ATP trust receipt yanlış değerlendirme; kullanıcı yüksek confidence atfeder
- **Aksiyon:** Gerçek canonical state'i graph'tan oku (provenance.canonical, softDeleted, shadowed flag'leri)

#### BUG-V8-5 [KRİTİK] routeCandidateClaim non-atomic
- **Konum:** `lib/conflict-detector.js:routeCandidateClaim` (ACCEPT path)
- **Kanıt:** 3 ayrı non-atomic call:
  1. `graph.addCandidateClaim(candidate)` (graph + SQLite)
  2. `graph.addNode` + `graph.addEdge` (graph + SQLite)
  3. `appendAudit(...)` (graph + SQLite)
- **Etki:** Herhangi biri başarısız olursa audit yazıldı ama graph güncellenmedi (veya tersi) → audit/graph drift
- **Aksiyon:** Tek bir transaction wrapper içine al, ya da rollback semantiği ekle

#### BUG-V7-1 [KRİTİK] AXIOM_USE_SQLITE=false tam uygulanmıyor
- **Konum:** `server.js:62-68` + `cli.js:createKernel`
- **Kanıt:** `AXIOM_USE_SQLITE=false AXIOM_MEMORY_PATH=memory-v08-smoke.json` set edildi → `GET /health` → `backend: "sqlite"` (yanlış) + `.db` dosyası yine oluştu
- **Etki:** README "JSON'a düş" diyor; davranış bunu tam karşılamıyor, hâlâ yan etkili `.db` dosyası oluşuyor
- **Aksiyon:** `createKernel` env'i tam parse et, `useSqlite=false` ise SQLite modülünü hiç yükleme

#### BUG-V7-5 [KRİTİK] computeTestStatus cache stale
- **Konum:** `server.js:454` + `getV2StatusData()`
- **Kanıt:** 485+1 fail olmasına rağmen `/v2-status` `testStatus: 486/486` gösteriyor
- **Etki:** Dashboard yanıltıcı, "all green" hissi; release blocker (yanlış sinyaller)
- **Aksiyon:** Cache invalidation ekle veya her istekte test runner tetikle

#### KERNEL-1 [KRİTİK] REJECT audit workspaceId kayıp
- **Konum:** `kernel.js:335`
- **Kanıt:** REJECT audit event `workspaceId` parametre verilmeden çağrılıyor → default 'default' workspace'e yazılır
- **Etki:** Cross-workspace audit event sızıntısı; cross-tenant izolasyon ihlali
- **Aksiyon:** `learn()` çağrısındaki `opts.workspaceId`'i REJECT audit'e de geçir

#### KERNEL-2 [KRİTİK] targetId PII sızıntısı
- **Konum:** `kernel.js:329, 347`
- **Kanıt:** `targetId: text` raw text olarak audit log'a yazılıyor
- **Etki:** PII / hassas bilgi audit log'a sızar; GDPR/KVKK ihlali riski
- **Aksiyon:** targetId'yi hash'le veya redact et; provenance'da canonical ID kullan

#### KERNEL-12 [KRİTİK] tur.celiski field persist edilmiyor
- **Konum:** `kernel.js:412`
- **Kanıt:** `tur.celiski = 'downgraded'` atanıyor ama SQLite şemasında bu field yok
- **Etki:** `graph.save()` sırasında kaybolur; çelişki çözümü "downgrade" görünür ama persist edilmez
- **Aksiyon:** SQLite şemasına `celiski TEXT` kolonu ekle veya audit log'a yaz

#### GRAPH-9 [KRİTİK] save() transaction + JSON write dışı
- **Konum:** `graph.js:848-967` (`save()`)
- **Kanıt:** SQLite transaction var ama `fs.writeFileSync(memoryPath, ...)` transaction dışında
- **Etki:** SQLite + JSON farklı sonuçlar; crash safety yok
- **Aksiyon:** JSON write'ı SQLite transaction bitimine bağla veya temp file + atomic rename pattern kullan

#### GRAPH-13 [KRİTİK] insertAuditEvent ON CONFLICT yok
- **Konum:** `graph.js:932-945` (`save()` audit event yazımı)
- **Kanıt:** `INSERT INTO audit_events ...` ON CONFLICT clause yok
- **Etki:** Aynı `auditId` ile ikinci insert hata verir veya duplicate event yaratır
- **Aksiyon:** `ON CONFLICT (audit_id) DO NOTHING` ekle veya upsert

#### GRAPH-10 [KRİTİK] fs.writeFileSync atomik değil
- **Konum:** `graph.js:958`
- **Kanıt:** Direkt `fs.writeFileSync(memoryPath, ...)`; rename pattern yok
- **Etki:** Crash veya disk full sırasında `memory.json` bozulur → tüm graph verisi kayıp
- **Aksiyon:** `writeFile` + `rename` atomic pattern; veya SQLite-only'a migrate et

---

## 2. v0.7'den DEVAM EDEN BUGLAR (5)

| ID | Konum | Kanıt | Özet |
|---|---|---|---|
| BUG-V7-1 | server.js:62-68 + cli.js | smoke | AXIOM_USE_SQLITE tam uygulanmıyor (yukarıda KRİTİK) |
| BUG-V7-2 | root: `tbk-demo.js`, `tbk-kira.js` | `search_files` 0 sonuç | Dead code, 120 + 47 satır repo kirliliği |
| BUG-V7-3 | packages/axiom-verify/ | package.json | Monorepo eksik, root'ta `workspaces` yok |
| BUG-V7-4 | plugin.js:load + server.js:ensureCompanyRuntime | log gürültüsü | 3 startup hata logu (tasarım gereği bilinen) |
| BUG-V7-5 | server.js:454 | kod okuma | computeTestStatus cache stale (yukarıda KRİTİK) |

### Detay: BUG-V7-2..4
- **BUG-V7-2:** `tbk-demo.js` (120 satır) + `tbk-kira.js` (47 satır) root'ta, hiçbir yerde require edilmiyor. Silinebilir veya `examples/`'e taşınabilir.
- **BUG-V7-3:** `packages/axiom-verify/package.json` var ama root `package.json`'da `workspaces` alanı yok. `npm install` paketi çalıştırmaz. Monorepo yapısı kopuk.
- **BUG-V7-4:** Server başlatılınca 3 hata logu (company-brain, contradiction-alert, repo-memory plugin'leri "missing capability"). Lazy load ile çözülebilir, log seviyesi `warn` yapılabilir.

---

## 3. YENİ DOSYALAR (7) — Eksik Review

Rapor A bu dosyaları kapsamıyordu, Rapor B tarafından tespit edildi. Henüz derinlemesine review yapılmadı.

| Dosya | Bilinen Bulgular | Aksiyon |
|---|---|---|
| `lib/ingest.js` | BUG-V8-7: aynı `slice(0,16)` 64-bit SHA-1 truncation | Derinlemesine review gerekli |
| `lib/sdk.js` | TUT-V8-7: `invokeCapability` capability gate eksik | Derinlemesine review gerekli |
| `lib/requestGuards.js` | TUT-V8-6: env boş ise bypass | Derinlemesine review gerekli |
| `lib/shield.js` | Yok | Tam review gerekli |
| `mcpServer.js` | TUT-V8-1: `loadPlugins: false` vs server `loadPlugins: true` asimetri | Derinlemesine review gerekli |
| `packages/axiom-verify/` | BUG-V7-3: monorepo eksik | Yapısal review gerekli |
| `adapters/*` | Yok | Tam review gerekli |
| `migrations/v3.0-checkpoints.sql` | TUT-V8-5: storage.js schema ile karşılaştırılmamış | Schema diff gerekli |

---

## 4. YÜKSEK BULGULAR (35)

| ID | Konum | Kanıt | Özet |
|---|---|---|---|
| KERNEL-3 | kernel.js:335, 353 | akış | provenance type kontrolü eksik (PROV-9 pattern) |
| KERNEL-4 | kernel.js:318 | akış | opts.workspaceId truthy check, falsy değer kayıp |
| KERNEL-5 | kernel.js:341 | akış | normalizeWorkspaceId provenance vs opts precedence belirsiz |
| KERNEL-6 | kernel.js:322-323, 343 | akış | strictProvenance kontrolü sırası, _normalizeProvenanceInput boşa çalışır |
| KERNEL-7 | kernel.js:337 | akış | REJECT audit yazıldı sonra throw, crash riski |
| KERNEL-8 | kernel.js:326, 345 | akış | eventType: 'REJECT' AUDIT_EVENTS enum kontrolü yok |
| KERNEL-10 | kernel.js:411 | akış | In-place `tur.weight = 0.2` mutation, SQLite'ta persist yok |
| KERNEL-11 | kernel.js:411 | akış | Downgrade cumulative değil, her çelişkide 0.2'ye set |
| KERNEL-13 | kernel.js:386-401 | akış | Çoklu existing target → duplicate conflict, break yok |
| GRAPH-1 | graph.js:491-518 | akış | getAuditEvents in-memory > DB merge; auditId collision → event kayıp |
| GRAPH-3 | graph.js filterAuditEvents | akış | AUDIT-1 ile aynı normalizeWorkspaceId sorunu |
| GRAPH-5 | graph.js:546-561 | akış | addCandidateClaim transaction YOK, SQLite+in-memory drift |
| GRAPH-6 | graph.js:567-580 | akış | getCandidateClaims truthy workspaceId check |
| GRAPH-7 | graph.js:556 | akış | addCandidateClaim createdAt korunmuyor |
| GRAPH-8 | graph.js:557-558 | akış | reviewedAt/reviewedBy empty string handling |
| GRAPH-14 | graph.js save() | akış | JSON write transaction dışı (GRAPH-9 ile aynı) |
| GRAPH-15 | graph.js:849 | akış | prune() önce, persist başarısız → in-memory prune edilmiş persist edilmemiş |
| GRAPH-17 | graph.js:985 | akış | load() boş veritabanı → JSON fallback skip |
| BUG-V8-7 | lib/provenance-ingest.js:18 + lib/ingest.js:17 | kod okuma | 64-bit SHA-1 ID truncation, birthday paradox |
| BUG-V8-8 | lib/axiom-package-format.js:200-204 | kod okuma | x- prefix dead loop body, extension yutuluyor |
| BUG-V8-9 | lib/conflict-detector.js:380-385 | kod okuma | routeCandidateClaim ACCEPT audit duplicate (GH-12) |
| BUG-V8-10 | lib/atp-conformance.js:9-14 | kod okuma | CANDIDATE_STATUSES vs TRUST_STATUSES karışıklığı |
| AUDIT-1..11 | lib/audit-log.js | kod okuma | normalize edge case'ler, in-memory persist, eventType enum, pagination (11 detay) |
| PROV-1 | lib/provenance-ingest.js:18 | kod okuma | 64-bit SHA-1 (BUG-V8-7 ile aynı, ingest.js:17 de var) |
| PROV-4..11 | lib/provenance-ingest.js | kod okuma | buildProvenance strictProvenance skip, _normalizeProvenanceInput partial apply |
| SRV-1..6 | server.js | kod okuma | Trust endpoint auth, response shape, query param validation |
| CD-1, 5, 11 | lib/conflict-detector.js | kod okuma | flag yolu audit eksik, empty existingClaimIds, workspaceId propagate |
| GH-1, 12 | lib/github-connector.js | kod okuma | rate limit error, retry strategy |
| ATP-1, 8 | lib/atp-conformance.js | kod okuma | CANDIDATE_STATUSES enum, flag handling |
| PR7-1, 2, 3 | lib/provenance-query.js | kod okuma | parseProvenanceId split, filterAuditEvents semantic, loadProvenance workspace |
| AXPKG-1, 4, 11, 13 | lib/axiom-package-format.js | kod okuma | x-prefix dead loop, hash determinism, manifest version, signature/canonical JSON |
| TUT-V8-1 | mcpServer.js vs server.js | kod okuma | loadPlugins asimetri |
| TUT-V8-4 | storage.js:30 | kod okuma | SQLite zorunluluğu, AXIOM_USE_SQLITE bypass |
| TUT-V8-7 | lib/sdk.js:invokeCapability | kod okuma | Capability gate eksik |

### En Kritik 5 (Yüksek) — Detay

#### GRAPH-5 [YÜKSEK] addCandidateClaim transaction YOK
- **Konum:** `graph.js:546-561`
- **Kanıt:** 3 ayrı call: in-memory push + SQLite insert + audit event insert, hiçbiri transaction içinde
- **Etki:** SQLite+in-memory drift; crash safety yok

#### KERNEL-10 [YÜKSEK] In-place weight mutation persist yok
- **Konum:** `kernel.js:411` (`tur.weight = 0.2`)
- **Kanıt:** In-place object mutation, `graph.save()` çağrılana kadar in-memory
- **Etki:** Çelişki çözümü "downgrade" görünür ama SQLite'ta persist edilmez
- **İlişkili:** TUT-V8-2 (rapor B), GRAPH-15 (prune/persist sıralaması)

#### BUG-V8-7 [YÜKSEK] 64-bit SHA-1 ID truncation
- **Konum:** `lib/provenance-ingest.js:18`, `lib/ingest.js:17`
- **Kanıt:** `crypto.createHash('sha1').update(...).digest('hex').slice(0, 16)` = 64-bit
- **Etki:** ~4 milyar ID sonra %50 çakışma (birthday paradox); idempotency key + provenance ID karışabilir
- **Aksiyon:** `slice(0, 16)` kaldır veya SHA-256 kullan

#### BUG-V8-8 [YÜKSEK] AXPKG-1 dead loop body
- **Konum:** `lib/axiom-package-format.js:200-204`
- **Kanıt:** `if (key.startsWith('x-')) continue;` — loop body boş, hiçbir şey yapmıyor
- **Etki:** Extension'lar yutuluyor, kullanıcı "x-axiom-experimental" koyarsa validator sessizce geçer

#### BUG-V8-10 [YÜKSEK] ATP candidate vs trust status karışıklığı
- **Konum:** `lib/atp-conformance.js:9-14`
- **Kanıt:** CANDIDATE_STATUSES: `['pending', 'accepted', 'rejected']` ('flagged' yok); TRUST_STATUSES: `['canonical', 'pending', 'flagged', 'rejected', 'unknown']`
- **Etki:** Spec'ler arası uyumsuzluk, conformance testleri yanlış yönlendirebilir

---

## 5. ORTA BULGULAR (85)

Çok sayıda orta bulgu — çoğu `lib/*` modüllerinde edge case, validation, persist, error handling eksiklikleri. Tam liste için Rapor A'ya bakın. Kategorize:

| Kategori | Madde Sayısı | Örnekler |
|---|---|---|
| `lib/audit-log.js` (AUDIT-2..11 devam) | 9 | normalize edge case, in-memory persist, eventType enum, pagination |
| `lib/provenance-ingest.js` (PROV-2..14 devam) | 12 | buildProvenance strictProvenance skip, _normalizeProvenanceInput partial apply |
| `graph.js` (GRAPH-2, 4, 11, 12, 16, 18, 19, 20, 21, 22) | 10 | JSON camelCase / SQLite snake_case, audit event index yok, prune/persist sırası |
| `kernel.js` (KERNEL-9, 13) | 2 | Çoklu existing target duplicate conflict |
| `server.js` (SRV-7) | 1 | response shape |
| `lib/conflict-detector.js` (CD-2, 3, 6, 7, 8, 9, 10) | 7 | flag yolu, empty existingClaimIds, workspaceId propagate |
| `lib/github-connector.js` (GH-2..11, 13) | 12 | rate limit, retry, secret leak |
| `lib/atp-conformance.js` (ATP-2..7, 9..19) | 18 | CANDIDATE_STATUSES enum, spec karşılaştırma, conformance test coverage |
| `lib/provenance-query.js` (PR7-4..9) | 6 | parseProvenanceId, filterAuditEvents, loadProvenance |
| `lib/axiom-package-format.js` (AXPKG-2, 3, 5, 6, 7, 8, 9, 10, 12, 14) | 10 | hash determinism, manifest version, bundle index objectRef |
| `lib/axiom-package-format.test.js` (AXPKG-T1..4) | 4 | test coverage gaps |
| `lib/provenance-query.test.js` (TEST-1..5) | 5 | test coverage gaps |
| `lib/audit-log.test.js` | 2-3 | test coverage |
| `specs/axiom-package-format/0.1/schemas` (AXPKG-SC1..4, 6..8) | 7 | loose validation, additionalProperties false yok, enum eksik |
| `specs/axiom-package-format/0.1/examples` (AXPKG-S1, 2, 4, 5) | 4 | timestamp format tutarsızlık, missing required field |
| `BUG-V8-11..14` (Rapor B) | 4 | audit-log appendAudit in-memory, buildProvenance çift trust policy, confidence clamp yok, fixture type:null |
| `TUT-V8-2, 3, 5` (Rapor B) | 3 | reconcileWithEdge mutation, MAX_NODES=150, migration schema drift |

**Toplam orta: ~85**

---

## 6. DÜŞÜK BULGULAR (15+)

| ID | Konum | Kanıt | Özet |
|---|---|---|---|
| BUG-V7-2 | root: tbk-*.js | search_files 0 | Dead code, repo kirliliği |
| BUG-V7-3 | packages/axiom-verify/ | package.json | Monorepo eksik (workspaces yok) |
| BUG-V7-4 | plugin.js + server.js | log | Plugin "missing capability" log gürültüsü |
| BUG-V8-15 | specs/.../axiom-object-ref.schema.json | import yok | Dead schema |
| AXPKG-SC5 | specs/.../axiom-object-ref.schema.json | import yok | Dead schema (BUG-V8-15 ile aynı) |
| BUG-V8-7 (partial) | lib/ingest.js:17 | kod okuma | 64-bit ID (yüksek listesinde de var, etki alanı düşük) |
| AXPKG-2 | lib/axiom-package-format.js | kod okuma | Hash determinism küçük |
| AXPKG-3 | lib/axiom-package-format.js | kod okuma | Manifest version drift |
| K-1+ (kesik) | kernel.js | kod okuma | Türkçe karakter bozması (9+) — **Rapor B'den gelen tablo kesik, devamı bekleniyor** |
| Diğer küçük şeyler | çeşitli | çeşitli | TODO/FIXME comment, dead variable, vs. |

**Toplam düşük: 15+**

---

## 7. TUTARSIZLIKLAR (7)

| ID | Konum | Kanıt | Özet |
|---|---|---|---|
| TUT-V8-1 | mcpServer.js vs server.js | kod okuma | `loadPlugins: false` (MCP) vs `loadPlugins: true` (server default) asimetri |
| TUT-V8-2 | kernel.js:411 | akış | `reconcileWithEdge` in-place mutation persist yok (KERNEL-10 ile aynı) |
| TUT-V8-3 | server.js:232 | kod okuma | `getGraphData()` MAX_NODES=150 hard-coded, sessiz truncation |
| TUT-V8-4 | storage.js:30 | kod okuma | SQLite zorunluluğu, `throw new Error('better-sqlite3 is required...')`; AXIOM_USE_SQLITE=false bypass |
| TUT-V8-5 | migrations/v3.0-checkpoints.sql vs storage.js | eksik diff | Migration şeması ile runtime şeması karşılaştırılmamış |
| TUT-V8-6 | requestGuards.js:requireApiKey | kod okuma | AXIOM_API_KEY undefined → tüm auth bypass (KRİTİK'e taşındı) |
| TUT-V8-7 | lib/sdk.js:invokeCapability | kod okuma | SDK caller keyfi capability çağırabilir, capability gate eksik |

---

## 8. KOD KALİTESİ (K-1+)

**Rapor B'den gelen "Kod Kalitesi" tablosu K-1 satırında kesildi.**

- **K-1:** `kernel.js` Türkçe karakter bozması (9+) — **devamı bekleniyor**

Kullanıcı tam tabloyu paylaşırsa buraya eklenecek.

---

## 9. SPEC TUTARSIZLIKLARI (PR-8.5 uncommitted)

| ID | Konum | Kanıt | Özet |
|---|---|---|---|
| AXPKG-SC5 | specs/.../axiom-object-ref.schema.json | import yok | Dead schema |
| BUG-V8-14 | specs/.../examples/package.candidate-claims.axiom.json:90-104 | kod okuma | `conflict.type: null` fixture, ATP required string olmalı |
| AXPKG-SC1..4, 6..8 | specs/.../schemas | kod okuma | Loose validation, `additionalProperties: false` yok, `enum` eksik |
| AXPKG-S1, 2, 4, 5 | specs/.../examples | kod okuma | timestamp format tutarsızlık, missing required field |
| `specs/axiom-trust-protocol/0.1/*` | ATP v0.1 spec | eksik review | Rapor A'da tam review yapılmadı |

---

## 10. AKSİYON PLANI (Önerilen Sprint Sırası)

### Sprint 1 — KRİTİK (1 hafta, release blocker)
**Hedef:** RC smoke doc'a uygunluk, multi-tenant restore
- [ ] BUG-V8-1 (workspace scoping test fail) — KERNEL-9-12 fix, buildProvenance trust policy sırası
- [ ] BUG-V8-2 + TUT-V8-6 (auth bypass) — 4 endpoint'e `requireApiKey`, env boş hard-fail
- [ ] BUG-V8-3 (audit cross-tenant) — empty string filter semantiği
- [ ] BUG-V8-4 (canonical hardcoded) — gerçek canonical state
- [ ] BUG-V8-5 (routeCandidateClaim non-atomic) — transaction wrapper
- [ ] BUG-V7-1 (AXIOM_USE_SQLITE) — env parse
- [ ] BUG-V7-5 (computeTestStatus cache) — invalidation
- [ ] KERNEL-1 (REJECT audit workspaceId) — propagate
- [ ] KERNEL-2 (targetId PII) — hash/redact
- [ ] KERNEL-12 (tur.celiski persist) — schema kolon
- [ ] GRAPH-9 (save transaction) — JSON write bağla
- [ ] GRAPH-10 (fs.writeFileSync atomic) — writeFile+rename
- [ ] GRAPH-13 (insertAuditEvent ON CONFLICT) — upsert

**Sprint 1 sonu:** 14/14 kritik kapatıldı, RC smoke yeşil.

### Sprint 2 — YÜKSEK (1 hafta, veri tutarlılığı + güvenlik)
**Hedef:** Veri bütünlüğü, PII koruma, transaction semantiği
- [ ] KERNEL-3, 4, 5, 6, 7, 8, 10, 11, 13
- [ ] GRAPH-1, 3, 5, 6, 7, 8, 14, 15, 17
- [ ] BUG-V8-7 (64-bit SHA-1) — slice kaldır
- [ ] BUG-V8-8 (AXPKG-1 dead loop) — extension handling
- [ ] BUG-V8-9 (audit duplicate) — tek event
- [ ] BUG-V8-10 (ATP status enum) — CANDIDATE/TRUST ayır
- [ ] AUDIT-1..11 (audit-log normalize)
- [ ] PROV-1, 4, 11
- [ ] SRV-1..6 (trust endpoint auth/validation)
- [ ] CD-1, 5, 11
- [ ] GH-1, 12
- [ ] ATP-1, 8
- [ ] PR7-1, 2, 3
- [ ] AXPKG-1, 4, 11, 13
- [ ] TUT-V8-1, 4, 7

**Sprint 2 sonu:** 35/35 yüksek kapatıldı, audit trail güvenli, transaction semantiği tam.

### Sprint 3 — ORTA (2 hafta, kalite + test coverage)
**Hedef:** Edge case'ler, validation, test coverage
- [ ] 85 orta bulgunun tamamı
- [ ] Yeni dosyalar tam review: `lib/ingest.js`, `lib/sdk.js`, `lib/shield.js`, `adapters/*`, `mcpServer.js`, `packages/axiom-verify/`
- [ ] `migrations/v3.0-checkpoints.sql` ↔ `storage.js` schema diff
- [ ] `specs/axiom-trust-protocol/0.1/*` tam review

**Sprint 3 sonu:** Edge case'ler kapatıldı, test coverage %95+.

### Sprint 4 — DÜŞÜK + TEMİZLİK (3 gün)
- [ ] BUG-V7-2 (dead code) — sil veya examples/ taşı
- [ ] BUG-V7-3 (monorepo) — root workspaces ekle
- [ ] BUG-V7-4 (plugin log) — warn seviye
- [ ] BUG-V8-15 (dead schema) — sil
- [ ] K-1+ (kod kalitesi) — tamamlandığında
- [ ] TODO/FIXME cleanup

**Sprint 4 sonu:** Repo temiz, sıfır dead code.

---

## 11. EKSİK BİLGİ / AÇIK SORULAR

1. **K-1 devamı:** Rapor B'nin "Kod Kalitesi" tablosu K-1'de kesildi. Tam liste bekleniyor.
2. **Yeni dosyalar:** `lib/ingest.js`, `lib/sdk.js`, `lib/shield.js`, `adapters/*` için derinlemesine review yapılmadı. Sprint 3'te tamamlanacak.
3. **Migration schema:** `migrations/v3.0-checkpoints.sql` ile `storage.js` arasındaki diff kontrol edilmedi.
4. **ATP spec review:** `specs/axiom-trust-protocol/0.1/*` PR-8'de commit'lendi, Rapor A'da tam review yapılmadı.
5. **K-1'den gelen "Türkçe karakter bozması"** — ne anlama geldiği netleşmedi. Encoding mi (UTF-8 BOM), yoksa string literal mi (`"Türkçe"` bozuk)?

---

## 12. RELEASE KARARI

**Mevcut durum:** v0.8.0 release edilemez.

**Sprint 1 tamamlandıktan sonra:**
- 14 kritik kapatıldı
- RC smoke yeşil olur
- v0.8.0 release edilebilir (kalan yüksek/orta/düşük ile)

**Sprint 2 tamamlandıktan sonra:**
- 35 yüksek kapatıldı
- Veri tutarlılığı ve güvenlik güçlendi
- Kurumsal pilot için uygun

**Sprint 3+4 tamamlandıktan sonra:**
- v0.8.1 "polish" release
- B2B satışa hazır

---

## 13. İLGİLİ DOSYALAR

- `AXIOM-v0.8-Review-Bug-Raporu.md` — Rapor A (bu raporun temeli)
- `AXIOM Teknik Analiz Raporu.md` — v0.7 odaklı genel tanıtım, review katkısı yok
- `docs/ADR-002-trust-kernel-and-atp.md` — v0.8 mimari kararlar (+PR-8.5 satırı)
- `docs/release-map.md` — (+PR-8.5 satırı)
- `README.md` — v0.7.0 → v0.8 tamamen yeniden yazılmış (Türkçe, -339/+187)
- `specs/axiom-trust-protocol/0.1/*` — ATP v0.1 spec (PR-8)
- `specs/axiom-package-format/0.1/*` — PR-8.5 uncommitted
- `provenance.test.js:116` — BUG-V8-1 fail kaynağı

**Bu rapor:** `AXIOM-v0.8-Master-Bug-Raporu.md`
**Sahibi:** v0.8 Trust Kernel review
**Sürüm:** 1.0 (6.2.2026)
**Durum:** K-1 devamı + yeni dosya review'ları bekleniyor
