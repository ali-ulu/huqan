# Decision 4D: Graph Workspace Contract for Plugin Private-Access Migration

> **Karar:** `graph._nodes` private erişiminden `graph.getNodes(<scope>)` public
> API'ye geçiş yapan her plugin için **kendi source-reality'sine göre ayrı**
> workspace contract tanımlanır. Tek bir global "tüm tüketiciler default
> workspace" hükmü **verilmez**.
> **Status:** Binding — PR #81 post-merge remediation ile yazılı hale getirildi
> (PR #82 düzeltme turu: consumer/use-case matrisine indirgenmiş hali).
> **Canonical main:** `0336783f747eeaa0c4f16775f8f8cb19a8624ced`
> **Branch:** `fix/4d-5-devil-advocate-parity-evidence`
> **Önceki gate:** REFACTOR-4D_4D5_POST_MERGE_EVIDENCE_DEFECT

---

## 1. Karar

`graph._nodes` private erişiminden `graph.getNodes(<scope>)` public API'ye
geçiş yapan her plugin için **kendi source-reality'sine göre ayrı** workspace
contract tanımlanır. Tek bir global "tüm tüketiciler default workspace" hükmü
aşağıdaki source-reality bulgusu nedeniyle **verilmez**:

- `plugins/company-brain.js:113-127` (`rankGraphMatches`) zaten `workspaceId`
  parametresi alır ve `node.workspaceId` üzerinden filtreler.
- `plugins/company-brain.js:178-233` (`queryCompanyBrain`) `input.workspaceId`
  alanını `rankGraphMatches`'a geçirir (`plugins/company-brain.js:185-186`).
  Bu, runtime'da zaten **dinamik workspace** davranışıdır; default'a sabitlemek
  davranış parity'si değil, mevcut yeteneği kırmaktır.
- `plugins/contradiction-alert.js:66-68` çağrı yüzeyinde workspace context
  açık değildir; `kernel.graph?._nodes` doğrudan `extractFacts`'a geçirilir ve
  `getEdges(subject)` (`plugins/contradiction-alert.js:78-80`) workspace
  argümanı olmadan çağrılır. Bu plugin için workspace contract,
  call-site/source-reality audit tamamlanmadan **sabitlenmez**.

Her consumer/use-case için binding contract Bölüm 4'teki matriste verilmiştir.

---

## 2. Gerekçe

### 2.1 Public API workspace filtrelemesi

`Graph.getNodes(workspaceId)` (`graph.js:617-626`) çağrıldığında, `workspaceId`
parametresine göre filtrelenmiş bir snapshot döner:

```js
getNodes(workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  const nodes = {};
  for (const [id, node] of Object.entries(this._nodes)) {
    if (normalizeWorkspaceId(node.workspaceId) === scope) {
      nodes[id] = cloneNodeRecord(node);
    }
  }
  return nodes;
}
```

Public API'yi çağıran plugin, hangi `workspaceId` argümanını geçirirse snapshot
onu döner. Sabit `'default'` geçiren plugin yalnızca default workspace'i görür;
`opts.workspaceId` veya `input.workspaceId` geçiren plugin dinamik workspace
davranışı sergiler.

### 2.2 Pre-migration `_nodes` davranışı

Migration öncesi kod, `kernel.graph?._nodes` map'ini doğrudan
`extractFacts`'a geçiriyordu. Bu davranış `devil-advocate`,
`discovery-engine`, `idea-mri` plugin'leri için geçerlidir ve PR #78/#79/#81
ile public API'ye taşınmıştır.

`company-brain`'de ise `_nodes` erişimi **iki ayrı use-case**'de kullanılır ve
bu iki use-case aynı workspace varsayımını paylaşmaz (Bölüm 4.2'ye bakınız).

`_nodes`, tüm workspace'lerin storage key'lerini içerir. Storage key formatı
`nodeStorageKey(id, workspaceId)` tarafından belirlenir (`graph.js:42-44`):

```js
function nodeStorageKey(id, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  return scope === 'default' ? id : `${scope}::${id}`;
}
```

### 2.3 Workspace ID normalizasyonu — invariant yok

`normalizeWorkspaceId` (`graph.js:37-40`) yalnızca `value.trim()` yapar:

```js
function normalizeWorkspaceId(value, fallback = 'default') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}
```

Bu fonksiyon **workspace ID'nin içeriği üzerinde herhangi bir delimiter
invariant'ı uygulamaz**. Boşluk içeren bir workspace ID (örn. `"tenant a"`)
veya `::` içeren bir workspace ID (örn. `"tenant::nested"`) storage key
üretirken ayrıştırılabilirlik garantisi vermez. Aynı durum node ID'leri için
de geçerlidir — `nodeStorageKey` herhangi bir input validation yapmaz.

Sonuç: "storage keys are always single-token" genellemesi **kanıtlanmamıştır**.
Bu PR'da bu invariant'ı iddia etmiyoruz; future hardening candidate olarak
Bölüm 5'te işaretlenmiştir.

### 2.4 Public API idiom

`devil-advocate.js:44` satırındaki idiom:

```js
typeof kernel.graph.getNodes === 'function'
```

Bu idiom, `getNodes` metodunun varlığını kontrol eder. `getNodes`,
`Graph.prototype` üzerinde tanımlı bir instance metodudur (`graph.js:617`).
Plain mock graph'ler (örn. eski test harness'ler) `getNodes` metoduna sahip
değilse, plugin `_nodes` fallback'ine düşer. Bu, backward-compatibility
gereği korunur.

---

## 3. C1 Sınıflandırması: Eski Global `_nodes` Davranışı (devil-advocate)

Eski global `_nodes` erişimi, üç sınıflı şemada aşağıdaki gibi etiketlenir.
Bu sınıflandırma **yalnızca devil-advocate** içindir; diğer consumer'lar
Bölüm 4'te ayrı sınıflandırılır.

### 3.1 CROSS_WORKSPACE_INPUT_REACHABLE — YES

**Kanıt:** Pre-migration `kernel.graph?._nodes`, tüm workspace'lerin storage
key'lerini içerir. `extractFacts` (`nlp/lang-tr.js:60-62`) bu map'in
`Object.keys()`'ini alır:

```js
const nodeIds = typeof knownNodes === 'object' && !Array.isArray(knownNodes)
  ? Object.keys(knownNodes)
  : (Array.isArray(knownNodes) ? knownNodes : []);
```

`Object.keys(_nodes)`, hem `default` workspace key'lerini (`'kedi'`) hem de
non-default workspace key'lerini (`'tenant-a::kedi'`) döner. Bu key'ler,
`extractFacts`'ın matcher'ına `nodeIds` olarak geçer.

Sonuç: başka workspace'lerin storage key'leri, `extractFacts` girdisine
ulaşıyordu. **CROSS_WORKSPACE_INPUT_REACHABLE = YES.**

### 3.2 OBSERVABLE_OUTPUT_LEAK_CONFIRMED — NOT DETERMINED

Bu PR'da genel mimari hüküm olarak `OBSERVABLE_OUTPUT_LEAK_CONFIRMED = NO`
verilmez. Bunun yerine, aşağıdaki dar hüküm verilir:

```
OBSERVABLE_OUTPUT_LEAK_NOT_REPRODUCED
for the tested identifier shapes and the fixtures in plugin.test.js
```

**Kanıt sınırları:**

- `extractFacts`'ın matcher'ı (`nlp/lang-tr.js:64-70`), `len >= 2` (en az 2
  kelimelik) slice'leri dener. Test fixture'larımızdaki non-default
  workspace storage key'leri (`<workspace>::<id>` formatında) tek token
  olduğu için bu multi-word candidate'lerle eşleşmez.
- `nlp/lang-tr.js:71`'deki `normalize` fonksiyonu yalnızca lower-case/trim
  ve çoğul eki işler; whitespace veya `::` içeren kimlikleri ayrıştırırken
  ek invariant uygulamaz.
- Test fixture'larımız `tenant-a`, `kedi`, `default` gibi basit ASCII
  kimliklerle sınırlıdır. Boşluk içeren workspace ID, `::` içeren workspace
  ID, veya Unicode-whitespace içeren kimliklerle leak repro edilmemiştir.

**Sonuç:** Test edilen kimlik şekilleri ve fixture'lar için observable leak
repro edilemedi. Genel mimari imkânsızlık **kanıtlanmadı**. future hardening
için Bölüm 5'e kaydedilmiştir.

### 3.3 NO_OBSERVABLE_OUTPUT_LEAK_REPRODUCED — YES (operative, fixture-bound)

**Sonuç:** Test edilen fixture ve kimlik şekilleri için, başka workspace
verisinin `extractFacts` girdisine ulaşması (`CROSS_WORKSPACE_INPUT_REACHABLE
= YES`) observable output leak'e repro edilemedi
(`NO_OBSERVABLE_OUTPUT_LEAK_REPRODUCED = YES`).

Bu sınıflandırma, C2'deki koşullu adımların **fixture-bound** olarak
gerektirmediği anlamına gelir. Yine de post-migration `getNodes('default')`
yolu, default-olmayan workspace verisini girdiden de filtreleyerek savunma
derinliğini artırır. Bu hardening, **genel imkânsızlık kanıtı değil**,
defense-in-depth katmanıdır.

---

## 4. Consumer / Use-Case Matrisi (Binding Contract)

Aşağıdaki matris, her `graph._nodes` tüketicisi için **kendi source-reality'sine
göre ayrı** workspace contract tanımlar. Tek bir global hüküm verilmez.

### 4.1 Migration tamamlanmış (fallback kolu hâlâ `_nodes` kullanır)

| Plugin | PR | Public API çağrısı | Fallback | Workspace Contract |
|--------|-----|--------------------|----------|---------------------|
| `devil-advocate` | PR #81 | `getNodes('default')` (`plugins/devil-advocate.js:45`) | `kernel.graph?._nodes` (`plugins/devil-advocate.js:47`) | **default workspace** (sabit argüman) |
| `discovery-engine` | PR #78 | `getNodes('default')` (`plugins/discovery-engine.js:21`) | `kernel.graph?._nodes` (`plugins/discovery-engine.js:22`) | **default workspace** (sabit argüman) |
| `idea-mri` | PR #79 | `getNodes('default')` (`plugins/idea-mri.js:33`) | `kernel.graph?._nodes` (`plugins/idea-mri.js:35`) | **default workspace** (sabit argüman) |

Bu üç plugin'in fallback kolu, yalnızca `getNodes` metodunun bulunmadığı
eski test harness'ler ve mock kernel'ler için çalışır. Üretim `Graph`
instance'ı her zaman `getNodes`'a sahiptir; bu durumda public API yolu
tutarlı şekilde `'default'` workspace ile sınırlar.

### 4.2 Migration bekleyen (hâlâ doğrudan `_nodes`) — use-case bazında sınıflandırma

`company-brain` ve `contradiction-alert` plugin'leri migration bekliyor.
Ancak bu plugin'lerin her biri **ayrı use-case**'lere sahiptir ve tek bir
global workspace kararı verilemez.

#### 4.2.1 `company-brain` / `queryCompanyBrain` — DİNAMİK WORKSPACE

**Source reality:**

- `plugins/company-brain.js:185`: `const workspaceId = String(input.workspaceId || 'default').trim() || 'default';`
- `plugins/company-brain.js:186`: `const matches = rankGraphMatches(kernel, tokens, workspaceId);`
- `plugins/company-brain.js:113-127` (`rankGraphMatches`): `workspaceId`
  parametresi alır ve `node.workspaceId` üzerinden filtreler
  (`if (workspaceId && (node.workspaceId || 'default') !== workspaceId) continue;`).

**Binding contract:** Migration, mevcut dinamik workspace davranışını
**korumalıdır**. `getNodes('default')` çağrısı yapılmaz; bunun yerine
`getNodes(input.workspaceId || 'default')` çağrılır. `input.workspaceId`
yoksa `'default'` fallback korunur.

> **Uyarı:** Bu plugin'in migration'ı sırasında `getNodes('default')` sabit
> argümanıyla çağrılırsa, mevcut `queryCompanyBrain` workspace-routing
> yeteneği kırılır. Bu bir parity fix değil, davranış regresyonudur.

#### 4.2.2 `company-brain` / `ingestManual` — AYRI USE-CASE

**Source reality:**

- `plugins/company-brain.js:245-247`: `const facts = typeof kernel.extractFacts === 'function' ? (kernel.extractFacts(text, kernel.graph?._nodes) || []) : [];`
- Bu çağrı, `queryCompanyBrain` ile aynı `_nodes` map'ini kullanır ama
  farklı amaçla: `extractFacts` için known-node enumeration. Workspace
  filtrelemesi yapılmaz.

**Binding contract:** Bu use-case için workspace contract **ayrıca**
sınıflandırılmalıdır. `queryCompanyBrain` ile aynı varsayımı yapma. İki
olası contract adayı:

1. `default` workspace (mevcut davranışın parity'si için) — `getNodes('default')` ile.
2. `input.workspaceId` üzerinden dinamik (kullanıcı ingest sırasında
   workspace belirtiyorsa) — `getNodes(input.workspaceId || 'default')` ile.

Bu PR'da bu contract **sabitlenmez**; migration PR'ında call-site audit
ile kararlaştırılır. future consumer contract candidate olarak işaretlenir.

#### 4.2.3 `contradiction-alert` — AUDIT PENDING

**Source reality:**

- `plugins/contradiction-alert.js:68`: `const facts = typeof kernel.extractFacts === 'function' ? kernel.extractFacts(text, kernel.graph?._nodes) || [] : [];`
- `plugins/contradiction-alert.js:78-80`: `kernel.graph.getEdges(subject)`
  çağrısı `workspaceId` argümanı olmadan yapılır. `Graph.getEdges` default
  olarak `'default'` workspace'i kullanır.

**Binding contract:** Bu plugin için workspace context açık değildir.
Call-site/source-reality audit tamamlanmadan **binding default kararı
verilmez**. Migration PR'ında aşağıdakiler incelenmelidir:

- Tüm çağırıcılar (`server.js`, CLI, MCP adapter) `input.workspaceId`
  geçiriyor mu?
- `getEdges(subject)` çağrısında `workspaceId` argümanı eksikliği
  kasıtlı mıdır (default confinement) yoksa oversight mı?
- Migration sırasında `getNodes(input.workspaceId || 'default')` mi yoksa
  `getNodes('default')` mi?

Audit tamamlanana kadar: **AUDIT_PENDING — NO BINDING DECISION.**

### 4.3 Matris özeti

| Plugin / Use-case | Current contract | Migration target | Binding status |
|---|---|---|---|
| `devil-advocate` | default workspace | `getNodes('default')` (PR #81 done) | BINDING |
| `discovery-engine` | default workspace | `getNodes('default')` (PR #78 done) | BINDING |
| `idea-mri` | default workspace | `getNodes('default')` (PR #79 done) | BINDING |
| `company-brain` / `queryCompanyBrain` | dynamic `input.workspaceId` | `getNodes(input.workspaceId \|\| 'default')` | BINDING (dinamik korunur) |
| `company-brain` / `ingestManual` | `_nodes` doğrudan, workspace filtre yok | call-site audit gerek | CANDIDATE — bu PR'da sabitlenmez |
| `contradiction-alert` | `_nodes` doğrudan + `getEdges(subject)` (workspace yok) | call-site audit gerek | AUDIT_PENDING — bu PR'da sabitlenmez |

---

## 5. Reddedilen Alternatifler ve Future Candidates

### 5.1 Context-Passed Workspace — FUTURE CANDIDATE (binding 4E değildir)

`opts.workspaceId` veya `context.workspaceId` üzerinden çağırıcının plugin'e
workspace ID geçirmesi ve plugin'in `getNodes(opts.workspaceId || 'default')`
şeklinde dinamik workspace seçmesi.

**Status:** Bu PR'da yapılmaz. Ancak **"kesin Refactor-4E kapsamıdır" hükmü
verilmez**; aşağıdaki ihtiyatlı etiket kullanılır:

> **future orchestration scope candidate** — mevcut 4E1-4E4 iş listesinde
> (`docs/task-packs/refactor-4a-surface-parity-inventory.md:241-245`)
> "context-passed workspace" veya "workspace routing" maddesi açıkça
> listelenmemiştir. 4E1 (filesystem/JSON/SQLite/persistence direction),
> 4E2 (Rust/signing/key resolver isolation), 4E3 (MCP/server adapter
> isolation), 4E4 (residual Graph read boundaries) — workspace-routing
> bu maddelerden herhangi birinin doğrudan alt maddesi değildir.

**Yine de bu PR'da yapılmaz, çünkü:**

1. **AC-8.2 scope protection:** Refactor-4D contract acceptance
   (`docs/refactor/refactor-4d-contract-acceptance.md:104` AC-8.2) 4E1-4E4
   işlerinin bu gate'te yapılmamasını gerektirir. Context-passed workspace
   eklemek yeni bir public seam açar; bu 4E gate'inde değerlendirilmelidir.
2. **YAGNI:** `devil-advocate`, `discovery-engine`, `idea-mri` plugin'leri
   `default` workspace'e sabitlenmiş davranışla çalışmaktadır. Bu üç
   plugin için context-passed workspace ihtiyacı yoktur.
   `company-brain`/`queryCompanyBrain` zaten dinamik workspace kullanır;
   bu plugin için context-passed workspace değil, mevcut
   `input.workspaceId` seam'inin korunması yeterlidir.
3. **Test matrisi karmaşıklığı:** Dinamik workspace, her plugin için
   workspace-koşullu davranış testlerini gerektirir. Bu, AC-5.1
   single-consumer kuralıyla çelişir — her PR'da workspace kombinasyonları
   test edilmelidir.

**Future candidate olarak kaydedilen iş:**

- `opts.workspaceId` standardizasyonu (tüm plugin'ler için tutarlı semantik)
- Workspace-routing yeteneği olan plugin'lerin belirlenmesi
- Tenant isolation security review'u (her plugin için workspace-koşullu davranış)
- Yeni public seam ekleme (AC-5.2 altında değerlendirilecek)
- Workspace-koşullu test matrisi
- **Workspace/node ID invariant enforcement** (Bölüm 5.2'ye bakınız)

Bu iş, Refactor-4D gate'inin dışındadır. Hangi 4E alt maddesine dahil
edileceği 4E gate planlamasında kararlaştırılır.

### 5.2 Storage-Key Single-Token Invariant — FUTURE HARDENING CANDIDATE

Bölüm 2.3'te belgelendiği üzere, `normalizeWorkspaceId` ve `nodeStorageKey`
workspace/node ID'lerinin delimiter (`::`) veya whitespace içermemesi
gerektiği invariant'ı uygulamaz. Bu PR'da "storage keys are always
single-token" genellemesi **kanıtsız olduğu için kaldırılmıştır**.

**Future hardening candidate:**

- `normalizeWorkspaceId`'ye delimiter/whitespace validation ekleme
- `nodeStorageKey`'e round-trip parsing testi ekleme
- Workspace ID formatını RFC benzeri spec ile sabitleme

Bu iş bu PR'da yapılmaz; future hardening candidate olarak işaretlenir.

### 5.3 Mutation Evidence Reproducibility — DOĞRULANMAMIŞ

PR #82'nin ilk turunda yürütülen mutation testi (geçici `getNodes` ekleme →
FAIL → geri al → GREEN → git diff doğrula), **yalnızca yerel transient
işlem** olarak yürütülmüştür. Bu evidence GitHub CI artifact'ından bağımsız
olarak yeniden reproducie edilemez.

Future candidate: mutation testini CI'a taşıma (örn. Stryker.js entegrasyonu).
Bu iş bu PR'da yapılmaz.

---

## 6. Kararla Çelişen Kaynak Kod Durumu (Düzeltme Turu Bulgusu)

PR #82'nin ilk turundaki karar dokümanı "tüm `graph._nodes` tüketicileri
default workspace" hükmünü vermişti. Bağımsız review şu source-reality
bulgusuyla bu hükmü çürüttü:

- `plugins/company-brain.js:113-127` (`rankGraphMatches`) `workspaceId`
  parametresi alır ve `node.workspaceId` üzerinden filtreler.
- `plugins/company-brain.js:185-186` (`queryCompanyBrain`)
  `input.workspaceId`'yi `rankGraphMatches`'a geçirir.

Bu bulgu, ilk tur kararının Bölüm 1 ve Bölüm 4'üyle çelişiyordu. Bu düzeltme
turunda Bölüm 1 ve Bölüm 4 consumer/use-case matrisi olarak yeniden
yazılmıştır (yukarıya bakınız).

Kalan kaynak kod durumu:

- `plugins/devil-advocate.js:45` — `getNodes('default')` sabit argümanıyla
  çağrı. Bölüm 4.1 contract ile uyumlu.
- `plugins/discovery-engine.js:21` — `getNodes('default')` sabit argümanıyla
  çağrı. Bölüm 4.1 contract ile uyumlu.
- `plugins/idea-mri.js:33` — `getNodes('default')` sabit argümanıyla
  çağrı. Bölüm 4.1 contract ile uyumlu.
- `plugins/company-brain.js:113-127,185-186` — Dinamik workspace davranışı.
  Bölüm 4.2.1 contract ile uyumlu (migration dinamik workspace'i korur).
- `plugins/company-brain.js:245-247` — `ingestManual` use-case'i. Bölüm 4.2.2
  contract ile uyumlu (audit pending).
- `plugins/contradiction-alert.js:66-80` — Workspace context açık değil.
  Bölüm 4.2.3 contract ile uyumlu (audit pending).

Kararla çelişen yeni bir kaynak kod bulgusu yoktur. Bulunursa, bu PR blocker
olarak durdurulur ve karar yeniden değerlendirilir (C5 kuralı).

---

## 7. Paket 02 ve 03 Üretimi İçin Önkoşul

Bu doküman, offline paket üretim sırasındaki Paket 02 ve 03'ün zorunlu
predecessor'ıdır:

```
PR #82 (bu düzeltme turu) merge
  + docs/refactor/decision-4d-graph-workspace-contract.md (bu doküman)
  → Paket 02 ve 03 üretilebilir
```

Paket üretimi, bu dokümandaki consumer/use-case matrisine dayanır. Matris
değişirse, paketler yeniden üretilmelidir. Özellikle:

- `company-brain` / `queryCompanyBrain` migration'ı dinamik workspace'i
  korumazsa, Paket 02/03 yeniden üretilmelidir.
- `company-brain` / `ingestManual` veya `contradiction-alert` migration'ı
  sırasında call-site audit yeni bir contract ortaya koyarsa, bu doküman
  güncellenmeli ve paketler yeniden üretilmelidir.
