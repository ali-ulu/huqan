# AXIOM PR Trust Receipt Template

Bu template, `auto-pr.js` tarafindan olusturulan her PR DRAFT'inin
description'ina eklenir. Reviewer "neden bu fix onerildi?" diye sormak
yerine, butun baglami oneunde bulur.

## Format

```markdown
## AXIOM Auto-Fix DRAFT

### Problem (1-2 cumle)
<bug aciklamasi>

### Confidence
AXIOM Confidence: 0.60

### Evidence Trail
Based on:
- [fact_1]: kernel.graph concurrent mutation risk
- [fact_2]: verify() reads while learn() writes
- [fact_3]: no RwLock in current implementation

Contradicts:
- [none] | [fact_x]: aciklama

### Suggested Fix
```diff
- old code
+ new code
```

### Test Plan
- [x] Existing tests still pass
- [x] New test added: <test_name>
- [ ] Manual review required for: <area>

### Human Decision Required: YES
### Auto-merge: DISABLED
```

## Neden Bu Template

1. **Reviewer zaman kazanir** — Tum context PR description'da, comment'leri
   okumak zorunda degil.

2. **Trust chain** — AXIOM niye bu fix'i onerdi? Hangi fact'lere dayaniyor?
   Hangi bilgiyle celisiyor? Hepsini goruyor.

3. **Human gate garanti** — `Human Decision Required: YES` ve
   `Auto-merge: DISABLED` ile AI'in asla otomatik merge etmeyecegi netlesiyor.
   Insan her zaman son karar verici.

4. **Audit trail** — Gelecekte "bu fix neden yapildi?" sorusu olursa,
   PR description'da tam baglam var.

5. **Bug regresyonu tespiti** — Eger ayni bug tekrar ortaya cikarsa,
   onceki fix'in evidence trail'ine bakip "neden korunmamis?" analizi yapilabilir.

## Ornek

```markdown
## AXIOM Auto-Fix DRAFT

### Problem
kernel.learn() ile kernel.verify() ayni anda cagirildiginda graph
state'i tutarsiz okunabilir. Race condition var.

### Confidence
AXIOM Confidence: 0.85

### Evidence Trail
Based on:
- [op_graph_write] kernel modifies graph state (line 506)
- [op_graph_read] kernel reads from graph (line 723)
- [fn_learn] kernel.js contains learn function (line 351)
- [fn_verify] kernel.js contains verify function (line 1329)

Contradicts:
- [none]

### Suggested Fix
```diff
- async learn(text, opts = {}) {
-   // ... existing logic
- }
+ async learn(text, opts = {}) {
+   const release = await this._graphLock.writeLock();
+   try {
+     // ... existing logic
+   } finally {
+     release();
+   }
+ }
```

### Test Plan
- [x] Existing tests still pass (43/43 verified)
- [x] New test added: concurrent-race.test.js (RC-001..RC-006)
- [ ] Manual review required for: lock timeout edge cases

### Human Decision Required: YES
### Auto-merge: DISABLED
```

## CI/CD Entegrasyonu

PR acildiginda CI bot:
1. AXIOM'u PR head'iyle calistirir
2. Yeni bug tespit edilirse comment ekler
3. Existing test suite'i calistirir
4. Confidence < 0.70 ise extra reviewer ister

## Bilincli Sinirlamalar

- Bu template sadece AXIOM tarafindan uretilen PR'lar icin
- Insan tarafindan acilan PR'lar bu formati kullanmak zorunda degil
- Auto-merge KESINLIKLE devre disi — sadece bilgi, karar insanda
