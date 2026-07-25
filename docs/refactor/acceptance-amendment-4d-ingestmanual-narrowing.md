# Acceptance Amendment 4D: `ingestManual` Default-Workspace Narrowing

> **Karar:** `company-brain` / `ingestManual` use-case'inde `kernel.graph._nodes`
> doğrudan erişiminden `kernel.graph.getNodes('default')` public API'ye geçiş
> **intentional default-workspace narrowing** olarak kabul edilir.
> **Status:** Binding — bu amendment PR'ı merge edilene kadar runtime
> implementasyonu için yetki **verilmez**.
> **Canonical main (base):** `d3f4221e61749f589fb36f741a95630cdee6cea4`
> **Branch:** `refactor/4d-amendment-ingestmanual-narrowing`
> **Önceki gate:** PR #84 merge (`d3f4221e`) — Package 03 contract correction
> **Sonraki gate:** Package 03 runtime implementation (her iki use-case atomik)

---

## 0. Bağlayıcı Hüküm

Aşağıdaki blok bu amendment'ın tek bağlayıcı özetidir. Çelişki durumunda bu
blok üstündür; ayrıntı Bölüm 1–9'da verilir.

```text
DECISION:
ACCEPT INTENTIONAL DEFAULT-WORKSPACE NARROWING

CLASSIFICATION:
WORKSPACE_ISOLATION_DEFECT
CROSS_WORKSPACE_INPUT_CONTAMINATION_RISK
OBSERVABLE_DATA_LEAK_NOT_PROVEN

AC-5.3:
UNCHANGED

NEW EXCEPTION:
AC-5.3a EXPLICITLY APPROVED ISOLATION NARROWING

WRITE CONTRACT:
DEFAULT WORKSPACE

READ CONTRACT:
DEFAULT WORKSPACE

PACKAGE 03:
ATOMIC

RUNTIME AUTHORITY:
NOT GRANTED UNTIL AMENDMENT PR MERGES
```

---

## 1. Kapsam ve Dayanak

Bu amendment, `docs/refactor/decision-4d-graph-workspace-contract.md` Bölüm
4.2.2'de tespit edilen ve Bölüm 4.3 matrisinde `BLOCKED` olarak işaretlenen
`company-brain` / `ingestManual` use-case'inin migration contract'ını
saptar. `decision-4d-graph-workspace-contract.md` Bölüm 4.2.2 bu
amendment'ı işaret eder; bu PR amendment dosyasını **ve** aynı PR'da
`decision-4d-graph-workspace-contract.md`'nin `BLOCKED` hükmünü
amendment-authorized contract ile hizalar ve `refactor-4d-contract-acceptance.md`
acceptance matrix'ine `AC-5.3a` satırını ekler. Üç dosya birlikte merge
edilir; ayrı açılmaz.

Dayanak noktaları (her biri `decision-4d-graph-workspace-contract.md`'de
kayda geçmiştir):

- `plugins/company-brain.js:235-300` (`ingestManual` fonksiyon aralığı) —
  `input.text` (`:236`), `input.author` (`:239`), `input.date` (`:240`),
  `input.domain` (`:256`), `input.sessionId` (`:264`, `:274`, `:288`).
  Fonksiyon `input.workspaceId`'yi **okumaz**.
- `plugins/company-brain.js:245-247` — `kernel.graph?._nodes` doğrudan
  `extractFacts`'a geçirilir, workspace filtresi yoktur.
- `plugins/company-brain.js:45-60` — `addCompanyEdge` fonksiyon aralığı;
  `:46-47` `proposeNode`, `:48-58` `proposeEdge`. Workspace argümanı
  geçmez; yazımlar konstrüksiyon gereği **default** workspace'e gider.
- `graph.js:617-626` — `Graph.getNodes(workspaceId)` `node.workspaceId`
  üzerinden filtreler, yalnız o workspace'in node'larını döndürür.
- `graph.js:620` — `Graph._nodes` düz bir map'tir, **bütün workspace'lerin**
  node'larını taşır, workspace ayrımı yapılmadan gezilir.

---

## 2. Q1 — Daraltma Kabulü

**Kabul:** `ingestManual` aşağıdaki contract'a geçirilir.

```text
known nodes:
kernel.graph.getNodes('default')
```

**Yeni public API açılmaz.** Özellikle, workspace filtresiz yeni bir public
seam (`getNodes()` argümansız varyantı, `getAllNodes()` benzeri) bu
amendment'la **yetkilendirilmez**. `decision-4d-graph-workspace-contract.md`
Bölüm 4.2.1'de belirtilen dinamik workspace adayı
(`getNodes(input.workspaceId || 'default')`) bu use-case için ölüdür; call-site
audit (`decision-4d-graph-workspace-contract.md` Bölüm 4.2.2, 2026-07-25)
`ingestManual`'a workspace geçiren girdi yolu olmadığını kanıtlamıştır.

Migration hedefi tek bir sabit argümandır: `'default'`. Bu, PR #84 ile
merge edilen source-reality kararı ve belirtilen kaynak satırları tarafından
desteklenir.

---

## 3. Q2 — Mevcut Davranışın Niteliği

Mevcut davranış aşağıdaki üç etiketle sınıflandırılır. Bu etiketler
birlikte okunmalıdır; tek başına hiçbiri tüm resmi vermez.

```text
WORKSPACE_ISOLATION_DEFECT
CROSS_WORKSPACE_INPUT_CONTAMINATION_RISK
OBSERVABLE_DATA_LEAK_NOT_PROVEN
```

### 3.1 `WORKSPACE_ISOLATION_DEFECT`

`ingestManual` default workspace'e yazmaktadır (`addCompanyEdge` →
`proposeNode`/`proposeEdge` workspace argümansız → default). Aynı use-case
okuma için `kernel.graph._nodes` map'inin tamamını `extractFacts`'a
geçirmektedir. Bu map tüm workspace'lerin node'larını içerir (`graph.js:620`).

Yazma ve okuma workspace'leri arasındaki bu asimetri, workspace izolasyonu
için bir defekttir: bir use-case yalnızca kendi yazdığı workspace'in
içeriğini görüntülemeli iken, mevcut implementasyon bütün tenant'ların
node'larını extraction girdisi olarak görmektedir.

### 3.2 `CROSS_WORKSPACE_INPUT_CONTAMINATION_RISK`

Default workspace'e yazan bir use-case'in başka workspace'lerin node'larını
`extractFacts` girdisi olarak kullanması, çapraz-workspace etkileşimidir.
`extractFacts`'in ürettiği fact'ler, default workspace dışından node
identifier'ları içerebilir; bu fact'ler daha sonra default workspace'e
`proposeEdge` ile yazılır. Bu, default workspace'in içerdiği bilginin
kaynağının default-only olmamasıdır — yani **input contamination risk**.

Risk kelimesi kullanılmıştır: bu, **kanıtlanmış bir sızıntı** değildir; bkz.
Bölüm 3.3. Risk, olası etki kanalının varlığıdır, gerçekleşmiş veri
sızıntısı değil.

### 3.3 `OBSERVABLE_DATA_LEAK_NOT_PROVEN`

"Kesin veri sızıntısı" hükmü **verilmez**. Bunun gerekçesi:

- `extractFacts`'in ürettiği fact'lerin observable output'a (kullanıcıya
  dönen response, log, REST/MCP yanıtı) nasıl yansıdığı bu amendment'ın
  kapsamı dışındadır.
- Bu use-case (`company-brain` / `ingestManual`) için observable leak'i
  **kanıtlayan veya çürüten case-specific test henüz yürütülmemiştir**.
  PR #82 Tour 2 kaydındaki `OBSERVABLE_OUTPUT_LEAK_NOT_REPRODUCED` hükmü
  yalnızca **test edilen identifier şekilleri** için verilmişti ve
  `devil-advocate` / `discovery-engine` / `idea-mri` workspace
  kontratı bağlamındaydı; `company-brain` / `ingestManual` için
  yürütülmüş bir leak testi değildir. Bu nedenle o kayıt `ingestManual`
  için dayanak olarak kullanılamaz.
- Bu nedenle "veri sızdırdı" demek, eldeki kanıtın önünde bir ifadedir.
  Aynı şekilde "kesinlikle sızdırmaz" demek de kanıtın önünde bir ifadedir;
  bu nedenle `NOT_PROVEN` etiketi kullanılır, `CONFIRMED` veya `IMPOSSIBLE`
  etiketleri kullanılmaz.

Bu etiketin amacı **sızıntıyı inkâr etmek değil**, kanıtlanmamış bir iddiayı
belgelemektir. Narrowing, sızıntı kanıtına dayanmaz; **workspace izolasyon
defektine** (Bölüm 3.1) ve **input contamination riskine** (Bölüm 3.2) dayanır.

### 3.4 Kasıtlı global-knowledge contract değildir

Mevcut davranış, "default workspace shared/global knowledge görür" şeklinde
belgelenmiş bir sözleşme değildir. Hiçbir doküman, comment veya test bu
davranışı bilinçli bir tasarım kararı olarak kaydetmemiştir. Bu, belgelenmemiş
bir çapraz-workspace etkileşimdir ve bu amendment onu kasıtlı bir
**default-only** contract'a indirger.

---

## 4. Q3 — AC-5.3 ve AC-5.3a

### 4.1 AC-5.3 değişmez

`docs/refactor/refactor-4d-contract-acceptance.md` Bölüm AC-5.3 hükmü
aynen korunur:

```text
5.3 | Davranış kanıtı | parity testleri gözlemlenebilir davranışın
    | değişmediğini kanıtlar | parity testi yok
```

AC-5.3 gevşetilmez. AC-5.3'ün "observable parity zorunlu" şartı, normal
migration'lar için aynen bağlayıcıdır.

### 4.2 AC-5.3a — yeni dar istisna

AC-5.3'ün yanına **ayrı ve açık** bir istisna eklenir. Bu istisna AC-5.3'ü
değiştirmez; ona paralel bir dar kapıdır:

```text
AC-5.3a — Explicitly Approved Isolation Narrowing

Normal migration:
observable parity zorunlu (AC-5.3)

İstisna (AC-5.3a):
kanıtlanmış isolation defect için
insan onaylı intentional narrowing
+ characterization test
+ negative fixture / mutation guard

İstisna AC-5.3'ü gevşetmez; ayrı ve açık olur.
```

AC-5.3a'nın koşulları Bölüm 9'da (Precedent kuralları) listelenmiştir. Bu
amendment PR'ı merge edilene kadar AC-5.3a henüz yürürlüğe girmemiş sayılır;
merge ile birlikte Bölüm 9'daki sekiz koşul gelecekteki narrowing durumları
için bağlayıcı precedent olur.

### 4.3 Test adlandırma kuralı

AC-5.3a altında üretilen testler **"parity testi" olarak adlandırılmaz**.
Aşağıdaki iki ad kullanılır:

```text
intentional narrowing characterization test
workspace isolation regression test
```

Bu adlandırma, AC-5.3'ün "parity" kelimesiyle çelişmeyi önler ve testin
negatif karakterini açıkça belirtir.

---

## 5. Q4 — Karakterizasyon Testi Tasarımı

Aşağıdaki tasarım Package 03 runtime implementation PR'ında uygulanır. Bu
amendment test tasarımını bağlayıcı kılar; implementation PR'ı bu tasarıma
uymak zorundadır.

### 5.1 Fixture

```text
Graph:
- default workspace node
- tenant-a workspace node
- çakışabilecek/benzeşebilecek identifier veya label
  (aynı label, farklı workspace)
```

Fixture'ın amacı, daraltmanın observable bir etki yarattığı minimal senaryoyu
kurmak. İki node'un identifier/label benzeşmesi, `extractFacts`'in known-node
lookup yaparken workspace filtresinin farkını gösterebilmesi içindir.

### 5.2 `ingestManual` çağrısı

```text
ingestManual:
- default-bound input (workspaceId geçirilmez)
- extractFacts'e geçirilen knownNodes capture edilir
```

`ingestManual` çağrısının `input.workspaceId` içermemesi, Bölüm 4.2.2
call-site audit ile tutarlıdır. `extractFacts`'in aldığı knownNodes
argümanı bir spy/capture mekanizmasıyla kaydedilir; bu kayıt testin tüm
assertion'larının temelidir.

### 5.3 Assertions

```text
1. default node knownNodes içinde mevcut
2. tenant-a node knownNodes içinde mevcut değil
3. kernel.graph.getNodes('default') çağrılmış
4. raw _nodes okunmamış (access spy count = 0)
5. tenant-a node'u extraction sonucunu etkileyemiyor
   (default-only knownNodes ile üretilen fact'ler,
    tenant-a identifier'ına referans içermiyor)
```

Assertion 5, daraltmanın **kapsamını** ölçer: yalnızca "tenant-a listede
yok" değil, "tenant-a extraction'a etki edemiyor". Bu, daraltmanın
neden işe yaradığını gösterir; "daraltma yapıldı"nın ötesine geçer.

### 5.4 Mutation guard

Aşağıdaki **üç mutation'ın tümü** testi **FAIL** etmek zorundadır:

```text
Helper yeniden raw _nodes kullanırsa → RED (zorunlu)
getNodes('tenant-a') kullanırsa → RED (zorunlu)
Workspace filtresi kaldırılırsa → RED (zorunlu)
```

Üçünün tümü RED olmak zorundadır; "en az ikisi" yeterli değildir. Her
mutation characterization testinin ayrı bir senaryosunu çalıştırır ve
üçü de yanlış implementation'ı ayrı ayrı kırmak zorundadır. Bu, characterization
testinin "negatif fixture" niteliğidir (Bölüm 4.2).

### 5.5 Legacy fallback — ayrı compatibility testi zorunlu

`getNodes` metodunun bulunmadığı eski test harness'ler için `kernel.graph?._nodes`
fallback kolu, tıpkı `contradiction-alert` (PR #83), `devil-advocate`
(PR #81), `discovery-engine` (PR #78), `idea-mri` (PR #79) migration'larında
olduğu gibi korunur. Bu fallback bir **compatibility contract**'tır ve
**ayrı bir compatibility testi** olmadan bırakılamaz.

Package 03 test seti en az şunları içermelidir:

```text
03A (queryCompanyBrain):
- public dynamic-workspace parity test
- legacy fallback branch proof (ayrı compatibility testi)

03B (ingestManual):
- public default-workspace narrowing characterization test (Bölüm 5.1–5.4)
- legacy fallback branch proof (ayrı compatibility testi)
- üç mutation guard (Bölüm 5.4 — üçü de RED zorunlu)
```

Legacy fallback compatibility testi **narrowing assertion'ına tabi değildir**;
 amacı yalnızca fallback branch'inin çalıştığını, doğru `_nodes` map'ini
okuduğunu ve managed-plugin compatibility'nin (AC-6) bozulmadığını
kanıtlamaktır. Bu test `getNodes` metodunun bulunmadığı legacy mock kernel
üzerinde çalışır; `accessLog` spy'ı fallback branch'inin `_nodes` okuduğunu
doğrular.

---

## 6. Q5 — `addCompanyEdge` Workspace Kararı

**Karar:** `addCompanyEdge` default-bound kalır. Package 03 kapsamında
workspace-aware ingest API **eklenmez**.

### 6.1 Gerekçe

- `plugins/company-brain.js:45-60` (`addCompanyEdge` fonksiyon aralığı;
  `:46-47` `proposeNode`, `:48-58` `proposeEdge`) — workspace argümanı
  geçmez.
- `kernel.proposeNode` / `kernel.proposeEdge` workspace verilmezse default'a
  düşer.
- Doğru koherans: **default-only write + default-only known-node read**.

Mevcut asimetri (default write + cross-workspace read) Bölüm 3.1'de
defekt olarak sınıflandırılmıştır. Bu amendment okuma tarafını daraltarak
koheransı restore eder. Yazma tarafına workspace routing eklemek bu
amendment'ın kapsamı **dışındadır**.

### 6.2 Gelecek contract ayrımı

Dynamic workspace ingest (yazma + okuma birlikte workspace-aware) ayrı bir
gelecek contract'ıdır. Bu contract;

- `addCompanyEdge`'in workspace argümanı alması,
- `proposeNode`/`proposeEdge`'e workspace geçirilmesi,
- `ingestManual`'ın `input.workspaceId` okuması,
- `getNodes(input.workspaceId || 'default')` ile okuma yapması

gerekçelerini birlikte içerir. Bu amendment bu contract'ı yetkilendirmez;
yalnızca daraltma contract'ını yetkilendirir. Gelecek contract yeni bir
amendment ile açılır.

---

## 7. Q6 — Package 03 Atomikliği

**Karar:** Package 03 atomik kalır. Amendment merge edildikten sonra bile
`queryCompanyBrain` tek başına uygulanmaz.

```text
03A queryCompanyBrain
+
03B ingestManual
=
tek Package 03
```

### 7.1 Schedule

Amendment merge sonrası Package 03 runtime implementation PR'ı aşağıdaki
sırayı takip eder:

```text
1. Amendment merge → yeni main SHA mühürleme
2. Package 03 runtime implementation PR açılır
3. 03A (queryCompanyBrain) ve 03B (ingestManual) aynı PR'da
4. Her use-case için ayrı test kanıtı (Bölüm 5 + 03A için parity testi)
5. Tek manifest hash güncellemesi (plugins/company-brain.manifest.json)
6. Full CI: npm test + Security + Benchmark
7. Bağımsız review → merge
```

Adım 4'te her use-case için **ayrı** test kanıtı verilir. 03A için mevcut
parity testi deseni (PR #81/#83'te kullanılan) uygulanır: public-path
`getNodes` çağrısı + legacy `_nodes` fallback + access spy. 03B için bu
amendment'ın Bölüm 5'inde tanımlanan characterization testi uygulanır.

Adım 5'te manifest hash yalnızca bir kez güncellenir; iki ayrı hash
güncellemesi yapılmaz. Bu, Bölüm 8'deki atomiklik gerekçesinin bir
yansımasıdır.

---

## 8. Q7 — Atomiklik Gerekçesi

Package 03'ün atomik kalmasının ana gerekçesi bilişsel kolaylık değildir;
**kaynak ve contract bütünlüğüdür**. Aşağıdaki beş ortak yüzey, iki
use-case'in tek PR'da bir arada değerlendirilmesini zorunlu kılar:

```text
same plugin (company-brain)
same private surface (graph._nodes)
same source file (plugins/company-brain.js)
same manifest hash (plugins/company-brain.manifest.json)
same compatibility review
```

### 8.1 Bölünmenin yol açacağı sorunlar

İki use-case'i bölmek aşağıdaki sorunları yaratır:

- Aynı plugin dosyası iki kez art arda değiştirilir → review bütünlüğü bozulur.
- Aynı manifest hash iki kez yeniden hesaplanır → iki ayrı
  compatibility/CI döngüsüne neden olur; bu gereksiz churn'dür. Her PR
  kendi hash'ini doğru hesaplasa bile, iki ayrı PR iki ayrı doğrulama
  yükü ve iki ayrı intermediate state yaratır.
- Geçici mixed public/private state oluşur: 03A migrate edildiğinde
  `queryCompanyBrain` public API kullanırken `ingestManual` hâlâ raw
  `_nodes` okur. Bu intermediate state Bölüm 3'teki sınıflandırmayı
  belirsizleştirir.
- Package 03 closeout'u (Builder 02-08A scope'unun tamamlanması) belirsizleşir:
  03A merge edilmiş 03B bekliyor durumunda "Package 03 tamamlandı" hükmü
  verilemez.

### 8.2 Bilişsel kolaylık ikincildir

Review kolaylığı, atomikliğin gerekçesi olarak yazılmamıştır. Yeterli
gerekçe kaynak/contract bütünlüğüdür. Bölüm 8.1'deki teknik sorunlar
 olmadan bile, iki use-case'in aynı plugin ve aynı private surface'ı
paylaşması atomiklik için yeterlidir.

---

## 9. Q8 — Precedent ve Case-Specific Authorization

Bu amendment iki katmanlıdır: genel precedent ve case-specific authorization.

### 9.1 Genel precedent — AC-5.3a koşulları

AC-5.3a, gelecekteki isolation narrowing durumlarında kullanılabilir. Ancak
yalnızca aşağıdaki **sekiz koşulun tümü** sağlandığında:

1. Mevcut davranış source audit ile kanıtlanmış olmalı. (Source-reality
   referansı file:satır formatında verilmeli.)
2. Davranışın public/binding contract olmadığı kanıtlanmalı. (Belgelenmiş
   bir sözleşme, comment veya test bu davranışı "intentional" olarak
   kaydetmemiş olmalı.)
3. Narrowing güvenlik veya tenant/workspace izolasyonunu güçlendirmeli.
   (Sadece "kod temizliği" yeterli gerekçe değildir.)
4. Yeni geniş public API açılmamalı. (Workspace filtresiz varyant, yeni
   `getAllNodes` benzeri seam açılamaz.)
5. Değişimin kapsamı characterization testiyle ölçülmeli. (Bölüm 5'teki
   tarzda fixture + assertions.)
6. Negative fixture/mutation yanlış implementation'ı kırmalı. (Bölüm 5.4'teki
   üç mutation'ın üçü de RED olmak zorundadır; "en az ikisi" yeterli değildir.)
7. İnsan onayı bulunmalı. (Amendment PR'ı bağımsız review ile merge
   edilmeli; builder kendi başına yetki veremez.)
8. PR açıklamasında "parity" değil "intentional narrowing" denmeli. (Test
   adlarında da "parity" kullanılmaz; Bölüm 4.3.)

Sekiz koşuldan biri bile eksikse AC-5.3a uygulanamaz; normal AC-5.3 parity
şartı bağlayıcı kalır.

### 9.2 Case-specific authorization

Bu amendment yalnızca aşağıdaki runtime değişikliğini yetkilendirir:

```text
company-brain / ingestManual:
kernel.graph._nodes
→ kernel.graph.getNodes('default')
```

Diğer consumer'lar otomatik olarak yetkilendirilmiş sayılmaz. Aşağıdaki
durumlar bu amendment'ın kapsamı **dışındadır**:

- `company-brain` / `queryCompanyBrain` — Bölüm 4.2.1 BINDING contract'ı
  çerçevesinde normal AC-5.3 parity'sine tabidir (dinamik workspace
  korunur). Bu amendment'la bağlantısı yoktur.
- `_companyIngestState` migration'ları (Package 04/05) — farklı private
  surface, bu amendment'ın kapsamı dışında.
- `_parsePredicate` migration'ları (Package 06/07) — farklı private
  surface, bu amendment'ın kapsamı dışında.
- `addCompanyEdge` workspace routing — Bölüm 6.2'de gelecek contract olarak
  işaretlenmiştir; bu amendment yetkilendirmez.

### 9.3 Bu amendment'ın sürekliliği

Bu amendment merge edildikten sonra `ingestManual` use-case'inin
contract'ı binding hale gelir. Yeni bir amendment olmadan contract değiştirilemez.
Özellikle, gelecekte dynamic workspace ingest contract'ı açılmak istenirse
(Bölüm 6.2), bu amendment'ı değiştiren ayrı bir amendment gerekir;
mevcut daraltma contract'ı kendiliğinden genişlemez.

---

## 10. Runtime Authority ve Sonraki Adımlar

### 10.1 Runtime authority

Bu amendment PR'ı merge edilene kadar Package 03 runtime implementasyonu
için **yetki verilmez**. Aşağıdaki koşulların tümü sağlanana kadar runtime
implementation branch'i açılmaz:

```text
1. Bu amendment PR'ı bağımsız review ile APPROVED_FOR_MERGE
2. Merge uygulanır (normal merge)
3. Yeni canonical main SHA mühürlenir
4. Builder 02-08A workspace yeni main'e fast-forward eder
5. Yeni tree SHA kayda geçirilir
```

Adım 5 sonrası Package 03 runtime implementation branch'i açılabilir.

### 10.2 Sonraki gate sırası

```text
1. [TAMAM] PR #84 merge — Package 03 contract correction (d3f4221e)
2. [BU PR] Acceptance amendment docs-only PR
3. [SONRAKİ] Bağımsız review (APPROVED_FOR_MERGE beklenir)
4. [SONRAKİ] Merge + yeni main SHA mühürleme
5. [SONRAKİ] Package 03 runtime implementation PR (03A + 03B atomik)
6. [SONRAKİ] 03A için parity testi + 03B için characterization testi
7. [SONRAKİ] Tek manifest hash güncellemesi
8. [SONRAKİ] Full CI: npm test + Security + Benchmark
9. [SONRAKİ] Bağımsız review → merge
10. [SONRAKİ] Package 04 (repo-memory / _companyIngestState)
```

Adım 2'nin output'u bu PR'dır. Adım 3 builder'ı bağlar; builder kendi
amendment PR'ını merge edemez.

---

## 11. References

- `docs/refactor/decision-4d-graph-workspace-contract.md` — Bölüm 4.2.2
  (ingestManual source-reality + call-site audit), Bölüm 4.3 (matris),
  Bölüm 6 (call-site audit detail)
- `docs/refactor/refactor-4d-contract-acceptance.md` — AC-5.3 (parity
  şartı), AC-5.1 (single-consumer granülarite), AC-5.5 (private surface
  envanteri)
- `plugins/company-brain.js:45-60` — `addCompanyEdge` fonksiyon aralığı
  (`:46-47` `proposeNode`, `:48-58` `proposeEdge`) — default workspace
- `plugins/company-brain.js:178-233` — `queryCompanyBrain` (dinamik
  workspace, Bölüm 4.2.1 contract)
- `plugins/company-brain.js:235-300` — `ingestManual` fonksiyon aralığı;
  `input.*` okunan alanlar (`:236`, `:239`, `:240`, `:256`, `:264`, `:274`, `:288`)
- `plugins/company-brain.js:245-247` — `ingestManual` raw `_nodes` erişimi
- `graph.js:617-626` — `Graph.getNodes(workspaceId)` public API
- `graph.js:620` — `Object.entries(this._nodes)` workspace filtresiz gezim
- `graph.js:37-40` — `normalizeWorkspaceId` (yalnız `.trim()`)
- `graph.js:42-44` — `nodeStorageKey` (storage key formatı)
- PR #82 — Tour 2: workspace contract consumer/use-case matrisine
  indirgendi; `OBSERVABLE_OUTPUT_LEAK_NOT_REPRODUCED` kaydı yalnızca
  `devil-advocate`/`discovery-engine`/`idea-mri` workspace kontratı
  bağlamında, test edilen identifier şekilleri için verilmiştir
  (`ingestManual` için dayanak olarak kullanılamaz; bkz. Bölüm 3.3)
- PR #83 — `contradiction-alert` migration (gerçek parity örneği; daraltma
  değil, çünkü `getEdges(subject)` zaten default'a düşüyordu)
- PR #84 — `ingestManual` contract correction, Package 03 BLOCKED hükmü
