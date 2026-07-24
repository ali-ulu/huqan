# Decision 4D: Graph Workspace Contract for Plugin Private-Access Migration

> **Karar:** `devil-advocate` (ve diğer `graph._nodes` tüketicileri) her zaman
> `default` workspace ile sınırlıdır.
> **Status:** Binding — PR #81 post-merge remediation ile yazılı hale getirildi.
> **Canonical main:** `0336783f747eeaa0c4f16775f8f8cb19a8624ced`
> **Branch:** `fix/4d-5-devil-advocate-parity-evidence`
> **Önceki gate:** REFACTOR-4D_4D5_POST_MERGE_EVIDENCE_DEFECT

---

## 1. Karar

`devil-advocate` plugin'i, `graph._nodes` private erişimini `graph.getNodes('default')`
public API'sine迁移 ettikten sonra bile, erişilebilir node kümesi her zaman
`default` workspace ile sınırlıdır. Plugin, `opts` veya `context` üzerinden
kendisine geçirilen workspace ID'yi **kullanmaz** — `getNodes('default')` sabit
`'default'` argümanıyla çağrılır (`plugins/devil-advocate.js:45`).

Aynı kural, `graph._nodes` tüketicisi diğer plugin'ler için de bağlayıcıdır:
`contradiction-alert`, `company-brain`, `discovery-engine`, `idea-mri`. Bu
plugin'lerin her biri için `default`-workspace confinement geçerlidir.

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

`devil-advocate` bu metodu her zaman `'default'` argümanıyla çağırır
(`plugins/devil-advocate.js:45`). Bu nedenle plugin, yalnızca `default`
workspace içindeki node'ları görür.

### 2.2 Pre-migration `_nodes` davranışı

Migration öncesi kod, `kernel.graph?._nodes` map'ini doğrudan `extractFacts`'a
geçiriyordu:

```js
// Pre-migration (PR #81 öncesi)
const facts = typeof kernel.extractFacts === 'function'
  ? kernel.extractFacts(text, kernel.graph?._nodes) || []
  : [];
```

`_nodes`, tüm workspace'lerin storage key'lerini içerir. Storage key formatı
`nodeStorageKey(id, workspaceId)` tarafından belirlenir (`graph.js:42-44`):

```js
function nodeStorageKey(id, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  return scope === 'default' ? id : `${scope}::${id}`;
}
```

Yani `tenant-a` workspace'indeki `kedi` node'u, `_nodes` içinde
`'tenant-a::kedi'` key'iyle saklanır. Pre-migration kod, bu key'leri
`extractFacts`'ın `Object.keys(knownNodes)` enumeration'ına sokuyordu.

### 2.3 Post-migration `getNodes('default')` davranışı

Migration sonrası kod, `devilAdvocateKnownNodes(kernel)` helper'ı üzerinden
public API'yi tercih eder (`plugins/devil-advocate.js:42-48`):

```js
function devilAdvocateKnownNodes(kernel) {
  if (!kernel) return {};
  if (kernel.graph && typeof kernel.graph.getNodes === 'function') {
    return kernel.graph.getNodes('default');
  }
  return kernel.graph?._nodes || {};
}
```

Public API mevcut olduğunda, yalnızca `default` workspace'in node'larını içeren
filtered snapshot döner. Non-default workspace'lerin storage key'leri
(`'tenant-a::kedi'` vb.) snapshot'ta yer almaz.

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

## 3. C1 Sınıflandırması: Eski Global `_nodes` Davranışı

Eski global `_nodes` erişimi, üç sınıflı şemada aşağıdaki gibi etiketlenir:

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

### 3.2 OBSERVABLE_OUTPUT_LEAK_CONFIRMED — NO

**Kanıt:** `extractFacts`'ın matcher'ı (`nlp/lang-tr.js:64-70`), multi-word
candidate'ler dener:

```js
for (let len = Math.min(3, filtered.length - 1); len >= 2; len--) {
  const candidate = normalize(filtered.slice(0, len).join(' '));
  if (nodeIds.includes(candidate) || nodeIds.some(n => normalize(n) === candidate)) {
    const predicate = filtered.slice(len).join(' ');
    return [{ subject: candidate, predicate }];
  }
}
```

Matcher, `len >= 2` (en az 2 kelimelik) slice'leri denemektedir. Non-default
workspace storage key'leri `<workspace>::<id>` formatında tek token'dır
(`graph.js:44`); hiçbir çok-kelime phrasi ile eşleşemez.

Doğal dil girdisi için (örn. `"kedi hayvan"`), matcher ya multi-word candidate
denemez (filtered.length < 3 ise) ya da multi-word candidate'ler nodeIds içinde
yoktur. Fall-through yolu (`nlp/lang-tr.js:73-75`) `filtered[0]`'ı subject
olarak alır — bu, kullanıcının girdiğinin ilk kelimesidir, tenant verisi değil.

Adversarial girdi için (örn. `"tenant-a::kedi foo bar"`), kullanıcı kendi
storage key'ini yazmıştır; plugin yalnızca echo yapar. Bu bir leak değil,
kullanıcının kendi girdisidir.

Mevcut fixture ve gerçekçi input ile, tenant verisinin plugin dış çıktısına
taşındığı kanıtlanamamıştır. **OBSERVABLE_OUTPUT_LEAK_CONFIRMED = NO.**

### 3.3 NO_OBSERVABLE_OUTPUT_LEAK_REPRODUCED — YES (operative)

**Sonuç:** Başka workspace verisi `extractFacts` girdisine ulaşsa da
(`CROSS_WORKSPACE_INPUT_REACHABLE = YES`), mevcut fixture/input ile dış çıktıya
taşındığı kanıtlanamamıştır. **NO_OBSERVABLE_OUTPUT_LEAK_REPRODUCED = YES.**

Bu sınıflandırma, C2'deki koşullu adımların (regression testi +
`SECURITY_FOLLOWUP_REQUIRED`) gerektirmediği anlamına gelir. Yine de
post-migration `getNodes('default')` yolu, default-olmayan workspace verisini
girdiden de filtreleyerek savunma derinliğini artırır.

---

## 4. Bağlayıcı Olduğu Consumer'lar

Bu workspace contract, aşağıdaki `graph._nodes` tüketicileri için bağlayıcıdır:

### 4.1 Migration tamamlanmış (fallback kolu hâlâ `_nodes` kullanır)

| Plugin | PR | Public API çağrısı | Fallback |
|--------|-----|--------------------|----------|
| `devil-advocate` | PR #81 | `getNodes('default')` (`plugins/devil-advocate.js:45`) | `kernel.graph?._nodes` (`plugins/devil-advocate.js:47`) |
| `discovery-engine` | PR #78 | `getNodes('default')` (`plugins/discovery-engine.js:21`) | `kernel.graph?._nodes` (`plugins/discovery-engine.js:22`) |
| `idea-mri` | PR #79 | `getNodes('default')` (`plugins/idea-mri.js:33`) | `kernel.graph?._nodes` (`plugins/idea-mri.js:35`) |

Bu plugin'lerin fallback kolu, yalnızca `getNodes` metodunun bulunmadığı
eski test harness'ler ve mock kernel'ler için çalışır. Üretim `Graph`
instance'ı her zaman `getNodes`'a sahiptir; bu durumda public API yolu
tutarlı şekilde `'default'` workspace ile sınırlar.

### 4.2 Migration bekleyen (hâlâ doğrudan `_nodes`)

| Plugin | Erişim sayısı | Dosya / satır |
|--------|---------------|---------------|
| `company-brain` | 2 | `plugins/company-brain.js:114` (`Object.values(kernel.graph?._nodes \|\| {})`), `plugins/company-brain.js:246` (`kernel.extractFacts(text, kernel.graph?._nodes)`) |
| `contradiction-alert` | 1 | `plugins/contradiction-alert.js:68` (`kernel.extractFacts(text, kernel.graph?._nodes)`) |

Bu iki plugin, `default`-workspace confinement kuralına bağlıdır. Migration
PR'ları (her biri ayrı, AC-5.1 single-consumer kuralı gereği) aynı public API
idiomunu kullanmalı ve `getNodes('default')` ile `default` workspace'e
sınırlamalıdır. Bu plugin'lerin migration'ı Refactor-4D'nin kalan işidir;
bu doküman onların contract'ını önceden sabitler.

---

## 5. Reddedilen Alternatif: Context-Passed Workspace

### 5.1 Alternatif

`opts.workspaceId` veya `context.workspaceId` üzerinden çağırıcının plugin'e
workspace ID geçirmesi ve plugin'in `getNodes(opts.workspaceId || 'default')`
şeklinde dinamik workspace seçmesi.

### 5.2 Red gerekçesi

Bu alternatif, **Refactor-4E** kapsamına girer ve bu PR'da (PR #81
remediation) yapılmaz. Gerekçeler:

1. **AC-8.2 scope protection:** Refactor-4D contract acceptance
   (`docs/refactor/refactor-4d-contract-acceptance.md` AC-8.2) 4E1-4E4
   işlerinin bu gate'te yapılmamasını gerektirir. Context-passed workspace,
   4E'nin workspace-routing iş kapsamına dahildir.
2. **YAGNI:** Mevcut tüm `graph._nodes` tüketicileri (`devil-advocate`,
   `discovery-engine`, `idea-mri`, `company-brain`, `contradiction-alert`)
   `default` workspace'e sabitlenmiş davranışla çalışmaktadır. Hiçbir
   mevcut çağırıcı, workspace seçimi yapmamaktadır. Dinamik workspace
   desteği eklemek, mevcut ihtiyaç olmaksızın yeni bir public seam
   açar (AC-5.2'ye aykırı).
3. **Test matrisi karmaşıklığı:** Dinamik workspace, her plugin için
   workspace-koşullu davranış testlerini gerektirir. Bu, AC-5.1
   single-consumer kuralıyla çelişir — her PR'da workspace kombinasyonları
   test edilmelidir.
4. **Security blast radius:** Dinamik workspace, çağırıcının herhangi bir
   workspace'in verisine erişmesine olanak tanır. Bu, özellikle
   `company-brain` ve `contradiction-alert` gibi default-dışı workspace'leri
   de işleyebilen plugin'ler için tenant isolation riskini artırır.
   `default`-workspace confinement, blast radius'u tek workspace ile sınırlar.

### 5.3 4E'ye ertelenen iş

Context-passed workspace, şu adımları içerecektir (4E kapsamında):

- `opts.workspaceId` standardizasyonu (tüm plugin'ler için tutarlı semantik)
- Workspace-routing yeteneği olan plugin'lerin belirlenmesi
- Tenant isolation security review'u (her plugin için workspace-koşullu davranış)
- Yeni public seam ekleme (AC-5.2 altında değerlendirilecek)
- Workspace-koşullu test matrisi

Bu iş, Refactor-4D gate'inin dışındadır.

---

## 6. Kararla Çelişen Kaynak Kod Durumu

Bu karar yazılırken, kaynak kod aşağıdaki durumdadır:

- `plugins/devil-advocate.js:45` — `getNodes('default')` sabit argümanıyla
  çağrı. Kararla uyumlu.
- `plugins/discovery-engine.js:21` — `getNodes('default')` sabit argümanıyla
  çağrı. Kararla uyumlu.
- `plugins/idea-mri.js:33` — `getNodes('default')` sabit argümanıyla
  çağrı. Kararla uyumlu.
- `plugins/company-brain.js:114,246` — Hâlâ doğrudan `_nodes` erişimi.
  Migration bekliyor; bu doküman onun contract'ını önceden sabitler.
- `plugins/contradiction-alert.js:68` — Hâlâ doğrudan `_nodes` erişimi.
  Migration bekliyor; bu doküman onun contract'ını önceden sabitler.

Kararla çelişen bir kaynak kod bulgusu yoktur. Bulunursa, bu PR blocker
olarak durdurulur ve karar yeniden değerlendirilir (C5 kuralı).

---

## 7. Paket 02 ve 03 Üretimi İçin Önkoşul

Bu doküman, offline paket üretim sırasındaki Paket 02 ve 03'ün zorunlu
predecessor'ıdır:

```
PR #81 remediation merge
  + docs/refactor/decision-4d-graph-workspace-contract.md (bu doküman)
  → Paket 02 ve 03 üretilebilir
```

Paket üretimi, bu dokümandaki `default`-workspace confinement kararına
dayanır. Karar değişirse, paketler yeniden üretilmelidir.
