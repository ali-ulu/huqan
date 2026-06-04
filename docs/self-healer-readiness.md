# AXIOM Self-Healer — Readiness & Design

> **Status:** Design / Readiness only. No runtime code is introduced in this PR.
> **Target phase:** Phase 0 (design contract) of the Self-Healer workstream.
> **Authority:** `AGENTS.md` §1, §3, §4, §7, §8, §9 are binding for every later
> phase. This document does not override them — it constrains how they apply
> once Self-Healer work begins.

## 1. Purpose

AXIOM'un Self-Healer katmani, kendi repo, test ve log yuzeylerini okuyup
**finding + fix plan + draft patch** uretebilen, ancak hicbir zaman kendi
kendine **merge**, **push** ya da **kanonik hafiza mutasyonu** yapmayan
yardimci bir agentic dongudur. Amac bug'un kendisini otomatik cozmek degil,
insan reviewer'in onune **kanitlanabilir, geri alinabilir ve dar kapsamli**
bir taslak koymaktir.

Tek cumle sinir invariant'i (kanonik):

> AXIOM kendi repo/test/loglarini tarayip finding + fix plan + draft patch
> uretebilir; ama auto-merge, auto-push, canonical memory mutation yapamaz.

Bu dokuman, Phase 0'in sozlesmesidir. Implementasyon ayri PR'larda, ayri
fazlarda, her seferinde ayri onay ile yapilacaktir.

## 2. Allowed Loop (izinli dongu)

Self-Healer'in **yapabilecegi** adimlar:

1. `lib/**`, `kernel.js`, `kernel.v2.js`, `test/**`, `server.js`,
   `requestGuards.js`, `public/**`, `docs/**` dosyalarini **salt okunur**
   olarak taramak.
2. Mevcut test sonuclarini (gecen / kalan / atlanan) okumak ve
   `docs/SECURITY-GATE.md`, `docs/PR_CHECKLIST.md` ile karsilastirmak.
3. Yapilandirilmis bir `SelfHealerFinding` listesi uretmek.
4. Her finding icin `FixPlan` (risk, geri alma, eklenmesi gereken testler)
   taslagi hazirlamak.
5. Planlanan fix'i **ayri bir feature branch** uzerinde `PatchDraft` olarak
   uretmek (yalnizca izole branch'te, main'de degil).
6. PR aciklamasini `docs/templates/auto-pr-receipt.md` formatinda
   doldurmak.
7. Butun ciktiyi insan review'ina birakarak **durma noktasina** gelmek.

Dongunun **her** adiminda `requiresHumanApproval: true` ve
`reviewStatus: "pending_human_review"` sabit kalir.

## 3. Forbidden Loop (yasakli dongu)

Self-Healer'in **asla** yapamayacagi uc temel hareket:

1. **Auto-merge:** Hangi confidence seviyesinde olursa olsun, PR'i main'e
   merge etmek.
2. **Auto-push:** Izole feature branch disinda, dogrudan `main` veya
   korumali baska bir branch'e push yapmak.
3. **Canonical memory mutation:** Memory Core'a (kanonik graph, audit log,
   provenance, trust policy) **insan onayi olmadan** yeni kayit yazmak,
   patch etmek, tombstone olusturmak, supersede etmek.

Bu uc yasak, **tum implementasyon fazlarinda** (Phase 1-5) ve **her durumda**
gecerlidir. Hiçbir faz, hiçbir heuristic, hicbir "guvenli gorunuyor"
exception bu yasagi acamaz.

Bunlarin otesinde, AGENTS.md §4 zaten yasak olan genis kapsamli git
islemlerinin (ornek: `git add .`, `git add -A`, `git commit -am`,
`--force` push, `git clean -fd`, `rm -rf`, `Remove-Item -Recurse`,
`taskkill`) Self-Healer tarafindan **otomatik olarak** cagrilmasina da
ayrica izin verilmez.

## 4. Core Data Contracts

Self-Healer'in urettigi ve tukettigi dort temel shape. Hicbir alan
`null` baslamadan operasyonel truth haline gelmez; zimnen "insan
onayindan gecmemis taslak" anlamina gelir.

```js
SelfHealerFinding {
  findingId: string,         // Self-Healer urettigi, izlenebilir kimlik
  source: string,            // "scan:tests" | "scan:security-gate" | "scan:drift" | ...
  severity: "low" | "medium" | "high" | "critical",
  category: string,          // "concurrency" | "trust-boundary" | "fs-safety" | ...
  title: string,
  evidence: string[],        // dosya: satir referanslari, log satirlari, hata mesajlari
  affectedFiles: string[],   // gorunuzde etkilenen dosyalar
  reproduction: string,      // nasil yeniden uretilir
  confidence: number,        // 0.00 - 1.00 araliginda, sadece referans
  status: "open",
  proposedFix: null          // <-- her zaman null ile baslar
}

FixPlan {
  findingId: string,         // SelfHealerFinding.findingId ile eslesir
  summary: string,
  filesToChange: string[],   // dar kapsam; sadece gerekli dosyalar
  testsToAdd: string[],      // eklenmesi planlanan test adlari (henuz yazilmamis)
  riskLevel: "low" | "medium" | "high",
  rollbackPlan: string,      // "git revert <sha>" ya da daha dar bir geri alma senaryosu
  requiresHumanApproval: true,   // <-- sabit
  patchDraft: null           // <-- her zaman null ile baslar
}

PatchDraft {
  branchName: string,        // "docs/self-healer-readiness-design" stili dar feature branch
  baseCommit: string,        // branch'in ciktigi commit
  diffSummary: string,       // dosya + satir araligi + ne degisti
  changedFiles: string[],    // sadece izin verilen dosyalar
  testCommand: string,       // ornek: "node --test test/memory-store.test.js"
  testResult: null,          // <-- her zaman null ile baslar
  reviewStatus: "pending_human_review"   // <-- sabit
}

SelfHealerMemoryEvent {
  eventType: "finding_recorded" | "fix_approved" | "fix_rejected" | "recurrence_seen",
  findingId: string,
  fixCommit: string | null,
  approvedBy: string | null, // insan reviewer
  mergedAt: string | null,
  lesson: string,            // sadece fix merge edildikten sonra yazilir
  recurrencePattern: string | null,
  workspaceId: string,
  provenanceId: string       // mevcut Memory Core provenance semasi ile uyumlu
}
```

Invariant: `proposedFix`, `patchDraft`, `testResult`, `requiresHumanApproval`,
`reviewStatus` alanlari **hicbir fazda** otomatik olarak `null`'dan /
`true`'dan / `"pending_human_review"`'ten baska bir degere **self-healer**
tarafindan tasinamaz. Insan review'i zorunlu koprudur.

## 5. Safety Invariants (zorunlu)

Bu 11 invariant, Self-Healer implementasyonunun her fazinda **birinci
oncelikli** test hedefidir. Invariant ihlal eden kod merge adayi degildir.

1. **No auto-merge.** Self-Healer hicbir kosulda PR'i main'e merge etmez.
2. **No auto-push.** Self-Healer main veya korumali branch'e push yapmaz.
3. **No direct main writes.** Self-Healer main uzerinde dosya olusturmaz,
   duzenlemez, silmez veya stage'lemez.
4. **No broad `git add .` / `git add -A`.** AGENTS.md §4 ile ayni hizada;
   sadece `git add <belirli-dosya>` kullanilir (tercihen kod uretmemeli,
   en fazindan taslak patch dosyalarini).
5. **No broad delete.** `git clean -fd`, `rm -rf`, `Remove-Item -Recurse`
   Self-Healer tarafindan cagrilmaz.
6. **No memory promotion without review.** Memory Core'a yeni audit /
   provenance kaydi, ancak insan tarafindan onaylanan fix merge edildikten
   sonra yazilir.
7. **No canonical graph mutation without review.** Tombstone, supersede,
   patchMetadata gibi operasyonlar ancak insan onayindan sonra
   uygulanabilir; Self-Healer yalnizca "plan" uretebilir.
8. **Failed tests block recommendation.** Eger `npm test` (ya da targeted
   subset) kalan test varsa, Self-Healer o finding'i **fix-ready** olarak
   isaretleyemez.
9. **Security finding blocks merge.** `docs/SECURITY-GATE.md` kategorilerinden
   herhangi birinde acik kalan finding varsa, PR merge adayi degildir.
10. **Every finding must cite evidence.** `evidence` alani bos olamaz;
    dosya: satir, log satiri, ya da hata mesaji zorunludur.
11. **Every patch must have rollback plan.** `FixPlan.rollbackPlan` bos
    olamaz. "Yok" bir geri alma plani degildir; en azindan "git revert
    <sha>" cumlesi olmali.

Bu invariantlar runtime tarafta **davranissal** testlerle (yani Self-Healer
implementasyonu bunlari ihlal etmeye calisan testlerle) kontrol edilir.
Invarianti zorlamayan bir implementasyon, merge'e giremez.

## 6. Memory Core Relation

Self-Healer, AXIOM'un Memory Core'unu iki rolde kullanir:

- **Memory (hafiza) olarak:** Onceden gormus, merge edilmis ve insan
  tarafindan onaylanmis fix'lerin derslerini saklamak. Bu dersler ancak
  **merge edilen fix** ile birlikte `SelfHealerMemoryEvent` olarak
  yazilir.
- **Audit trail (denetim izi) olarak:** Tum `SelfHealerFinding` ve
  `FixPlan` kayitlari, merge edilmemis / reddedilmis olsalar bile,
  denetim amaciyla `workspaceId` altinda tutulur. Bu kayitlar
  "operasyonel truth" degildir; sadece "ne zaman ne teklif edildi?"
  sorusuna cevap verir.

Self-Healer, Memory Core'a **kanonik otorite** olarak degil, sadece
**zaman icinde ogrenilen yardimci veri tabani** olarak yazar. Aksi
belirtilmedikce:

- `SelfHealerFinding.proposedFix: null` iken, finding Memory Core'da
  sadece **olay kaydi** olarak gorunur; **cozum** olarak degil.
- `SelfHealerMemoryEvent.lesson` alani ancak `fixCommit != null` oldugunda
  doldurulur.
- Reddedilen fix'lerin recurrencePattern'i sonraki finding'lerde
  "bu daha once teklif edildi, reddedildi" notu ile birlikte gorunur;
  ancak **cozum olarak kabul edilmez**.

## 7. Future Implementation Phases (Phase 0 - 5)

Self-Healer implementasyonu **alti faza** bolunur. Her faz ayri PR, ayri
feature branch, ayri review ve ayri `npm test` ile gelir. **Hicbir faz
auto-merge'e izin vermez;** her faz kendi ciktisini insan onayina birakarak
tamamlanir.

| Faz | Ad | Cikti | Onay kapisi |
|-----|----|-------|-------------|
| 0 | **Design (bu dokuman)** | `docs/self-healer-readiness.md` | "Bu sozlesme dogru mu?" |
| 1 | Read-only scanner | `SelfHealerFinding` listesi (ureten tool) | "Olusan finding listesi dogru mu?" |
| 2 | Fix plan generator | `FixPlan` listesi (ureten tool) | "Plan gercekten dar mi, rollback var mi?" |
| 3 | Draft patch branch generator | Izole feature branch + `PatchDraft` (uretir) | "Diff yalnizca gerekli dosyalari kapsiyor mu?" |
| 4 | GitHub PR draft integration | `docs/templates/auto-pr-receipt.md` formatinda PR aciklamasi | "Trust Receipt eksiksiz mi? Auto-merge: DISABLED mi?" |
| 5 | Recurrence learning | Memory Core'a `SelfHealerMemoryEvent` (sadece merge sonrasi) | "Ders gercekten onaylanmis bir fix'ten mi geldi?" |

**Hard kural:** Faz 1'den once hicbir runtime kodu merge'e girmez. Faz
1-4 salt okunur / izole uretim yapar; kanonik graph'a yalnizca Faz 5,
**onaylanmis merge edilmis fix** uzerinden yazar.

## 8. OpenCode / Codex Workflow

Self-Healer ile ilgili butun PR'lar, AXIOM genelindeki rol ayrimina
uyan bir is akisindan gecer:

- **ChatGPT (architect):** Yeni faz icin gereksinim, ADR ve task
  listesi yazar. Bu dokuman (Phase 0) bu rolden gelen sozlesmedir.
- **OpenCode (implementer):** Faz 1-4 implementasyonunu yapar, izole
  branch acar, `git add <belirli-dosya>` ile stage'ler, `npm test`
  calistirir, final report'u (AGENTS.md §10) uretir.
- **Codex (reviewer / security gate):** Diff'i okur, `docs/SECURITY-GATE.md`
  + `docs/PR_CHECKLIST.md` + bu dokumandaki 11 invariant'a gore degerlendirir.
  `docs/templates/auto-pr-receipt.md` formatinin eksiksizligini kontrol eder.
- **Human (final approver):** Trust Receipt + Codex review notu uzerinden
  karar verir. `Auto-merge: DISABLED` olan bir PR'i merge eder ya da reddeder.

Akis:
1. ChatGPT yeni faz icin ADR/task yazar, onay ister.
2. OpenCode dar feature branch acar (AGENTS.md §3) ve implementasyonu
   yalnizca izinli dosyalarla sinirli tutar.
3. OpenCode `npm test` + targeted subset calistirir, AGENTS.md §10'a
   gore 10 maddelik final report uretir.
4. Codex review eder; security gate aciksa merge yok.
5. Human onaylar, OpenCode push + merge yapar (ayri onayli adimlar).

Self-Healer, OpenCode/Codex/Human dongusune **dahil olmaz**. Self-Healer
ancak "finding + fix plan + draft patch" uretebilir; review ve karar
asla ona ait degildir.

## 9. Minimal Acceptance Criteria

Ilk implementasyon PR'i (Phase 1 — read-only scanner) merge adayi sayilmak
icin asagidaki kosullari karsilamalidir:

- [ ] Izole feature branch (AGENTS.md §3), main'e dogrudan yazma yok.
- [ ] Scanner **salt okunur** modda calisiyor; dosya sistemine yazma
      yok, Memory Core'a yazma yok, git islemi yok.
- [ ] Uretilen finding'ler `SelfHealerFinding` shape'ine uyuyor (alanlar
      ve tipler).
- [ ] Her finding `evidence` alani dolu, `proposedFix: null`.
- [ ] Hedeflenen testler (`npm test` ve/veya targeted subset) yesil.
- [ ] `docs/SECURITY-GATE.md` acik kalan finding yok.
- [ ] `docs/PR_CHECKLIST.md` "Before merge" bolumu eksiksiz isaretli.
- [ ] AGENTS.md §10'a gore 10 maddelik final report PR description'da
      ve/veya PR yorumunda bulunuyor.
- [ ] `docs/templates/auto-pr-receipt.md` formatinda "Auto-merge: DISABLED"
      ve "Human Decision Required: YES" acikca yer aliyor.
- [ ] Bu dokumandaki 11 invariant'in tumu icin en az bir negatif test
      bulunuyor (yani scanner kasten ihlal etmeye calisildiginda duruyor).
- [ ] Commit mesaji scope disi dosya icermiyor; `git status --short` ve
      `git diff --stat` PR acilisinda temiz gorunuyor.

Bu kosullardan biri bile eksikse, Phase 1 merge adayi degildir. Faz 2+
ayni cerceveyi miras alir; her faz kendi minimal acceptance criteria
setini, Phase 0'da tanilanan bu temel cerceveye dokunmadan ek olarak
tanimlar.

## 10. Applicability Across V1 - V5

Self-Healer sadece mevcut v0.9.1 Memory Core durumu ile sinirli degildir.
Self-Healer, mevcut AXIOM repo icin read-only, review-gated bir muhendislik
yardimcisi olarak baslar; ama ayni guvenlik modeli ilerideki surumlerde
de gecerlidir. **Framework genel olacak; implementation her surumde
kucuk, scope-dar PR'larla ayri ayri acilacak.**

* **v1 / Causal Core:**
  * Causal invariant'larin korunup korunmadigini kontrol eder.
  * Traversal regression'larini tespit eder.
  * `MAX_DEPTH_EXCEEDED` ile `CYCLE_DETECTED` karisikligini yakalar.
  * Trust Receipt / causal trace tutarliligini dogrular.
* **v2 / Temporal ve Probabilistic extension'lar:**
  * Placeholder alanlarin backward compatibility'sini kontrol eder.
  * Stale receipt / `contextHash` sorunlarini tespit eder.
  * Temporal / probabilistic migration risklerini raporlar.
* **v3 / Causal Discovery:**
  * Discovery ciktilari "aday" olarak degerlendirilir, "kanit" degil.
  * Kanonik kabul oncesi provenance, audit ve review zorunludur.
* **v4 / Formal Verification:**
  * Proof artifact'larinin iddia edildigi yerde gercekten var oldugunu
    dogrular.
  * Eksik ya da stale `formalProof` metadata'sini raporlar.
  * Eksik proof **asla** proof basarisi sayilmaz.
* **v5 / Ecosystem ve Protocol:**
  * HTP / ATP uyumlulugunu kontrol eder.
  * Conformance drift'ini tespit eder.
  * TrustBench / badge ile ilgili iddialari dogrular.

Tum versiyonlarda invariant ayni kalir:

> Self-Healer tarayabilir, tespit edebilir, aciklayabilir ve taslak
> uretebilir. Self-Healer auto-merge, auto-push, kanonik graph mutasyonu,
> memory promotion ya da kendi finding'lerini "guvenilir truth" olarak
> isaretleme **yapamaz**; bunlarin hepsi insan onayina baglidir.

Bu, Self-Healer'i tek-surumluk bir utility degil, uzun vadeli bir muhendislik
kontrol dongusu yapar. Phase 0 bu dongunun sozlesmesidir; Faz 1-5 ve
V1-V5'in her bir surumu kendi scope-dar implementasyonunu ayri PR'lar
halinde, bu cerceveye dokunmadan ekler.

---

*Bu dokuman Phase 0'in sozlesmesidir. Implementasyon yok; sadece
gelecekteki implementasyonu sinirlayan ve koruyan cerceve.*
