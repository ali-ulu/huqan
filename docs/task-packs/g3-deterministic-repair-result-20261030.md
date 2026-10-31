# G3 deterministik onarım ölçümü — sonuç

**Ön-kayıt:** `docs/task-packs/g3-deterministic-repair-preregistration-20261030.md`
(protokol ölçümden önce, ayrı commit ile kilitlendi).
**Base:** `1edaa4ab` (origin/main). **Issue:** [#4433](https://github.com/ali-ulu/huqan/issues/4433).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060).
**Eval:** `test/g3-deterministic-repair-result.test.js` (`node --test test/g3-deterministic-repair-result.test.js`).

## 1. Sonuç özeti

| Boyut | Sonuç |
|---|---|
| Kaynak (§2) | Doğrulanmış başarısızlık kaydı → `produceTask` → deterministik `coder` |
| Kohort (§4) | 2 aile (`replace_text`, `rename_identifier`), 10 görev |
| Güç (§7) | `n = 10 ≥ minimumSamples` → `powerMet = true` |
| Onarım başarısı (§6) | 10/10 `outcome = applied`; tam (Clopper–Pearson) alt sınır **0.7411** |
| Kilitli eşik (§7) | 0.90 tam alt sınır |
| Yanlış yazma (§6) | **0** — her görevde yalnız beyan edilen dosya değişti |
| Anti-vaka (§4, §8) | 3/3 fail-closed (`NO_SUPPORTED_OPERATION`, `IDENTIFIER_PAIR_INVALID`, `FAILURE_NOT_VERIFIED`) |
| Bütünlük | firewall bypass **0**, approval bypass **0** |
| Nihai etiket (§8) | **`REPAIR_INSUFFICIENT`** |
| `assertsGain` | **`false`** |

**Verdict: `REPAIR_INSUFFICIENT`.** Deterministik onarım 10/10 doğru çalıştı ve hiçbir yanlış
yazma üretmedi; ancak kilitli 0.90 tam alt sınırı, ölçülen kohort boyutunda **yapısal olarak**
karşılanamaz (§4). Bu, ön-kaydın fail-closed kuralının sonucudur.

## 2. Kaynak — gerçek zincir (kanıtlanmış)

```
ErrorPrevention.recordFailure()  (verificationStatus:'verified')   lib/error-prevention
  → produceTask(failure)                                          lib/task-producer
     => { operation:{type:'replace_text'|'rename_identifier', path, find/replace | from/to}, files:{} }
  → coder <task.json> --authorize --root <feature-branch>         lib/cli-coder.js
     => { outcome:'applied' }   (yalnız beyan edilen dosya değişir)
```

Üretilen görevde `test` alanı yoktur ve `synthesis` alanı yoktur; bu **öğrenme değil
deterministik onarım**dır (#4428 bulgusu). Bu ölçüm öğrenme kolu kullanmaz (§0).

## 3. Ölçülen sayılar

```
trials = 10        families = [replace_text, rename_identifier]
outcome = 10/10 applied        repair lower = 0.7411 (exact, one-sided 95%)
wrong writes = 0   firewall bypass = 0   approval bypass = 0
anti-cases = 3/3 fail-closed
```

## 4. Neden `REPAIR_INSUFFICIENT` — eşiğin gerektirdiği örnek (ölçülmüş)

§7, 0.90 tam (Clopper–Pearson) alt sınırı kilitler. Kusursuz oranda (`n/n`) bu sınır
`0.05^(1/n)`'dir; dolayısıyla eşik **kendi gerekli örnek boyutunu** belirler:

| n | tam alt sınır (n/n) |
|---|---|
| 10 | 0.7411 |
| 29 | 0.9019 |
| 30 | 0.9050 |
| 59 | 0.9505 |

`n = 10`'da en iyi olası tam alt sınır 0.7411'dir; 0.90'a ulaşmak için `n ≥ 29` gerekir.
Ölçüm bunu `requiredTrialsForBound = 29` olarak raporlar. §4 "kohort boyutu §7 güç hesabına
göre" dediği için bu, onarımın yanlış olduğu değil, **kohortun eşiği kanıtlayacak kadar
büyük olmadığının ölçülmüş halidir**. Aynı ölçüm `n ≥ 29` ile tekrarlanırsa eşik
karşılanabilir (yeni ön-kayıt gerektirir; bu belge onu değiştirmez).

## 5. Anti-vakalar (fail-closed, kanıtlanmış)

| Anti-vaka | Beklenen | Ölçülen |
|---|---|---|
| Desteklenmeyen `operation` | görev üretilmez | `NEEDS_HUMAN_DECISION` / `NO_SUPPORTED_OPERATION`, `task == null` |
| Geçersiz `rename_identifier` çifti | görev üretilmez | `NEEDS_HUMAN_DECISION` / `IDENTIFIER_PAIR_INVALID`, `task == null` |
| Doğrulanmamış kayıt | hiç projeksiyon yok | `NEEDS_HUMAN_DECISION` / `FAILURE_NOT_VERIFIED`, `task == null` |

Hiçbir anti-vakada yazma olmaz; üretici yazma yolunun önünde durur ve güvenilmeyen kaydı
asla bir düzenlemeye çevirmez.

## 6. İddia sınırı

- `assertsGain = false`; bu belge bir varsayılan/terfi iddiası kurmaz (§9).
- Ölçüm geçerlidir (`status: MEASURED`); etiket `REPAIR_INSUFFICIENT`'tir.
- Öğrenme/process kazancı **ölçülmedi** (bu kaynak öğrenme taşımaz, #4428); öğrenme sorusu
  ayrı ölçümdür (`docs/task-packs/g3-sealed-run-learning-result-20261030.md`).
