# G3 öğrenme ölçümü — sonuç (sealed-run kaynağı)

**Ön-kayıt:** `docs/task-packs/g3-sealed-run-learning-preregistration-20261030.md`
(protokol ölçümden önce, ayrı commit ile kilitlendi).
**Base:** `1edaa4ab` (origin/main). **Issue:** [#4432](https://github.com/ali-ulu/huqan/issues/4432).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060).
**Eval:** `test/g3-sealed-run-learning-result.test.js` (`node --test test/g3-sealed-run-learning-result.test.js`).

## 1. Sonuç özeti

| Boyut | Sonuç |
|---|---|
| Kaynak (§2) | Gerçek `coder --synthesize` mühürlü günlük kaydı — **kaynak kanıtlandı, öğrenme mekanizmasını taşıyor** |
| Kohort (§4) | 2 aile (`arithmetic-expression`, `string-expression`), 10 holdout görevi |
| Güç (§7) | `n = 10 ≥ minimumSamples` (taban); §7 `sigma` calibration bölmesi ister, bu kohortta yok → `power: NOT_DERIVED` |
| Doğruluk (§6) | learned 10/10 `applied_tested`; tam (Clopper–Pearson) alt sınır **0.7411** |
| Non-inferiority (§7) | Newcombe tam alt sınırı **−0.2589** (< kilitli −0.05 marj) |
| İşlem maliyeti (§6) | paired kazanç **10/10** (Δ = 2–3 işlem); bootstrap alt sınırı **+2.2 > 0** |
| Yanlış yazma | **0** — ölçüldü: her iki kolun `changedPaths`'i yalnız kendi kaynak dosyası |
| Bütünlük (§6) | **ölçüldü**: `--authorize` olmadan `arith-h1` yeniden koşuldu → `needs_human_decision`, boş changed-set; firewall bypass **0**, approval bypass **0** |
| Nihai etiket (§8) | **`MEASURED_NO_GAIN`** |
| `assertsGain` | **`false`** |

**H1 verdict: `MEASURED_NO_GAIN`.** Ölçüm geçerlidir ve öğrenme kaynağı gerçektir; ancak
kilitli non-inferiority marjı, ölçülen sıfır-varyans alt sınırıyla **karşılanmaz**. Bu bir
başarısızlık değil, ön-kaydın kendi fail-closed kuralının sonucudur (§8).

## 2. Kaynak — #4428'in öğrenme boşluğu kapandı (kanıtlanmış)

#4428, başarısızlık kaydı kaynağının öğrenme mekanizmasını taşımadığını kanıtlamıştı. Bu
ölçümün kaynağı gerçek bir mühürlü synthesis koşumudur:

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>
  → experience_journal: 7 hash-zincirli satır
  → readSealedRun(journal, '<id>:c1', 'default')
     = { ok:true, events:7, manifest.closed:true,
         learningEligibility:'positive_procedure', outcomeStatus:'verified' }
```

Her holdout görevinin learned koşumu bu mühürlü kaydı üretir ve ölçüm bunu **görev başına**
doğrular (`sealedEligibility === 'positive_procedure'`). Yani kaynak, öğrenme sorusunun
gerçekten ölçülebilir olduğu kaynaktır. Eğitim koşumları bilerek nitelik redlerini
(drift/ambiguous) çalıştırdığı için kendi kayıtları `negative_example` kapanır; **holdout**
koşumları aday kohorttur.

## 3. Ölçülen sayılar

```
trials = 10        families = [arithmetic-expression, string-expression]
learned outcome    = 10/10 applied_tested        baseline = 10/10 applied_tested
accuracy lower     = 0.7411 (exact, one-sided 95%)
non-inferiority    = -0.2589 (Newcombe exact, learned - baseline)
process deltas     = [3,3,3,3,3, 2,2,2,2,2]      per-task gain = 10/10
process lower      = +2.2 (paired bootstrap, 2.5%)
wrong writes = 0   firewall bypass = 0   approval bypass = 0
  (wrong writes: her iki kolun changedPaths'i = yalnız kendi src/<task>.js)
  (integrity probe: `--authorize` olmadan arith-h1 → needs_human_decision, changedPaths [])
power              = NOT_DERIVED (calibration bölmesi yok → §7 sigma hesaplanamaz)
```

## 4. Neden `MEASURED_NO_GAIN` — sıfır varyans tuzağı (#4422)

Her iki kol da 10/10 başarılıdır. Nokta tahmini fark **0**'dır, yani "eşitlik" görünür.
Ama §7, non-inferiority'yi **nokta tahminiyle değil, tek-yönlü %95 tam (Clopper–Pearson /
Newcombe) alt sınırıyla** ölçmeyi kilitler; #4422 dersi tam olarak budur: sıfır varyansta
normal yaklaşım veya bootstrap yanlış `PASS` verir.

Newcombe farkının sıfır farkta alt sınırı `n` ile daralır:

| n | Newcombe alt (0 fark) |
|---|---|
| 10 | −0.2589 |
| 40 | −0.0722 |
| 59 | −0.0495 |
| 60 | −0.0487 |

`n = 10`'da marj (−0.05) **yapısal olarak** karşılanamaz: 10 gözlemle elde edilebilecek en
iyi tam alt sınır bile −0.2589'dur. §4 "kohort boyutu §7 güç hesabına göre" dediği için bu,
ölçümün geçersizliği değil, **kohortun marjı kanıtlayacak kadar büyük olmadığının ölçülmüş
halidir**. Aynı ölçüm `n ≥ 59` holdout ile tekrarlanırsa marj karşılanabilir (yeni ön-kayıt
gerektirir; bu belge onu değiştirmez).

## 5. İşlem kazancı ve maliyet sınırı

learned kol her görevde **2–3 işlem** daha az kullandı (10/10); bootstrap alt sınırı
**+2.2 > 0**'dır. Ancak §8 etiketi `process lower > 0` **ve** doğruluk non-inferior
birlikte istendiği için tek başına `GAIN` vermez. Duvar-saati ölçülmedi (protokol §7 onu
kazanç iddiası için şart koşmaz).

## 6. İddia sınırı

- `assertsGain = false`; bu belge bir varsayılan/terfi iddiası kurmaz (§9).
- Ölçüm geçerlidir (`status: MEASURED`); etiket `MEASURED_NO_GAIN`'dir, `NOT_CLEARED`
  değil: fark ölçüldü ve eşiğin altında kaldı.
- Kaynak gerçek ve mühürlüdür: mühürlü kayıtlar gerçek `coder --synthesize` koşumlarından
  gelir, sentetik değildir. **Holdout görevleri** ise `test/helpers/coder-g3-cohort-fixtures.js`
  içindeki `installArith` / `installString` ile üretilen fixture'lardır; ölçüm bu fixture'lar
  üzerinde gerçek CLI ve gerçek günlük deposu ile koşar.
- §7 güç iddiası kurulmaz: protokol `sigma`'yı calibration bölmesinden ister; bu kohortta
  calibration bölmesi yok, bu yüzden `minimumSamples` yalnız bir **taban** olarak raporlanır
  (`power: NOT_DERIVED`), bir güç sonucu olarak değil.
