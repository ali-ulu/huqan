# PR-ER2 — Entity Resolution Integration Plan

> **Status:** Plan / Docs PR. **No code change in this PR.**
> **Base:** `origin/main` @ `c1d2d54` (post PR-ER1 merge at `c9b7dce`).
> **Purpose:** Answer the question — *where and how* will `lib/entity-resolution.js` connect to the **verify**, **learn**, and **search** flows.
> **Out of scope for this PR:** runtime verify integration code, runtime learn integration code, runtime search integration code, H-score, embedding/vector search, LLM, high-risk domain gate, API endpoint, CLI command.

---

## 1. Amaç ve Kapsam

PR-ER1 (`c9b7dce`) AXIOM'a ilk kez **LLM'siz, embedding'siz, deterministic** bir kimlik
çözümleme çekirdeği kazandırdı:

- `lib/entity-resolution.js` — `resolveEntity(alias, {domain?})` saf modülü.
- Çıktı şekilleri: hit, ambiguous, unknown.
- `aviation` / `tech` / `design` domain-scoped alias registry.
- 29/29 targeted test, 0 regresyon.

PR-ER2'nin amacı **entegrasyon kodunu yazmak değil**, entegrasyonun nereye oturacağını
**mimari olarak kilitlemek**tir. Bu doküman:

- Mevcut verify / learn / search akışlarının entity identity ile ilgili kesitlerini
  satır referanslarıyla haritalandırır.
- Entegrasyon noktalarını (candidate insertion points) önerir.
- Aşamalı rollout planını (ER2A → ER2B → ER2C → ER2D) tanımlar.
- Her aşama için test stratejisini ve gözlemleri listeler.
- "Out of scope" sınırını açıkça çizer.

Bu PR tamamlandığında, sonraki **PR-ER3+** kod PR'leri için tek bir referans noktası
var olacak. Yorum, scope drift, çift entegrasyon riski azalır.

---

## 2. PR-ER1 API Özeti (Sözleşme)

`lib/entity-resolution.js` (`c9b7dce` ile main'de) şu API'yi ihraç eder:

```
resolveEntity(alias, { domain? }) -> {
  matched: true,  canonical, domain, confidence: 1, reason: 'exact_alias', aliases: [...] |
  matched: false, ambiguous: true, candidates: [...], reason: 'ambiguous_alias_requires_domain' |
  matched: false, reason: 'unknown_alias' | 'unknown_alias_in_domain' | 'empty_alias'
}

listAliases(domain) -> [{ alias, canonical }]
listDomains() -> ['aviation', 'tech', 'design']
normalizeAlias(raw) -> string
```

**Çekirdek özellikler (PR-ER1'den miras, değiştirilemez):**

1. **Karar vermez, sadece kimlik çözer.** `resolveEntity` bir iddia üretmez, bir
   doğruluk/yanlışlık yargısı vermez, bir güven skoru hesaplamaz. Tek yaptığı: bir
   kullanıcı alias'ını (örn. `"B737"`) deterministik bir canonical entity id'sine
   (örn. `"boeing_737"`) çevirmek — ya da bu çeviriyi yapamadığını açıkça raporlamak.

2. **Canonical entity id, original label'ı silmez; ikisi birlikte taşınır.**
   `resolveEntity` döndürdüğü `canonical` + `aliases` çifti, çağıran katmanın
   **hem orijinal label'ı hem canonical id'yi koruması** için tasarlandı. Bu, veri
   kaybını önler: bir kullanıcı `"B737"` demişse, sistem `"boeing_737"` ile eşleşse
   bile orijinal `"B737"` label'ı audit, log, ve receipt metadata'da taşınmalıdır.
   (Bkz. madde 7 — bu PR'de sadece *akış haritası* çıkarılır; gerçek taşıma
   ER2C'de kod olarak gelecek.)

3. **Domain yoksa ambiguous alias tahmin edilmez.** `resolveEntity('AI')` (domain
   belirtilmeden) `ambiguous: true` döner; `air_india` / `artificial_intelligence` /
   `adobe_illustrator` arasından biri seçilmez. Çağıran kod, ya domain'i zorunlu
   kılmalı, ya da kullanıcıya açıklama sormalıdır.

4. **Domain-scoped alias'lar (`AI` gibi) asla cross-domain taşınmaz.**
   Aynı alias farklı domainlerde farklı canonical id'lere bağlanır; bu ayrım
   registry'nin kendisinde dondurulmuştur (`Object.freeze`). Entegrasyon sırasında
   domain bilgisi *kaybolursa* identity collapse olur. Bu, planlanan tüm aşamalar
   için korunması gereken bir invariant'tır.

---

## 3. Verify Akışı Analizi

Dosya: `lib/verify.js` (730 satır, main `c1d2d54`).

### 3.1 Subject çıkarımı (bugünkü durum)

İki paralel subject çıkarımı var:

- **`_extractSubjectAndPredicate`** (satır 655–682): workspace'teki tüm node
  id'lerini `normalizeText` ile sıralar, statement içinde **en uzun prefix
  match**'i bulur. Bu, *literal string match*'tir. Alias bilgisi yok.
- **`inferSubject`** (`lib/claim-decomposition.js` satır 43–68): statement'tan
  ilk 1–3 token'ı alır, küçük harfle başlayan token'da veya marker'da
  (`is`/`are`/`was`/vb.) durur. Syntactic, *alias-agnostic*.

### 3.2 Verify subject -> graph lookup (bugünkü durum)

`verifyClaim` yolu (satır 299–436):

```
299  const subjectMatch = this._extractSubjectAndPredicate(statement, workspaceId, parts);
300  const subject = subjectMatch.subject;
301  const subjectNode = this.kernel.graph.getNode(subject, workspaceId);
302  if (!subjectNode) {
303    return this._verifyResult(statement, opts, { status: 'bilinmiyor', confidence: 0 }, ...);
304  }
...
306  const edges = this.kernel.graph.getEdges(subject, workspaceId);
```

`getNode` ve `getEdges` çağrıları **literal** `subject` üzerinden çalışır. Eğer
graph'ta `"B737"` ayrı bir node ve `"Boeing 737"` ayrı bir node ise, ikisi farklı
path'ten geçer.

### 3.3 Entegrasyon noktası (öneri — *kod değil*)

`resolveEntity` çağrısı iki konumda faydalı olur:

- **Read-only probe (ER2A):** Satır 300'den hemen sonra, log/debug breadcrumb
  olarak `resolveEntity(subject, {domain: claimDomain})` çağrılır; sonuç
  `meta.entityResolution` altında trust receipt'e eklenir. **Lookup davranışı
  değişmez.** Sadece gözlem.
- **Canonical-keyed lookup (ER2B):** Satır 301'de `subjectNode` bulunamazsa,
  `resolveEntity(subject)` ile canonical bulunur, `subjectNode = graph.getNode(canonical, workspaceId)`
  denenir. Bulunursa, sonuç dönerken `subject` (literal) `canonical` ile birlikte
  receipt'e yazılır. Bulunamazsa, mevcut `bilinmiyor` yolu korunur.

**Önemli:** `subject` literal her zaman receipt ve audit trail'de korunmalıdır.
Canonical, yalnızca *look-up kolaylaştırıcı* olarak kullanılır, **kayıt değiştirici
değil**.

### 3.4 Hangi satırlar ne zaman değişecek?

- ER2A: 300–302 arasına ~3 satır (resolveEntity çağrısı + meta ekleme).
- ER2B: 301'in `if (!subjectNode)` bloğuna fallback (~6 satır).
- ER2C / ER2D: verify.js'e dokunmaz; yazma/search tarafında kalır.

---

## 4. Ingest / Learn Akışı Analizi

Dosya: `lib/ingest.js` (143 satır) + `lib/claim-decomposition.js` (244 satır) +
`kernel` capability'leri (`companyBrain`, `repoMemory`).

### 4.1 Mevcut yol

`lib/ingest.js` satır 95–134 (`handleIngest`):

- Source type normalize edilir (`github` / `markdown` / `manual` / `decision`).
- `sourceRef` ve `idempotencyKey` üretilir.
- `payload` `kernel.runCapability('companyBrain' | 'repoMemory', payload)`'a
  delege edilir.

`lib/ingest.js` **entity identity ile doğrudan ilgilenmez.** Subject ve node
oluşumu kernel capability'lerinin içinde gerçekleşir (compound capability
`companyBrain`, ingest payload'undan claim çıkarıp `graph.addNode` çağırır).

### 4.2 Entegrasyon noktası (öneri — *kod değil*)

`lib/ingest.js`'e dokunmaya gerek yok. Asıl entegrasyon noktası:

- **Write-side canonical anchoring (ER2C):** `companyBrain` capability'si
  `graph.addNode(subject, ...)` çağırırken, çağrıdan **hemen önce** bir
  helper'a `resolveEntity(subject, {domain: claimDomain})` geçirilir. Eğer
  sonuç `matched: true` ise:
  - `canonical` node id olarak kullanılır (`boeing_737`).
  - `node.label` veya `node.metadata.aliases` içine orijinal literal (`B737`)
    eklenir.
  - Eğer `canonical` zaten varsa, **mevcut node'a alias eklenir**, yeni node
    açılmaz (idempotent).
- Eğer sonuç `ambiguous: true` ise: yazma **yapılmaz**, capability bir
  `AMBIGUOUS_ALIAS` warning'i ile sonuç döner. Yanlış node açılması önlenir.
- Eğer sonuç `matched: false` (`unknown_alias`): normal yol, literal node
  açılır. (ER2C'nin kapsamı dışı alias'lar literal kalmaya devam eder.)

### 4.3 claim-decomposition.js

`inferSubject` ve `decomposeClaim` **değişmez.** Bu modül syntactic konudur;
entity resolution *sonradan* uygulanacak bir kimlik katmanıdır. ER2C'de
decomposition çıktısı (`subject` literal) `resolveEntity`'ye girdi olarak
geçer.

### 4.4 İlgili diğer modüller

- `lib/contradiction-rules.js` (henüz okunmadı, ER2A probe sırasında açılacak).
- `lib/fuzzy-normalization.js` (58 satır) — token overlap, **entity resolution
  ile karıştırılmamalıdır.** İki farklı kaygı:
  - fuzzy-normalization: textual evidence similarity (verify path/edge search).
  - entity-resolution: alias → canonical id.
  - Bunlar aynı pipeline'da **ardışık** çalışabilir, birbirinin yerine geçmez.

---

## 5. Provenance Query / Search Akışı Analizi

Dosya: `lib/provenance-query.js` (528 satır).

### 5.1 Mevcut yol (özet)

- `queryProvenance(target, filters)` (satır 178–264): graph'taki tüm
  `node` / `edge` / `candidate_claim` kayıtlarını iterate eder; `filters.targetId`
  varsa **literal `node.id === targetId`** match yapar (satır 195:
  `if (targetId && node.id !== targetId) continue;`).
- `queryTrustGraph(target, filters)` (satır 416–462): tüm
  provenance + audit + candidate claims'i toplar, `findCanonicalRecord` ile
  "canonical trust record"u seçer, trust receipt üretir.

### 5.2 Önemli terminoloji ayrımı

`provenance-query.js` içindeki **`canonical` alanı**, *PR-ER1'deki `canonical`
kavramıyla aynı şey DEĞİLDİR*:

- `provenance-query`'de `canonical` = "the accepted / verified trust record"
  (kayıt düzeyinde, status='canonical' veya accepted).
- PR-ER1'de `canonical` = "resolved entity id" (kimlik düzeyinde, örn.
  `boeing_737`).

Bu iki katman birbirine **girdi olarak bağlanabilir** (provenance-query,
entity-resolution'ın çözdüğü canonical id üzerinden lookup yapabilir) ama
kavramsal olarak farklıdırlar. Plan boyunca bu ayrım korunur.

### 5.3 Entegrasyon noktası (öneri — *kod değil*)

- **Provenance / search alignment (ER2D):** `queryProvenance` ve
  `queryTrustGraph`'e bir `filters.entityAlias` opsiyonu eklenir. İçeride:
  1. Önce literal `filters.targetId` ile mevcut yol denenir.
  2. Bulunamazsa, `resolveEntity(filters.entityAlias || filters.targetId)` ile
     canonical çözülür, `graph._nodes` içinde `id === canonical` aranır.
  3. Bulunursa, sonuç dönerken `entityResolution` meta alanı receipt'e
     eklenir (canonical + literal label + domain bilgisi).
  4. `ambiguous: true` durumunda, sonuç listesi **tüm adayları** içerir
     (her biri ayrı kayıt), kullanıcı netleştirme için yönlendirilir.

Bu, **search'in alias-farkında** olmasını sağlar. Ancak davranış değişikliği
"sadece bulunmayan alias'lar için fallback" olduğu için, mevcut sorguların
görünür davranışı değişmez.

---

## 6. Önerilen Entegrasyon Noktaları (Özet)

| # | Dosya | Aşama | Tür | Davranış Etkisi |
|---|-------|-------|-----|-----------------|
| 1 | `lib/verify.js` (satır 300–302 arası) | ER2A | read-only probe | yok (sadece meta) |
| 2 | `lib/verify.js` (satır 301 fallback) | ER2B | canonical-keyed lookup | alias match olduğunda yeni path |
| 3 | `kernel.companyBrain` capability (graph.addNode öncesi) | ER2C | write-side anchor | literal → canonical collapse |
| 4 | `lib/provenance-query.js` (`queryProvenance`, `queryTrustGraph`) | ER2D | search alignment | alias üzerinden aynı sonuç |

**Aşama 1–2 verify tarafı, 3 learn tarafı, 4 search tarafı.** Her aşama bağımsız
PR olabilir; birleştirme zorunlu değildir.

---

## 7. Aşamalı Rollout

### ER2A — Read-Only Probe

**Amaç:** Hiçbir davranış değiştirmeden, `resolveEntity` çıktısının trust
receipt'lerde gözükmesini sağlamak.

- `lib/verify.js` verify path'inde `subject` literal'ı
  `resolveEntity(subject, {domain})` üzerinden geçirilir.
- Sonuç (hit / ambiguous / unknown) `meta.entityResolution` altında receipt'e
  eklenir.
- Graph lookup, kanıt toplama, verdict hesabı **değişmez**.
- `lib/sdk.js` veya başka bir consumer tarafından receipt inspect edildiğinde,
  bu meta alanı okunabilir olmalıdır.

**Çıktılar:**
- Trust receipt'lerde `entityResolution` meta alanı.
- Yeni test dosyaları: `test/entity-resolution-verify-probe.test.js`
  (ya da `test/verify-entity-resolution.test.js`).

**Davranış riski:** Minimum. Yalnızca ek meta.

**Gözlem:** Aynı literal için birden fazla çağrıda aynı `canonical` / `candidates`
dönmeli. Mevcut testlerde hiçbir verdict değişmemeli.

---

### ER2B — Canonical-Keyed Lookup (Verify)

**Amaç:** Subject literal graph'ta yoksa ama bir canonical'a çözümlenebiliyorsa,
**canonical id ile** node lookup dene.

- `lib/verify.js` satır 301'in `!subjectNode` bloğunda:
  - `resolveEntity(subject, {domain: workspaceMeta.domain})` çağrılır.
  - `matched: true` ve tek `canonical` ise, `graph.getNode(canonical, workspaceId)`
    denenir.
  - Bulunursa, normal verify path devam eder; receipt'e
    `entityResolution: { hit: 'canonical_lookup', literal, canonical }` yazılır.
  - Bulunamazsa, mevcut `bilinmiyor` yolu korunur.
  - `ambiguous: true` ise, sonuç `status: 'bilinmiyor'` kalır; receipt'e
    `entityResolution: { hit: 'ambiguous_fallback', candidates }` yazılır.

**Çıktılar:**
- Daha önce `bilinmiyor` dönen sorgular, alias netleştiğinde doğru node'a
  bağlanır.
- Audit trail literal + canonical çiftini içerir.

**Davranış riski:** Orta. Eski `bilinmiyor` → yeni `dogrulandi`/`celiski`
dönüşleri olabilir. Ancak bu, **düzeltilmiş** davranıştır (kullanıcının
kastettiği entity graph'ta vardı ama alias literal match yapmıyordu).
Geriye dönük, alias literal'lar değişmediği için eski sorgular aynı kalır.

**Gözlem:** `B737` ile `"Boeing 737"` aynı node'a bağlanmalı. Test fixture'ı
gerekir.

---

### ER2C — Write-Side Canonical Anchoring (Learn)

**Amaç:** Yeni node açarken, alias netleşiyorsa canonical id ile aç; literal
label'ı alias olarak sakla.

- `kernel.companyBrain` capability'sinde, `graph.addNode` çağrısından önce
  `resolveEntity(subject, {domain: workspaceMeta.domain})` çağrılır.
  - `matched: true` → node id = `canonical`; `node.label = literal` (orijinal
    label korunur); `node.metadata.aliases = [literal, ...]`.
  - `ambiguous: true` → **yazma yapılmaz**, capability
    `AMBIGUOUS_ALIAS` warning + `candidates` listesi döner. Çağıran
    kod (CLI/SDK) kullanıcıya netleştirme sorar.
  - `matched: false` (unknown) → normal yol, literal node açılır. (Kapsam
    dışı alias'lar literal kalmaya devam eder.)
- `lib/ingest.js`'e dokunulmaz; tüm mantık capability içinde kalır.

**Çıktılar:**
- Alias → canonical collapse **sadece yazma anında** olur.
- Idempotent: aynı canonical'a farklı alias'lardan yazma denemeleri aynı node'u
  üretir (alias'lar birikir, node sayısı katlanmaz).
- Ambiguous alias ile deneme yapan kullanıcı, önce netleştirme yapmak zorunda
  kalır — yanlış node açılmaz.

**Davranış riski:** Yüksek. Yanlış uygulanırsa, eski literal node'lar
*shadow*'lanır, audit trail bozulur. Bu yüzden ER2C, **ER2A + ER2B'nin
gözlem verisiyle** başlatılmalı; production'a geçmeden önce staging verify
gerekir.

**Gözlem:** `B737` ile öğrenilen bilgi, `"Boeing 737"` ile sorgulandığında
aynı node'a erişmeli. Ambiguous bir alias ile deneme `AMBIGUOUS_ALIAS`
warning'i almalı.

---

### ER2D — Provenance / Search Alignment

**Amaç:** Search path'leri, `resolveEntity` üzerinden alias-aware olsun.

- `lib/provenance-query.js`:
  - `filters` yapısına `entityAlias: string` opsiyonu eklenir (veya mevcut
    `targetId`'nin alias olarak yorumlanması kabul edilir — bu, ayrı PR'de
    kararlaştırılır).
  - `queryProvenance` ve `queryTrustGraph` içinde: literal match başarısız
    ise, `resolveEntity(entityAlias)` denenir, canonical üzerinden
    `graph._nodes` lookup yapılır.
  - Ambiguous durumda: tüm candidate canonical'lar için sonuç döner
    (receipt array).
- `lib/sdk.js` (veya consumer'lar) opsiyonel `entityAlias` parametresi alır.

**Çıktılar:**
- Search, alias-farkında.
- Trust receipt'ler alias meta'sını taşır.
- UI / CLI: aynı sorguyu `B737` veya `"Boeing 737"` ile yapınca aynı sonuç.

**Davranış riski:** Orta. Eski davranış korunur (literal match önce), sadece
yeni alias path eklenir.

**Gözlem:** Aynı entity için farklı alias'larla yapılan aramalar eşdeğer sonuç
vermeli. Ambiguous aramada tüm adaylar görünmeli.

---

## 8. Test Stratejisi (Aşamaya Göre)

**Dokunulmaması gereken testler (PR-ER1 kapsamı):**

- `test/entity-resolution.test.js` (29 test, 273 satır): saf modül testi.
  Hiçbir aşamada değişmez. Yeni aşama testleri **yeni dosyalar** olur
  (örn. `test/verify-entity-resolution.test.js`,
  `test/ingest-entity-resolution.test.js`,
  `test/provenance-entity-resolution.test.js`).

**Aşama başına test hedefi:**

| Aşama | Test Dosyası | Minimum Hedef |
|-------|--------------|---------------|
| ER2A | `test/verify-entity-resolution.test.js` | receipt'te `entityResolution` meta varlığı; mevcut verdict'lar değişmez |
| ER2B | aynı dosya, ek describe | `B737` vs `"Boeing 737"` aynı sonuç; ambiguous `AI` fallback |
| ER2C | `test/ingest-entity-resolution.test.js` | canonical id ile node açılır; alias label korunur; ambiguous → yazma yok |
| ER2D | `test/provenance-entity-resolution.test.js` | alias search = literal search; ambiguous → candidate listesi |

**Hiçbir aşamada:**
- `test/entity-resolution.test.js`'e dokunulmaz.
- H-score testleri eklenmez (out of scope).
- Embedding/vector testleri eklenmez (out of scope).

---

## 9. Out of Scope (Bu PR'a ve Sıradaki Kod PR'lerine Göre)

**Bu PR'a (docs-only) girmez:**

- runtime verify integration code
- runtime learn integration code
- runtime search integration code
- herhangi bir runtime dosyasında import
- herhangi bir test dosyasında değişiklik

**Sıradaki kod PR'lerine (ER2A/B/C/D) girmez:**

- **H-score** (yüksek-risk alan gate'i). Bu, identity resolution'dan
  bağımsızdır ve ayrı bir PR olmalıdır. H-score, *entity'nin ne kadar
  güvenilir* olduğunu ölçer; entity resolution ise *hangi entity* olduğunu
  çözer. Karıştırılmamalıdır.
- **Embedding / vector search.** Tüm entity resolution saf, registry tabanlı,
  O(1)-arama yapısındadır. Vector katmanı eklemek, determinism garantisini
  bozar ve PR-ER1 kararıyla çelişir.
- **LLM tabanlı name disambiguation.** Aynı determinism gerekçesiyle.
- **High-risk domain gate / domain policy.** `lib/risk-rules.js` ve
  `detectHighRiskDomain` zaten mevcut; bu PR'ler bunlara dokunmaz.
- **Yeni API endpoint veya CLI komutu.** PR-ER2 sadece mevcut akışları
  genişletir, yüzey alanı eklemez.
- **Yeni HTTP API, MCP, Self-Healer.** AGENTS.md madde 9 ile zaten açıkça
  yasaklı; teyit amaçlı tekrar yazıldı.
- **kernel.js / graph.js / server.js / requestGuards.js / lib/verify.js
  / lib/shield.js / lib/causal/* / cli.js / package.json / package-lock.json
  / docs/** dışındaki değişiklikler.** Bu doküman plan PR'sidir; tüm
  entegrasyon kodları ayrı feature PR'lerinde gelecek.
- **`origin/main`'i direkt etkileyen merge / push.** Tüm PR'ler
  feature branch'ten, narrow PR olarak, Codex review sonrası merge edilir.

---

## 10. Risk ve Gözlemler

**Risk 1 — Domain bilgisi kaybı.** Eğer verify veya ingest path'inde
domain context düşmezse, `resolveEntity('AI')` her zaman `ambiguous: true`
döner. Bunu önlemek için:

- Aşama 1'de (ER2A) `domain` parametresi `workspace.metadata.domain`'dan
  okunur; yoksa `undefined` kalır (ambiguous path aktif olur).
- Workspace'e `metadata.domain` set etme sorumluluğu **bu PR'lerin
  kapsamı dışındadır**; CLI/SDK tarafında set edilebilir.

**Risk 2 — Audit trail kirliliği.** ER2C'de canonical id ile yazma yapılırken
orijinal literal label'ın kaybolmaması kritik. Bu, madde 2'deki
invariant'ın (`canonical entity id, original label'ı silmez`) kod
olarak uygulanması demektir. Test fixture'ı şu senaryoyu içermelidir:

```
Önce:   graph._nodes['B737']  ayrı node
        graph._nodes['Boeing 737'] ayrı node

ER2C sonrası:
        graph._nodes['boeing_737']  (canonical)
        node.label === 'B737'       (literal ilk yazan)
        node.metadata.aliases === ['B737']  (ilk literal)
```

**Risk 3 — Idempotency ihlali.** `companyBrain` capability'si zaten
`idempotencyKey` kullanıyor (ingest.js satır 21–26, 112). Ancak aynı
semantic içerik farklı literal'la gelirse (örn. `"B737 ucak"`,
`"Boeing 737 ucak"`), idempotency key farklı olur; ER2C bunları
**canonical** üzerinden aynı node'a bağlamazsa duplicate node oluşur.
Bu, ER2C'nin "literal" yerine "canonical" üzerinden idempotency
*hashing*'i düşünmesini gerektirir. **Açık soru, ER2C tasarımında
çözülecek.**

**Risk 4 — Geriye dönük davranış değişimi.** ER2B ve ER2D, eski `bilinmiyor`
sonuçlarını yeni `dogrulandi`/`celiski` sonuçlarına çevirebilir. Bu doğru
olsa da, kullanıcı tarafında observable davranış değişikliği olarak
görünür. Mitigation: her aşama kendi PR'inde, değişen davranışı vurgulayan
changelog satırı ile gelir.

**Risk 5 — Codex review ortamı.** Bu docs PR'i için targeted test yok.
`git status --short` + `git diff --stat` yeterli doğrulamadır. Full
`npm test` opsiyoneldir; ortam kaynaklı (örn. `better-sqlite3` missing)
pre-existing fail'ler blocker değildir — base comparison yapılır.

---

## 11. Karar Özeti (Sonraki Adımlar İçin)

- **Bu PR tamamlandığında** (docs merged to main), sıradaki PR'ler
  narrow + aşamalı olacak:
  1. **PR-ER2A** — `lib/verify.js` read-only probe, yeni test dosyası.
  2. **PR-ER2B** — `lib/verify.js` canonical-keyed lookup.
  3. **PR-ER2C** — `kernel.companyBrain` write-side anchoring.
  4. **PR-ER2D** — `lib/provenance-query.js` search alignment.
- Her biri ayrı feature branch, ayrı Codex review, ayrı merge.
- **Hiçbiri:** H-score, embedding, vector search, LLM, MCP, yeni API.
- Kod PR'leri başlatılmadan önce, bu planın Codex review ile
  ACCEPT/ACCEPT_WITH_NOTES almış olması zorunludur.

---

*Hazırlayan: AXIOM mimari notu, PR-ER1 (`c9b7dce`) üstüne inşa edilmiştir.*
*Base: `origin/main` @ `c1d2d54`.*
*Plan PR branch: `docs/pr-er2-entity-resolution-integration-plan`.*
