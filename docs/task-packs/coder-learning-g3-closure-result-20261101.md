# Coder öğrenme kazanımı — G3 kapanış kapısı boyutları sonucu (result)

**Status:** `closeout`.
**Ön-kayıt:** `docs/task-packs/coder-learning-g3-closure-preregistration-20261101.md`
(protokol ölçümden önce, ayrı commit ile kilitlendi).
**Base:** `70099e37` (origin/main). **Issue:** [#4470](https://github.com/ali-ulu/huqan/issues/4470).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060).
**Eval:** `test/g3-closure-dimensions.test.js`
(`node --test test/g3-closure-dimensions.test.js`).
**Önceki:** #4449 → PR #4462 (N=70 mühürlü kohort, `GAIN`, doğruluk/process);
#4416 (güç + tekrarlı maliyet, 10 görevlik dilim, `MEASURED_NO_GAIN`);
#4380 (restart + eski beceri, 6 görevlik dilim).

## 1. Sonuç özeti

| Boyut | Sonuç | Verdict |
|---|---|---|
| Kaynak (§2) | Gerçek `coder --synthesize` mühürlü günlük kaydı, 10/10 holdout `positive_procedure` | **MEASURED** |
| Güç — process (birincil) | kalibrasyon `sigma≈0.58` → `requiredSample=10`, `holdoutSize=10` | **MEASURED** (bağlayıcı kapı geçildi) |
| Güç — wallMs | `sigma≈53.1` → `requiredSample=10` | rapor (bağlayıcı değil) |
| Güç — cpuMs | `sigma≈13.4` → `requiredSample=10` | rapor (bağlayıcı değil) |
| Güç — rssKb | `sigma≈28311` → `requiredSample=1499` | `powerMet=false` (dürüstçe rapor; kapı değil) |
| Tekrarlı duvar-saati (eğitim dahil, R=3) | **−649 / −613 / −592 ms**, 3/3 aynı işaret | **MEASURED_NO_GAIN** |
| Tekrarlı CPU (eğitim dahil, R=3) | **−1314 / −1340 / −1218 ms**, 3/3 aynı işaret | **MEASURED_NO_GAIN** |
| Tekrarlı tepe-RSS (eğitim dahil, R=3) | **+614028 / +619680 / +623776 KB**, 3/3 aynı işaret | rapor (kazanç kapısı değil) |
| Restart (§6) | learned yeni same-family görevi dağıttı (4→1 process), defter yeniden açılışta korundu | **MEASURED** |
| Dağılım kayması (§6) | OOD görev 2/2 `applied_tested` (4→1, 3→1) | **MEASURED** |
| Eski beceri non-inferiority (§6) | 2/2 doğruluk eşit, process kötüleşmedi | **MEASURED** |
| Yanlış yazma / firewall / approval bypass | **0 / 0 / 0** (ölçüldü) | eşik tetiklenmedi |
| Nihai etiket (§8) | — | **`MEASURED_NO_GAIN`** |
| `assertsGain` | — | **`false`** |

**Sonuç:** G3 kapanış kapısının eksik boyutları **gerçek mühürlü kaynakta ölçüldü**. Öğrenme
mekanizması doğru çalışıyor (restart, dağılım kayması, eski beceri, process kazancı hepsi
geçti) ama **eğitim dahil amortize duvar-saati ve CPU kazancı negatif ve kararlı** → nihai
etiket `MEASURED_NO_GAIN`. Bu, #4449/#4462'nin `GAIN` sonucunu çürütmez: #4462 doğruluk
non-inferiority + **process** kazancını ölçtü ve `GAIN` verdi; bu ölçüm **eğitim dahil
duvar-saati/CPU** boyutunu ekler ve orada kazanç yoktur (#4380/#4416/#4449 ile aynı yön).

## 2. Kaynak — mühürlü gerçek synthesis koşumu (§2)

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>
  → experience_journal: 7 hash-zincirli satır
  → readSealedRun(journal, '<id>:c1', 'default')
     = { ok:true, manifest.closed:true,
         learningEligibility:'positive_procedure', outcomeStatus:'verified' }
```

Her holdout görevinin learned koşumu bu mühürlü kaydı üretir; ölçüm bunu görev başına
doğrular (10/10 `positive_procedure`). Bilinmeyen koşum `run_not_found` ile, düzenlenmiş kayıt
`integrity_mismatch` ile fail-closed reddedilir (§2 testi).

## 3. Ölçülen sayılar (temsili koşum, `t.diagnostic`)

```
holdoutSize = 10   families = [arithmetic-expression, string-expression]   repeats = 3
power.process = sigma 0.577 -> requiredSample 10, powerMet true
power.wallMs  = sigma 53.15 -> requiredSample 10
power.cpuMs   = sigma 13.37 -> requiredSample 10
power.rssKb   = sigma 28311 -> requiredSample 1499, powerMet false
wallGains = [-649, -613, -592]   signStable true
cpuGains  = [-1314, -1340, -1218] signStable true
rssGains  = [+614028, +619680, +623776] signStable true
restart   = { dispatch true, ledgerSurvived true, baseline 4, learned 1 }
shift     = 2/2 applied_tested
priorSkill= 2/2 applied_tested, nonInferior true (Newcombe alt -0.776, N=2 -> marginProvable false)
wrongWrites = 0   firewallBypass = 0   approvalBypass = 0
label = MEASURED_NO_GAIN   assertsGain = false
```

## 4. Neden `MEASURED_NO_GAIN`

Process kazancı güçlü ve deterministik (10/10 holdout, 4→1 / 3→1). Ancak **eğitim dahil**
amortize maliyet negatif: learned kol her holdout'ta daha az process kullansa da, eğitim
maliyeti (2 synthesis koşumu, ~1.63 s duvar-saati / ~1.54 s CPU / ~0.58 GB RSS) bu kazancı
aşar. Üç tekrarda da işaret aynı (kararlı), yani bu bir gürültü artefaktı değil, sabit CLI
başına maliyetin baskınlığıdır — #4380/#4416/#4449 ile tutarlı.

## 5. İddia sınırı

- `assertsGain = false`; bu belge bir varsayılan/terfi iddiası kurmaz (§9). Varsayılan terfi
  ayrı PR ve G3 kabulü sonrasıdır.
- Ölçüm geçerlidir (`status: MEASURED`); etiket `MEASURED_NO_GAIN`'dir. `GAIN` bu kohortta
  çıkmadı; çıksaydı da **bu iki aile ve bu görev kümesi** için olurdu, genel öğrenme başarısı
  iddiası çıkarılmaz.
- **Kapsam:** N=70 doğruluk non-inferiority kanıtı #4462'dedir ve burada **tekrarlanmadı**;
  bu ölçüm G3 kapısının eksik boyutlarını (güç, tekrarlı CPU/RSS, restart, dağılım kayması,
  eski beceri) ekler.
- **Kaynak** gerçek ve mühürlüdür; **holdout görevleri** `test/helpers/coder-g3-cohort-fixtures.js`
  fixture'larıdır. Ölçüm bu fixture'lar üzerinde gerçek CLI ve gerçek günlük deposu ile koşar.
- **RSS kapısı kurulmadı:** toplam tepe-RSS gürültülü bir toplu metrik; `rssKb.powerMet` bu
  kohortta `false` ve dürüstçe raporlanır. RSS dağılımı rapor, kazanç kapısı değildir.
- **Güç:** bağlayıcı sufficiency kapısı birincil (deterministik) metrik olan process'tir
  (#4416 örneği); duvar-saati/CPU/RSS güç sonuçları raporlanır.
- Bu ölçüm bir CI testidir (~81 gerçek alt süreç, yerel ~64 s); bu yüzden
  `scripts/heavy-test-files.js` içinde ağır dosya olarak kayıtlıdır.
