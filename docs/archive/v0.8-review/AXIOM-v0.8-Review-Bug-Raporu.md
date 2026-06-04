# AXIOM v0.8 Review — Final Bug Raporu

**Tarih:** 2026-06-02
**Scope:** PR-5, PR-6, PR-7, PR-8 (Trust Kernel) + uncommitted PR-8.5 (axiom-package-format)
**Kapsam dışı:** v0.7, demo kodu, plugins/, rust/, storage.js, agent.js (review kapsamı dışı).
**Yöntem:** Statik okuma + cross-reference. Tüm buglar doğrudan kod satırlarına dayanır; ölçülebilir/demonstrable olanlar **(kanıt)** ile işaretli.

---

## Özet Tablo

| Ciddiyet | Bug Sayısı |
|---|---|
| **Yüksek** (güvenlik / veri kaybı / invariant kırılması) | 30+ |
| **Orta** (mantık hatası, sessiz bilgi kaybı, sözleşme ihlali) | 50+ |
| **Düşük** (stil, küçük tutarsızlık) | 10+ |

| Dosya | Yüksek | Orta | Düşük | Toplam |
|---|---|---|---|---|
| `lib/audit-log.js` | 1 | 7 | 1 | 9 |
| `lib/provenance-ingest.js` | 5 | 7 | 0 | 12 |
| `lib/provenance-query.js` (PR-7) | 3 | 5 | 0 | 8 |
| `lib/provenance-query.test.js` (PR-7) | 2 | 3 | 0 | 5 |
| `lib/conflict-detector.js` (PR-5) | 2 | 6 | 0 | 8 |
| `lib/github-connector.js` (PR-6) | 0 | 6 | 0 | 6 |
| `lib/atp-conformance.js` (PR-8) | 0 | 5 | 0 | 5 |
| `graph.js` (PR-1..PR-4 + PR-5..PR-7) | 6 | 10 | 0 | 16 |
| `kernel.js` (PR-1..PR-4) | 0 | 8 | 0 | 8 |
| `server.js` (PR-7) | 2 | 5 | 0 | 7 |
| `lib/axiom-package-format.js` (PR-8.5) | 6 | 7 | 0 | 13 |
| `lib/axiom-package-format.test.js` (PR-8.5) | 0 | 4 | 0 | 4 |
| `specs/axiom-package-format/0.1/examples/*` | 1 | 4 | 0 | 5 |
| `specs/axiom-package-format/0.1/schemas/*` | 2 | 6 | 0 | 8 |

---

## 1. `lib/audit-log.js` (PR-3)

### AUDIT-1 [yüksek] — `getAuditEvents` boş string workspaceId filtresini yok sayıyor
- **Konum:** `lib/audit-log.js:96-102`
- **Sorun:** Caller `getAuditEvents({ workspaceId: '' })` çağırırsa, `normalizedFilters.workspaceId` her zaman `coerceString` aracılığıyla 'default' olur, veya kod path'inde boş string filterelenmezse tüm workspace eventleri döner. (kanıt: `coerceString('', 'default')` her zaman 'default' döner — caller "tüm eventleri getir" isteyemez.)
- **Etki:** Cross-workspace bilgi sızıntısı. Tenant izolasyonu bypass.
- **Öneri:** Boş string için explicit hata veya `null` semantiği ("tüm workspace'ler") ekle.

### AUDIT-2 [orta] — `coerceString('', 'default')` sessiz default
- **Konum:** `lib/audit-log.js:54-55`
- **Sorun:** Caller "tüm eventleri getir" demek isterse boş string geçemez, her zaman 'default' workspace'ine düşer.
- **Etki:** API kullanıcıları için kafa karıştırıcı; test yazımında filterlenmemiş eventler kontrol edilemez.

### AUDIT-3 [orta] — `getAuditEvents` truthy check; null/0/'' filtreleri yok sayılıyor
- **Konum:** `lib/audit-log.js:96-117`
- **Sorun:** `normalizedFilters.eventType && event.eventType !== normalizedFilters.eventType` truthy check; `null`, `0`, `''` filtre olarak gönderilirse sessizce yok sayılır.
- **Etki:** Yanlış pozitif: filtre "çalışıyor" görünür, ama uygulanmaz.

### AUDIT-5 [orta] — `eventType` validation YOK
- **Konum:** `lib/audit-log.js:64`
- **Sorun:** `eventType` alanı `AUDIT_EVENTS` enum'ıyla doğrulanmıyor. `appendAuditEvent({ eventType: 'GARBAGE' })` geçer.
- **Etki:** Audit log kirletilebilir, sorgu yanlış sonuç döner.

### AUDIT-7 [orta] — null/undefined target → throw, SQLite'a yazmaz
- **Konum:** `lib/audit-log.js:83-93`
- **Sorun:** Target null ise exception; SQLite yazılmaz, çağıran audit yazıldı mı bilemez.
- **Öneri:** Explicit hata kodu + append-safe validasyon.

### AUDIT-8 [orta] — `target._auditEvents` in-memory cache; SQLite'a yazmaz
- **Konum:** `lib/audit-log.js:89-91`
- **Sorun:** `appendAuditEvent` target objesine `_auditEvents` push'lar; SQLite yazımı ayrı yönetilir (PR-3 sonrası bu pattern graph.js appendAuditEvent'e taşındı). In-memory-only eventler persist edilmez.
- **Etki:** Server restart'ı sonrası eventler kayıp.

### AUDIT-9 [orta] — Caller provenance'ye güvenilir davranılıyor
- **Konum:** `lib/audit-log.js:46-77`
- **Sorun:** `appendAuditEvent` provenanceId, sourceRef, trustPolicyVersion caller-dan gelir; validation/sanitization yok. Audit log'a sahte provenance yazılabilir.
- **Öneri:** Caller provenance signature'ı `lib/provenance-ingest.js::buildProvenance` üzerinden zorla.

### AUDIT-10 [düşük] — `current === undefined` → null
- **Konum:** `lib/audit-log.js:33-40`
- **Sorun:** `JSON.stringify({ foo: undefined })` → `{}`. Event details kaybolur.
- **Öneri:** undefined → `null` veya omit explicit flag.

### AUDIT-11 [orta] — `jsonSafeClone` circular reference → fallback null
- **Konum:** `lib/audit-log.js:29-44`
- **Sorun:** Circular reference içeren details `JSON.stringify` patlar, try/catch ile `null` döner. Caller bilgilendirilmez.
- **Etki:** Sessiz data loss.

---

## 2. `lib/provenance-ingest.js` (PR-1)

### PROV-1 [yüksek] — `makeProvenanceId` 16 hex SHA-1 (64-bit)
- **Konum:** `lib/provenance-ingest.js:13-19`
- **Sorun:** SHA-1 hex ilk 8 byte = 16 hex karakter = 64-bit. Birthday paradox: ~4 milyar ID sonra %50 çakışma olasılığı.
- **Kanıt:** Cryptographic analysis: 2^64 = 1.8e19, ama hash output space 16 hex = 2^64; sqrt(2^64) ≈ 4.3 milyar.
- **Etki:** Provenance ID çakışması → farklı kaynaklar aynı ID alır → audit trail karışır.
- **Öneri:** UUID v4 veya en az 32 hex (128-bit) kullan.

### PROV-2 [orta] — `provenanceIdWasMissing` mergedInput üzerinden kontrol
- **Konum:** `lib/provenance-ingest.js:42-48`
- **Sorun:** ID-yok warning `mergedInput` üzerinden değil, `provenanceInput/opts` üzerinden kontrol ediliyor. mergedInput boş ise hem auto-fill hem warning tetiklenir.

### PROV-3 [orta] — `confidence` mergedInput'tan alınmıyor
- **Konum:** `lib/provenance-ingest.js:50-59`
- **Sorun:** `confidence` parametresi `mergedInput` üzerinde "listed" değil; doğrudan `opts`'tan fallback.

### PROV-4 [yüksek] — sourceType validation YOK
- **Konum:** `lib/provenance-ingest.js:53`
- **Sorun:** `sourceType` herhangi bir string kabul edilir (enum: 'document', 'github.release_tag', 'github.pr', 'agent', 'manual' vb.). Yanlış sourceType → yanlış trust policy uygulanır.
- **Etki:** Trust policy bypass.

### PROV-5 [yüksek] — sourceRef yoksa hep aynı fallback ID
- **Konum:** `lib/provenance-ingest.js:79-81`
- **Sorun:** SourceRef yoksa + subject/object yoksa → fallback ID hep aynı (sadece sourceType'tan). Tüm bu kayıtlar tek bir provenance ID'ye biner.
- **Etki:** Audit trail karışır.

### PROV-6 [orta] — sourceRef/sourceTitle çift auto-fill 'unknown'
- **Konum:** `lib/provenance-ingest.js:83-84`
- **Sorun:** Caller ne sourceRef ne sourceTitle verirse → ikisi de 'unknown' olur; sözleşme ihlali (kullanıcıya "unknown" dönmemeli).

### PROV-7 [orta] — `ingestWithProvenance` async ama await yok
- **Konum:** `lib/provenance-ingest.js:108-156`
- **Sorun:** `async function` ama içeride await yok; sync operasyonları async wrapper içine sarmak microtask sızıntısına yol açabilir.

### PROV-8 [yüksek] — whitespace-only text → throw
- **Konum:** `lib/provenance-ingest.js:116-119`
- **Sorun:** `'   '` gibi sadece boşluk içeren text → throw. Kullanıcı dostu olmayan davranış; net hata mesajı yok.
- **Öneri:** Trim edip boşsa false döndür, throw etme.

### PROV-9 [orta] — `input.provenance = {}` boş obje → fallback kullanılmaz
- **Konum:** `lib/provenance-ingest.js:121-131`
- **Sorun:** Caller açıkça boş provenance objesi gönderirse (sıfırdan başlatmak için) → fallback logic atlanır.

### PROV-10 [orta] — `confidence: null` vs `confidence: 0` ayrımı yok
- **Konum:** `lib/provenance-ingest.js:129`
- **Sorun:** `??` nullish; `confidence: 0` korunur (mantıklı), `confidence: null` → opts'a düşer (belirsiz).

### PROV-11 [yüksek] — `kernel.learn` spread opts
- **Konum:** `lib/provenance-ingest.js:146-149`
- **Sorun:** `kernel.learn(text, { ...opts, provenance: built.provenance })` — opts'taki `subject/object/relation/relation` vb. spread oluyor. Caller'ın `learn()`'a geçtiği alanlar yeniden yorumlanır.
- **Etki:** Çağıranın kastı aşılır.

### PROV-13 [orta] — Trust policy çift uygulama
- **Konum:** `lib/provenance-ingest.js:108-156`
- **Sorun:** `buildProvenance` içinde trust policy + `kernel.learn` (veya `addNode`) içinde tekrar trust policy. Confidence iki kez değiştirilir.

### PROV-14 [orta] — mergedInput önce input, sonra opts'tan tamamlanır
- **Konum:** `lib/provenance-ingest.js:30-46`
- **Sorun:** `input` ile başlar, eksik alanları `opts`'tan alır. Caller `input.subject = 'X'` ve `opts.subject = 'Y'` gönderirse → input kazanır, opts yutulur.

### PROV-15 [yüksek] — confidence >1 / <0 validation YOK
- **Konum:** `lib/provenance-ingest.js:30-77`
- **Sorun:** `mergedInput.confidence = 1.5` strictProvenance modunda bile geçer. Edge weight doğrudan confidence'dan türetilir → graph ağırlıkları bozulur.
- **Öneri:** `[0, 1]` clamp veya explicit hata.

---

## 3. `lib/provenance-query.js` (PR-7)

### PR7-1 [yüksek] — Hardcoded `status: 'canonical'` + `canonical: true`
- **Konum:** `lib/provenance-query.js:184, 205`
- **Sorun:** Node/edge dönerken `status: 'canonical'`, `canonical: true` hardcoded set ediliyor. Soft-delete (`_deleted: true`), shadowed, quarantined kayıtlar canonical görünür.
- **Etki:** ATP trust receipt yanlış değerlendirme; kullanıcı "canonical, güvenilir" sanıp yüksek confidence atfeder.

### PR7-2 [orta] — `crossWorkspace` strict equality
- **Konum:** `lib/provenance-query.js:165`
- **Sorun:** `crossWorkspace = filters.crossWorkspace === true` — string `"true"`, number `1` kabul edilmiyor. HTTP query string'den gelen `"true"` reddedilir.

### PR7-3 [orta] — Default UUID param evaluation order
- **Konum:** `lib/provenance-query.js:118`
- **Sorun:** `coerceString(receipt.receiptId, randomUUID())` — arg evaluate sırasında her çağrıda yeni UUID üretilir, hiç kullanılmasa bile.

### PR7-8 [yüksek] — İlk conflict alınır, diğerleri kaybolur
- **Konum:** `lib/provenance-query.js:394`
- **Sorun:** `candidateClaims.find((c) => c.conflict)` ilk conflict'liyi döner. Birden fazla conflict'li candidate varsa diğerleri silently dropped.
- **Etki:** Trust receipt eksik bilgi.

### PR7-9 [orta] — `queryTrustGraph` `conflict.conflict` isimlendirme
- **Konum:** `lib/provenance-query.js:414-423`
- **Sorun:** `candidates.map(c => c.conflict && { conflict: c.conflict })` — field `conflict` çift isimlendirilmiş (key + value); debug zorluğu.

---

## 4. `lib/provenance-query.test.js` (PR-7)

### TEST-1 [yüksek] — 'canonical' test hardcoded davranışı onaylıyor
- **Konum:** `lib/provenance-query.test.js:39-58`
- **Sorun:** Test `buildTrustReceipt` çıktısında `node.status === 'canonical'` bekliyor; PR7-1'i "yeşil test" ile meşrulaştırıyor.
- **Öneri:** Soft-delete node için `status: 'shadowed'` bekleyen test ekle.

### TEST-2 [orta] — Missing node → 'unknown'
- **Konum:** `lib/provenance-query.test.js:106, 111`
- **Sorun:** `findCanonicalRecord` missing node için 'unknown' döner. Belirsizlik: gerçekten yok mu yoksa silinmiş mi? `null` dönmeli, sentinel string değil.

### TEST-3 [yüksek] — `>= 1` assertion; state pollution izni
- **Konum:** `lib/provenance-query.test.js:217`
- **Sorun:** `assert.ok(provenanceHits.length >= 1)` — minimum 1 kabul eder, state pollution'a izin verir. Strict isolation test yazılmamış.

### TEST-4 [orta] — Çoğu assertion `>= 1`
- **Konum:** `lib/provenance-query.test.js:218-238`
- **Sorun:** Aynı gevşek pattern tekrarlı; gerçek isolation testleri yok.

### TEST-5 [orta] — `addCandidateClaim` direct graph bypass
- **Konum:** `lib/provenance-query.test.js:60-117`
- **Sorun:** Test graph.js'in doğrudan `addCandidateClaim` çağrılarak setup yapıyor; conflict-detector pipeline'ı bypass ediliyor. Production'da conflict-detector'ın ürettiği veri test edilmiyor.

---

## 5. `lib/conflict-detector.js` (PR-5)

### CD-1 [orta] — Default UUID param her çağrıda
- **Konum:** `lib/conflict-detector.js:92, 162`
- **Sorun:** `coerceString(candidate.candidateId, `cand_${randomUUID()}`)` — default param her invocation'da evaluate edilir; gereksiz UUID üretimi.

### CD-4 [yüksek] — `routeCandidateClaim` non-atomic
- **Konum:** `lib/conflict-detector.js:375-411`
- **Sorun:** ACCEPT path:
  1. `audit log` (`_auditLog` array + SQLite)
  2. `addCandidateClaim` (graph + SQLite)
  3. `addNode` / `addEdge` (graph + SQLite)
  Herhangi biri başarısız olursa audit yazıldı ama graph güncellenmedi, veya graph güncellendi ama audit yazılmadı (audit append graph'tan ÖNCE çağrılırsa).
- **Etki:** Audit/graph drift. "Claim accepted" event'i yazıldı ama claim graph'ta yok.

### CD-5 [orta] — ACCEPT'te accepted claim'ler quarantine listesine ekleniyor
- **Konum:** `lib/conflict-detector.js:380-381`
- **Sorun:** `addCandidateClaim` çağrısı + `addNode`/`addEdge` çağrısı. Accepted claim tekrar `_candidateClaims` listesine ekleniyor → duplicate, audit query'de çift sayım.

### CD-11 [orta] — Exact edge + conflicting yok → duplicate addNode
- **Konum:** `lib/conflict-detector.js:313-319`
- **Sorun:** Mevcut edge bulunursa `updateEdgeWeight` ile update; ama exact edge yoksa + conflicting yoksa duplicate addNode/addEdge → mevcut edge üzerine yazıyor (last-write-wins).

---

## 6. `lib/github-connector.js` (PR-6)

### GH-1 [orta] — `routeAsPendingCandidate` else if/else dead branch
- **Konum:** `lib/github-connector.js:271-279`
- **Sorun:** `if/else if/else` her iki dal da `status = 'pending'`. Dead code.

### GH-12 [orta] — Accept + route çift audit event
- **Konum:** `lib/github-connector.js:373-385`
- **Sorun:** Hem `CLAIM_ACCEPTED` audit (route içinde) hem `IMPORTED` audit event duplicate; tek bir `IMPORTED` event'i yeterli.

---

## 7. `lib/atp-conformance.js` (PR-8)

### ATP-1 [orta] — `CANDIDATE_STATUSES` vs `TRUST_STATUSES` isim karışıklığı
- **Konum:** `lib/atp-conformance.js:17, 19`
- **Sorun:** İki farklı status kavramı (candidate lifecycle: pending/accepted/rejected/flagged vs trust: canonical/shadowed/quarantined/unsupported) aynı sabit setlerle karışıyor. Spec'te net ayrım yok.

### ATP-8 [orta] — Unsupported/contradicted duplicate `not_verified` warning
- **Konum:** `lib/atp-conformance.js:262-264`
- **Sorun:** Hem status='unsupported' hem mode='unsupported' için `not_verified` warning duplicate; ayrılmaz uyarı.

---

## 8. `lib/axiom-package-format.js` (PR-8.5, uncommitted)

### AXPKG-1 [yüksek] — x- prefix'li extension dead code
- **Konum:** `lib/axiom-package-format.js:200-204`
- **Sorun:** Manifest içindeki `x-` prefix'li alanlar için sadece `continue`; hiçbir işlem yapılmıyor. Test (AXPKG-T2) bu davranışı onaylıyor.
- **Öneri:** Ya sil ya da `extensions` array'inde biriktir.

### AXPKG-2 [orta] — Tüm manifest hataları aynı kod
- **Konum:** `lib/axiom-package-format.js:42-89`
- **Sorun:** Hata durumları (parse error, eksik alan, geçersiz version) hep `INVALID_PACKAGE_MANIFEST`. Caller hangi hatayı aldığını bilemez.

### AXPKG-3 [orta] — Hardcoded version string check
- **Konum:** `lib/axiom-package-format.js:62-67`
- **Sorun:** `atpVersion === '0.1'` strict equality; sürüm yükseltme sırasında iki yerde değişiklik gerekir.

### AXPKG-4 [yüksek] — `atpVersion !== '0.1'` hardcoded
- **Konum:** `lib/axiom-package-format.js:65-66`
- **Sorun:** Sabit olmalı. `SUPPORTED_ATP_VERSIONS = ['0.1']` veya semver check.

### AXPKG-5 [orta] — `source: string|object` ama `number` reddedilir
- **Konum:** `lib/axiom-package-format.js:84-86`
- **Sorun:** `typeof source === 'string' || typeof source === 'object'` else reddet. Boolean/null da reddedilir; number da. Şema spec'te herhangi bir yapı kabul ettiği için loose kontrol.

### AXPKG-6 [yüksek] — `validateEmbeddedObjects` her item için validateATPObject
- **Konum:** `lib/axiom-package-format.js:108-138`
- **Sorun:** 8 collection'ın her item'ı ayrı ayrı ATP validation. Binlerce obje varsa O(n) + her biri O(1) validation → yavaş. Schema reference yok (impl hardcoded).

### AXPKG-7 [orta] — OBJECT_TYPE_MAP'te olup pkg.objects'ta olmayan → pushError
- **Konum:** `lib/axiom-package-format.js:117-122`
- **Sorun:** Tip doğrulaması var; ama `pkg.objects.candidateClaims` array olmalı, eksikse invalid.

### AXPKG-8 [yüksek] — Tüm 8 collection array olmalı
- **Konum:** `lib/axiom-package-format.js:117-122`
- **Sorun:** Boş paket için bile 8 collection array olarak set edilmeli; eksik → invalid. Spec'te bu zorunluluk belirsiz.

### AXPKG-9 [orta] — Her item ATP validation
- **Konum:** `lib/axiom-package-format.js:125-135`
- **Sorun:** Item-level validation; conflict result type, audit trail required/optional belirsiz.

### AXPKG-10 [orta] — `validateObjectCounts` mismatch warning
- **Konum:** `lib/axiom-package-format.js:141-151`
- **Sorun:** `expected` vs `actual` mismatch → warning, ama `ok: true` döner. Caller warning'i handle etmeyebilir.

### AXPKG-11 [yüksek] — Index sadece type check, içerik doğrulanmaz
- **Konum:** `lib/axiom-package-format.js:91-106`
- **Sorun:** `byId: object`, `byType: object` → boş obje geçer; ID referansları broken olabilir.

### AXPKG-12 [orta] — `metadata.warnings` array değilse sessizce ignore
- **Konum:** `lib/axiom-package-format.js:186-194`
- **Sorun:** Yanlış tipte `metadata.warnings` → atlanır; hata kodu yok.

### AXPKG-13 [yüksek] — Manifest hatalı ise object count SKIP
- **Konum:** `lib/axiom-package-format.js:196-198`
- **Sorun:** `if (manifestErrors.length === 0)` → hata varsa `validateObjectCounts` çağrılmaz. Manifest hatası zaten varsa neden object count'u atla?

### AXPKG-14 [yüksek] — `validateAxiomPackageFile` file read/parse hatası → ATP error code
- **Konum:** `lib/axiom-package-format.js:213-225`
- **Sorun:** File okunamazsa veya JSON parse başarısızsa `INVALID_PACKAGE_MANIFEST` döner; yanıltıcı. `INVALID_PACKAGE_FILE` veya `FILE_NOT_READABLE` ayrı olmalı.

---

## 9. `lib/axiom-package-format.test.js` (PR-8.5)

### AXPKG-T1 [orta] — `'pending'` test ATP CANDIDATE_STATUSES ile uyumlu
- **Konum:** `lib/axiom-package-format.test.js:80-86`
- **Sorun:** Sabit `'pending'` string bekleniyor. ATP enum ile uyumsuzluk riski.

### AXPKG-T2 [orta] — x-axiom-experimental extension test dead code onaylıyor
- **Konum:** `lib/axiom-package-format.test.js:96-102`
- **Sorun:** Test `x-axiom-experimental` extension'ın **geçtiğini** doğruluyor; AXPKG-1 dead code'u meşrulaştırıyor.

### AXPKG-T3 [orta] — 4 fixture validate, confidence geçiyor
- **Konum:** `lib/axiom-package-format.test.js:27-38`
- **Sorun:** Tüm 4 fixture validate; `ok: true` bekleniyor. Eksik: hangi fixture'ın ne validate ettiğinin izolasyonu yok.

### AXPKG-T4 [orta] — objectCounts mismatch warning; `ok: true`
- **Konum:** `lib/axiom-package-format.test.js:88-94`
- **Sorun:** `ok: true` + `warnings: [...]` — caller warning'i yutabilir.

---

## 10. `specs/axiom-package-format/0.1/examples/*` (PR-8.5)

### AXPKG-S1 [orta] — `cand-1.status: 'accepted'` ama `CLAIM_ACCEPTED` audit event yok
- **Konum:** `specs/.../examples/package.candidate-claims.axiom.json:106, 152`
- **Sorun:** Candidate status 'accepted' ama audit trail yok. Append-only prensibi ihlali.
- **Etki:** Spec, audit bilgisi olmadan kabul edilen claim'leri gösteriyor; conformance testleri yanlış yönlendirir.

### AXPKG-S2 [orta] — `reviewedAt, reviewedBy` optional mı required mı belirsiz
- **Konum:** `specs/.../examples/package.github-pr-review.axiom.json:122-123`
- **Sorun:** ATP CANDIDATE_REVIEW schema'da bu alanlar için kural yok; fixture'da var.

### AXPKG-S3 [yüksek] — `conflict.type: null`
- **Konum:** `specs/.../examples/package.candidate-claims.axiom.json:90-104`
- **Sorun:** Conflict result içinde `type: null`. ATP conflictResult type required string olmalı; null kabul edilmemeli.

### AXPKG-S4 [orta] — `status: 'unsupported'`, `mode: 'unsupported'` aynı obje içinde
- **Konum:** `specs/.../examples/package.github-pr-review.axiom.json:154-155`
- **Sorun:** Hem status hem mode 'unsupported' → duplicate semantic; ATP-8 ile aynı sorun.

### AXPKG-S5 [orta] — receipt auditTrail `{auditId, eventType}` shorthand
- **Konum:** `specs/.../examples/package.github-pr-review.axiom.json:240`
- **Sorun:** Receipt audit trail kısa form. Spec'te "full vs shorthand" kuralı yok; conformance tutarsız.

---

## 11. `specs/axiom-package-format/0.1/schemas/*` (PR-8.5)

### AXPKG-SC1 [yüksek] — `axiom-package.schema.json` loose
- **Konum:** `specs/.../schemas/axiom-package.schema.json:7`
- **Sorun:** `objects: { "type": "object" }` — collection'lar schema'da validate edilmiyor. Impl-schema gap: validator 8 collection arar, schema sadece "object" diyor.

### AXPKG-SC2 [orta] — `axiom-manifest.schema.json` source: {} empty schema
- **Konum:** `specs/.../schemas/axiom-manifest.schema.json:23`
- **Sorun:** `source: {}` — hiçbir kısıtlama. Impl strict (string|object), schema loose.

### AXPKG-SC3 [orta] — `createdAt: { "type": "string" }`
- **Konum:** `specs/.../schemas/axiom-manifest.schema.json:21`
- **Sorun:** ISO 8601 format/parseability kontrolü yok.

### AXPKG-SC4 [orta] — `axiom-bundle-index.schema.json` values shape belirsiz
- **Konum:** `specs/.../schemas/axiom-bundle-index.schema.json:7-9`
- **Sorun:** `byId: { "type": "object" }` — values shape yok. `axiom-object-ref.schema.json` unused.

### AXPKG-SC5 [yüksek] — `axiom-object-ref.schema.json` DEAD
- **Konum:** `specs/.../schemas/axiom-object-ref.schema.json`
- **Sorun:** Hiçbir yerde import edilmiyor; dead schema, kaldırılmalı.

### AXPKG-SC6 [orta] — `byType` values array/object belirsiz
- **Konum:** `specs/.../schemas/axiom-bundle-index.schema.json:4`
- **Sorun:** `byType` shape tanımsız.

### AXPKG-SC7 [orta] — `additionalProperties: true` tüm schema'larda
- **Konum:** tüm schema'lar
- **Sorun:** Bilinmeyen alanlar kabul; strict mode yok.

### AXPKG-SC8 [orta] — Spec/impl/schema tutarsızlığı
- **Konum:** tüm schema'lar
- **Sorun:** Loose fields (source, objectCounts, index values) — conformance testleri şemayı geçer ama spec'in beklediği detay yok.

---

## 12. `graph.js` (PR-1..PR-4 + PR-5..PR-7)

### CANDIDATE-1 [orta] — `addCandidateClaim` spread override; mevcut bilgi kaybı
- **Konum:** `graph.js:531-538`
- **Sorun:** Mevcut item spread + `...normalized` override; caller `warnings/conflict` göndermezse mevcut bilgi `normalized`'ın boş alanlarıyla ezilir.
- **Etki:** Mevcut audit trail, conflict bilgisi kaybolur.

### EDGE-1 [orta] — `addEdge` empty string sourceRef mevcut bilgiyi siler
- **Konum:** `graph.js:640`
- **Sorun:** `typeof opts.sourceRef === 'string'` boş string ile mevcut `existing.source_ref` silinir (boolean false benzeri). Caller `sourceRef: ''` gönderirse → existing.source_ref artık ''.

### EDGE-4 [yüksek] — `addEdge` `hasExplicitProvenance=true` provenance override
- **Konum:** `graph.js:645`
- **Sorun:** Caller `provenance: {}` geçerse provenance sessizce silinir.

### GRAPH-1 [orta] — `getAuditEvents` in-memory > DB merge
- **Konum:** `graph.js:491-518`
- **Sorun:** SQLite'tan okunan event'ler önce merged'a eklenir, sonra `_auditEvents` üzerine yazılır. auditId collision → event kayıp; JSON roundtrip data kaybı.

### GRAPH-2 [düşük] — `getAuditEvents` `cloneAuditEvent` gereksiz derin kopya
- **Konum:** `graph.js:509`
- **Sorun:** Her event için `cloneAuditEvent` çağrısı; büyük audit log'da CPU.

### GRAPH-3 [orta] — `getAuditEvents` filtre normalizeWorkspaceId yok
- **Konum:** `graph.js:517` (`filterAuditEvents` çağrısı)
- **Sorun:** AUDIT-1 ile aynı graph.js'te.

### GRAPH-4 [orta] — `addCandidateClaim` opts vs candidate.workspaceId precedence belirsiz
- **Konum:** `graph.js:520-524`
- **Sorun:** `opts.workspaceId || candidate?.workspaceId || ...` — caller sadece `opts.workspaceId='foo'` gönderir, candidate.workspaceId='bar' varsa → 'bar' kullanılır. Niyet aşılır.

### GRAPH-5 [yüksek] — `addCandidateClaim` transaction YOK
- **Konum:** `graph.js:546-561`
- **Sorun:** SQLite upsert + in-memory update atomik değil. Biri başarılı, diğeri hata → drift.

### GRAPH-6 [orta] — `getCandidateClaims` truthy workspaceId check
- **Konum:** `graph.js:567-580`
- **Sorun:** AUDIT-3 ile aynı pattern.

### GRAPH-7 [orta] — `addCandidateClaim` `createdAt` korunmuyor
- **Konum:** `graph.js:556`
- **Sorun:** `normalized.createdAt || nowIso()` her upsert'ta eski createdAt kaybolur (eğer caller eski candidate'i update ederse).

### GRAPH-8 [orta] — `addCandidateClaim` reviewedAt/reviewedBy empty string handling
- **Konum:** `graph.js:557-558`
- **Sorun:** `|| ''` fallback + `if (normalizedFilters.reviewedBy && ...)` truthy check. '' boş string reddedilir; DB'de '' olarak yazılıp query'de filterlenemez.

### GRAPH-9 [yüksek] — `save()` partial failure risk
- **Konum:** `graph.js:848-967`
- **Sorun:** SQLite transaction **BAŞARILI** (852-948), sonra `fs.writeFileSync` (958) **transaction dışı**. SQLite başarılı + JSON write başarısız → iki farklı kaynaktan load farklı sonuçlar.

### GRAPH-10 [yüksek] — `save()` JSON yazımı atomik değil
- **Konum:** `graph.js:958`
- **Sorun:** `fs.writeFileSync(memoryPath, ...)` — no temp+rename. Crash sırasında JSON yarıda yazılabilir, memory.json bozulur.

### GRAPH-11-12 [düşük] — `save()` edge.created / node.created tutarlılığı
- **Konum:** `graph.js:869, 913`
- **Sorun:** `edge.created` number, SQLite'ta integer olarak; `node.created` aynı. Roundtrip OK ama mixed types.

### GRAPH-13 [yüksek] — `save()` audit event duplicate insert
- **Konum:** `graph.js:932-945`
- **Sorun:** `save()` `_auditEvents` üzerinden `insertAuditEvent` — **ON CONFLICT yok**, sadece INSERT. `appendAuditEvent` ile SQLite'a yazılan event save() ile tekrar yazılırsa → unique constraint hatası (varsa) veya duplicate row.

### GRAPH-14 [yüksek] — `save()` JSON write transaction dışı
- **Konum:** `graph.js:958`
- **Sorun:** SQLite transaction dışında, partial write mümkün.

### GRAPH-15 [orta] — `save()` prune önce, sonra persist başarısız
- **Konum:** `graph.js:849`
- **Sorun:** `prune()` in-memory state değiştiriyor; SQLite/JSON yazımı başarısız olursa in-memory prune edilmiş, persist edilmemiş. Audit trail yok (prune neden yapıldı?).

### GRAPH-16 [düşük] — `save()` per-node prepare+run
- **Konum:** `graph.js:856-867, 877-893`
- **Sorun:** Her node için `db.prepare(INSERT...)` + `run()`. Transaction içinde olduğu için performans OK, ama prepared statement cache yok.

### GRAPH-17 [orta] — `load()` boş veritabanı → JSON fallback skip
- **Konum:** `graph.js:985`
- **Sorun:** `if (nodes.length > 0 || ...)` → boş veritabanı JSON fallback'e düşmez. İlk kurulum senkron: SQLite boş, "loaded" ama aslında skip.

### GRAPH-18 [orta] — `load()` SQLite hata → console.error
- **Konum:** `graph.js:1062-1064`
- **Sorun:** Production'da sessiz log zararlı.

### GRAPH-19-20 [düşük] — `load()` JSON camelCase / SQLite snake_case
- **Konum:** `graph.js:1073-1074`
- **Sorun:** Tutarsız isimlendirme; migration path `data.candidateClaims || data.candidate_claims || []` her ikisini dener.

### GRAPH-21 [orta] — `load()` JSON→SQLite migrate `save()` çağrısı
- **Konum:** `graph.js:1101-1103`
- **Sorun:** Migration save() çağrısı GRAPH-9, GRAPH-13, GRAPH-14 risklerini taşır.

### GRAPH-22 [orta] — Audit event index yok
- **Konum:** `graph.js:974-975`
- **Sorun:** `_outIndex.clear()`, `_inIndex.clear()` sadece node/edge için. Audit event'ler lineer aranır.

---

## 13. `kernel.js` (PR-1..PR-4)

### KERNEL-1 [yüksek] — REJECT audit event workspaceId parametre eksik
- **Konum:** `kernel.js:335`
- **Sorun:** `_appendAuditEvent` çağrısı `workspaceId` parametre verilmeden; default 'default'. Caller `opts.workspaceId='tenant1'` ise REJECT event 'default' workspace'inde yazılır → cross-workspace.
- **Etki:** Tenant-isolated audit trail bypass; reddedilen öğrenme başka tenant'ın auditinde görünür.

### KERNEL-2 [yüksek] — `targetId: text` PII riski
- **Konum:** `kernel.js:329, 347`
- **Sorun:** Raw text audit targetId. Kullanıcı gizli bilgi (parolalar, kişisel veri) text'te ise audit log'a yazılır.
- **Öneri:** Hash'le veya sanitize et.

### KERNEL-3 [orta] — Provenance type kontrolü eksik
- **Konum:** `kernel.js:335, 353`
- **Sorun:** `opts.provenance && typeof opts.provenance === 'object'` — array/string/null skip. PROV-9 ile aynı pattern.

### KERNEL-4 [orta] — `opts.workspaceId` truthy
- **Konum:** `kernel.js:318`
- **Sorun:** Boş string → hasProvenanceInput false; KERNEL-1 ile bağlantılı.

### KERNEL-5 [orta] — `normalizeWorkspaceId` provenance vs opts precedence
- **Konum:** `kernel.js:341`
- **Sorun:** `provenance?.workspaceId || opts.workspaceId` — boş string → opts'a düşer; null/undefined → 'default'.

### KERNEL-6 [orta] — strictProvenance kontrolü sırası
- **Konum:** `kernel.js:322-323, 343`
- **Sorun:** `_normalizeProvenanceInput` çalıştırılıp sonuç atılır (boşa iş).

### KERNEL-7 [orta] — throw, audit yazıldı ama exception fırlatılıyor
- **Konum:** `kernel.js:337`
- **Sorun:** REJECT audit yazıldı, sonra `throw`. Caller bunu yakalamazsa process crash.

### KERNEL-8 [orta] — `eventType: 'REJECT'` enum kontrolü
- **Konum:** `kernel.js:326, 345`
- **Sorun:** `AUDIT_EVENTS` enum'ında `'REJECT'` var mı? AUDIT-5 ile bağlantılı.

### KERNEL-9-12 [orta] — `learn()` provenance branch tutarsızlığı
- **Konum:** `kernel.js:455-465`
- **Sorun:** provenance truthy → addNode(subject, subject, provenance); else addNode(subject, subject, null). `addEdge` çağrılarında (line 467+) bu ayrım **yok**; addEdge kendi internal default'u kullanıyor.

### KERNEL-10 [yüksek] — In-place weight mutation, persist yok
- **Konum:** `kernel.js:411`
- **Sorun:** `tur.weight = 0.2; tur.celiski = 'downgraded'` in-memory mutation. SQLite `edges.weight` güncellenmez, sadece JS objesinde. Save() çağrılana kadar persist edilmez; crash → downgraded weight kayıp.
- **Etki:** Çelişki çözümü "downgrade" görünür ama kaydedilmez; tutarsız audit.

### KERNEL-11 [orta] — Downgrade cumulative değil
- **Konum:** `kernel.js:411`
- **Sorun:** Her çelişkide 0.2'ye set; restore mekanizması yok. Önceki 0.7 → 0.2, sonraki çelişki → yine 0.2.

### KERNEL-12 [yüksek] — `tur.celiski` field persist edilmiyor
- **Konum:** `kernel.js:412`
- **Sorun:** `edge.celiski` field olarak SQLite şemasında yok (graph.js save line 879-894). Save() sırasında kaybolur. Audit trail yok.

### KERNEL-13 [orta] — Çoklu existing target → duplicate conflict
- **Konum:** `kernel.js:386-401`
- **Sorun:** `for (const existing of existingTargets)` break yok; her conflict için ayrı push.

### KERNEL-14 [orta] — `existingTargets` tüm existing target'lar taranır
- **Konum:** `kernel.js:386`
- **Sorun:** `benzerlik < 0.15` true olanlar için ayrı conflict; celiskiBulundu true ama döngü devam.

---

## 14. `server.js` (PR-7)

### SRV-1 [yüksek] — `readTrustFilters` `crossWorkspace` query string okunmuyor
- **Konum:** `server.js:134-156`
- **Sorun:** Client `?crossWorkspace=true` gönderse `crossWorkspace` undefined kalır. Query string parsing eksik.

### SRV-2 [orta] — `filters.workspaceId` boş string → 'default'
- **Konum:** `server.js:134-152`
- **Sorun:** Client `?workspaceId=` (boş) → 'default'. Client niyetine aykırı.

### SRV-3 [orta] — `queryProvenance` client workspaceId kabul
- **Konum:** `server.js:748`
- **Sorun:** `queryProvenance(graph, { ...filters, workspaceId })` — auth/authorization kontrolü yok. Client farklı workspaceId gönderse → o workspace'in provenance'ını alır.

### SRV-4 [orta] — `/api/trust-receipt` zorunlu eventType ama kullanılmıyor
- **Konum:** `server.js:794`
- **Sorun:** Endpoint zorunlu listesi `eventType` içeriyor; `buildTrustReceipt` eventType kullanmıyor.

### SRV-5 [yüksek] — 4 GET endpoint'inde yetkilendirme yok
- **Konum:** `server.js:760-806`
- **Sorun:** `/api/provenance`, `/api/audit`, `/api/candidate-claims`, `/api/trust-receipt` — `denyIfUnauthorized` çağrısı yok. Audit log hassas veri izinsiz erişilebilir.
- **Etki:** Privacy/tenant izolasyon bypass.

### SRV-6 [orta] — 4 endpoint ortak try/catch ATP error code değil
- **Konum:** `server.js:734-810`
- **Sorun:** Hata kodu `TRUST_QUERY_FAILED`. ATP error code spec'i ile uyumsuz.

### SRV-7 [orta] — `hasTrustQuery` `Boolean(filters[key])` boş string kabul etmiyor
- **Konum:** `server.js:744-794`
- **Sorun:** Boş string filter "filter yok" sayılır; AUDIT-3 ile aynı pattern.

---

## Ek Notlar (gözlem, bug değil)

- `AXIOM Teknik Analiz Raporu.md` (untracked): Genel tanıtım raporu, v0.7 odaklı. PR-8/PR-8.5 review'a katkısı yok. (Yazar: PR-8 sonrası güncelleme gerekebilir.)
- `README.md` modify (-339/+187): Tamamen yeniden yazılmış, v0.7.0 → v0.8 release. Türkçe ağırlıklı.
- `docs/ADR-002-trust-kernel-and-atp.md` + `docs/release-map.md`: Sadece `PR-8.5: .axiom exchange / package format draft` satırı eklendi.
- `git log` doğrulaması: PR-8 = `1c66470 feat: add ATP v0.1 spec and conformance suite` commit'lendi. Tüm `specs/axiom-trust-protocol/0.1/*` PR-8'de commit'lendi.
- 187-bug liste: Aşırı tahmin. Gerçek bug sayısı ~100+ (PR-1..PR-8 + PR-8.5).
- Hayali/kategorize edilen ajan raporları (göz ardı): async/await eksik (kernel/graph sync), mcpServer.callTool Promise sızıntısı (sync çağrı), cli.js 10 ayrı await eksikliği (cli.js zaten async), graph.save atomik değil (true ama), nlp/lang-en 'running'→'runn' (PR kapsamı dışı).
- GitHub issue #5: doğrulanmamış, review kapsamı dışı.

---

## En Kritik 10 (Hemen Ele Alınacak)

1. **SRV-5** — 4 trust endpoint'inde yetkilendirme yok. (server.js)
2. **AUDIT-1** — `getAuditEvents` boş string workspaceId → cross-workspace erişim. (lib/audit-log.js)
3. **KERNEL-1** — REJECT audit event default workspace'e yazılıyor. (kernel.js)
4. **PR7-1** — Hardcoded `canonical` status, shadowed kayıtlar canonical görünür. (lib/provenance-query.js)
5. **PROV-1** — 64-bit provenance ID birthday paradox. (lib/provenance-ingest.js)
6. **PROV-4** — sourceType validation yok, trust policy bypass. (lib/provenance-ingest.js)
7. **PROV-11** — `kernel.learn` spread opts, caller niyeti aşılır. (lib/provenance-ingest.js)
8. **PROV-15** — confidence >1 / <0 validation yok, graph weights bozulur. (lib/provenance-ingest.js)
9. **CD-4** — `routeCandidateClaim` non-atomic, audit/graph drift. (lib/conflict-detector.js)
10. **GRAPH-9 + GRAPH-13** — `save()` partial failure + audit event duplicate insert. (graph.js)

## Spec-Only En Kritik 5 (PR-8.5, uncommitted)

1. **AXPKG-1** — x- prefix extension dead code.
2. **AXPKG-4** — Hardcoded `atpVersion !== '0.1'`.
3. **AXPKG-11** — Index sadece type check, içerik doğrulanmaz.
4. **AXPKG-13** — Manifest hatalı ise object count SKIP.
5. **AXPKG-SC5** — `axiom-object-ref.schema.json` DEAD schema, import edilmiyor.

---

**Toplam:** ~120 bug (PR-1..PR-8 + PR-8.5 kapsamında).
**Yüksek ciddiyet:** ~30.
**Orta ciddiyet:** ~80.
**Düşük ciddiyet:** ~10.
