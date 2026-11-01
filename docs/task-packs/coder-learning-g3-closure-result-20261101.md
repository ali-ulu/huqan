# Coder öğrenme kazanımı — G3 kapanış boyutları sonucu (result)

**Ön-kayıt:** `docs/task-packs/coder-learning-g3-closure-preregistration-20261101.md`
(protokol ölçümden önce, ayrı commit ile kilitlendi).
**Base:** `70099e37` (origin/main). **Issue:** [#4470](https://github.com/ali-ulu/huqan/issues/4470).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Eval:** `test/g3-closure-dimensions-result.test.js` (`node --test test/g3-closure-dimensions-result.test.js`).
**Önceki:** #4462 (`GAIN`, N=70; doğruluk non-inferiority + işlem maliyeti), #4416 (güç + tekrarlı
CPU), #4380 (restart + eski-beceri).

## 1. Sonuç özeti

| Boyut | Sonuç |
|---|---|
| Kaynak (§2) | Gerçek `coder --synthesize` / `--adapt-memory` mühürlü günlük kaydı — 17/17 learned koşum `positive_procedure` |
| Kohort (§4) | 2 aile; holdout **N = 10** (aile başına 5), kalibrasyon 6, kayma 4, eski-beceri 2 |
| Güç (§6/§7) | `sigma` kalibrasyon diliminden **türetildi**; process `sigma 0.55` → gerekli 10 ≤ 10 → `powerMet = true` |
| Tekrarlı maliyet (§6) | R = 3 geçiş; **amortize** duvar-saati medyanı **−565 ms** (eğitim geri ödenmedi), CPU medyanı **+266 ms** |
| Bellek (§6) | tepe RSS dağılımı ölçüldü (medyan taban 128.6 MB / öğrenilmiş 128.2 MB); `rssMeasured = true` |
| Restart (§6) | hiç görülmemiş görev yeni süreçte `applied_tested`; eligibility defteri yeniden açılışta korundu |
| Dağılım kayması (§6) | 4/4 kaydırılmış görev `applied_tested` (aynı öğrenilmiş prosedür) |
| Eski-beceri (§6/§7) | 2/2 görev `applied_tested` ve `learnedProcesses <= baselineProcesses` (4→1, 3→1) |
| Bütünlük (§6) | `--authorize` olmadan `needs_human_decision`, firewall bypass **0**, approval bypass **0**, yanlış yazma **0** |
| İşlem kazancı (§6) | paired alt sınır **+2.2 > 0** |
| Nihai etiket (§8) | **`GAIN`** |
| `assertsGain` | **`false`** |

**Etiket `GAIN`.** Bu, G3'ün *eksik* boyutlarının hepsinin ölçüldüğü ve kilitli kapıların
hepsinin geçtiği anlamına gelir. **Dürüst uyarı:** amortize duvar-saati kazancı bu kohort
boyutunda **negatiftir** (−565 ms): 1 594 ms'lik eğitim yükü, 10 görevlik holdout'ta
(1 029 ms) geri ödenmez. §7 duvar-saatini **kapı değil** (yalnız raporlanır) olarak kilitledi
(#4462 ile aynı; #4380/#4416 dersi: işlem kazancı duvar-saati kazancı değildir), bu yüzden
etiket `GAIN` kalır. G3 kapısı **bu belgeyle tek başına kapanmaz** (§9): bileşim (composition)
boyutu bu işin kapsamı dışındadır ve ayrı bir ölçüm ister.

## 2. Kaynak — mühürlü gerçek koşum (#4462 ile aynı)

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>   lib/cli-coder.js
  -> experience_journal: hash-zincirli satırlar                            lib/experience/journal.js
  -> readSealedRun(journal, '<id>:c1', 'default')                          lib/experience/learning-intake.js
     => { ok:true, manifest.closed:true,
          learningEligibility:'positive_procedure', outcomeStatus:'verified' }
```

17/17 learned koşum (10 holdout + 4 kayma + 2 eski-beceri + 1 restart) `closed === true`,
`learningEligibility === 'positive_procedure'` ve
`outcomeStatus === 'verified'`. Kaynak gerçek CLI, gerçek günlük deposu ve gerçek mühürlü-okuma
dikişidir; hiçbir şey mock'lanmaz.

## 3. Ölçülen sayılar

**Güç (§6/§7)** — `sigma` kalibrasyon diliminden (6 görev), eşlenmiş farkların örnek standart
sapması; `requiredSample = max(10, ceil(((1.96+0.84)·sigma/MIN_EFFECT)^2))`:

| Metrik | `sigma` | `MIN_EFFECT` | `requiredSample` | holdout | `powerMet` |
|---|---|---|---|---|---|
| process | 0.55 | 1.0 | 10 | 10 | **true** |
| wallMs | ~35–39 | 100 | 10 | 10 | **true** |
| cpuMs | ~12–13 | 100 | 10 | 10 | **true** |
| rssBytes | ~0.45–1.2 MiB | 8 388 608 | 10 | 10 | **true** |

**Tekrarlı maliyet (§6, R = 3)** — her geçiş taze köklerde; duvar-saati **amortize** (eğitim
yükü holdout kazancından düşülür); CPU ve tepe RSS holdout-only:

| Geçiş | holdout duvar kazancı (ms) | eğitim (ms) | **amortize duvar (ms)** | CPU kazancı (ms) | taban RSS (MB) | öğrenilmiş RSS (MB) |
|---|---|---|---|---|---|---|
| 1 | +1 029 | 1 594 | **−565** | +266 | 129.0 | 128.2 |
| 2 | +990 | 1 576 | **−586** | +243 | 128.5 | 128.1 |
| 3 | +1 057 | 1 607 | **−550** | +290 | 128.6 | 128.3 |
| **medyan** | **+1 029** | **1 594** | **−565** | **+266** | **128.6** | **128.2** |

**Yorum:** işlem ve CPU kazancı gerçek ve tutarlı (işlem +2.2 alt sınır, CPU +266 ms medyan);
öğrenilmiş kolun tepe RSS'i tabandan biraz **düşük** (yeni arama yapmadığı için). Ancak
**amortize duvar-saati kazancı negatiftir**: tek seferlik ~1.6 sn eğitim, N=10 holdout'un
~1.0 sn'lik tasarrufunu karşılamaz. Bu, eğitimin çok sayıda göreve yayılmasıyla ödenir; bu
kohort boyutu bunu göstermez.

## 4. Restart, kayma, eski-beceri (§6)

- **Restart:** `arith-restart` (hiç görülmemiş) yeni bir süreçte `--adapt-memory` ile
  `applied_tested`; journal yeni bir süreçte yeniden açıldığında holdout koşumlarının
  `learningEligibility` değeri `positive_procedure` olarak korundu.
- **Dağılım kayması:** `arith-shift-1..2` (değerler ~1e6 sınırında) ve `string-shift-1..2`
  (uzun girdi, yoğun boşluk) — 4/4 `applied_tested`. **Sınır:** aynı ailenin öğrenilmiş
  prosedürü (`p % 2`, `trim().toLowerCase()`) bu aralıklara zaten genelleştiği için kayma
  testi görev başına 1 process'te geçti; bu bir "uyum sağlandı" kanıtıdır, zor bir OOD
  görevi değildir.
- **Eski-beceri:** `arith-prior-1` (4→1 process) ve `string-prior-1` (3→1 process), ikisi de
  `applied_tested`; öğrenme eski beceriyi bozmadı.

## 5. Bütünlük (§6)

- `--authorize` olmadan aynı CLI koşuldu → `needs_human_decision`; hedef dosya koşum öncesi
  içerikte kaldı; yazılan yok.
- `firewallBypass = 0`, `approvalBypass = 0`, `wrongWrites = 0` (her koşumun değişen kümesi
  tam olarak kendi kaynak dosyasına eşit, ölçüldü; yanlış yazma `REJECT` kapısıdır).
- Cohort'taki **17 learned koşumun tamamı** (10 holdout + 4 kayma + 2 eski-beceri + 1 restart)
  mühürlü pozitif prosedür olarak doğrulandı; hiçbir boyut mühürsüz bir koşuya dayanmaz.
- İşlem kazancı paired alt sınırı **+2.2 > 0** (seeded paired bootstrap, R50 sözleşmesi).

## 6. İddia sınırı ve bağlama (§9)

- Bu ölçüm G3'ün **eksik** boyutlarını kapatır: güç, tekrarlı CPU/bellek, eğitim-dahil
  amortize maliyet, restart, dağılım kayması, eski-beceri non-inferiority.
- **Bileşim (composition) boyutu bu işin kapsamı dışındadır.** G3 kapısı ("G3 bileşim,
  maliyet, değişen ortam, restart ve eski beceri ölçümleri kaynak SHA/manifest ile
  raporlandı") bu belgeyle **tek başına kapanmaz**; bileşim ayrı bir ölçüm ister.
- Eski-beceri doğruluk Newcombe alt sınırı bu n'de **yapısal olarak** kanıtlanamaz; §7 onu
  **ikincil** (raporlanır, kapı değil) olarak kilitledi. Kapı, #4380 ile aynı ölçü olan
  görev-başına non-inferiority'dir.
- Holdout/kalibrasyon/kayma/eski-beceri **görevleri** `test/helpers/coder-g3-cohort-fixtures.js`
  fixture'larıdır; kaynak gerçektir. Ölçüm bu fixture'lar üzerinde gerçek CLI ve gerçek günlük
  deposu ile koşar.
- `assertsGain = false`; bu belge bir varsayılan/terfi veya genel öğrenme-başarısı iddiası
  kurmaz.
- **Ön-kayıt düzeltmesi (eşik değil, tanım):** ön-kayıt §6'daki "eğitim yükü amortize toplama
  dahildir" ifadesi, duvar-saatinin holdout kazancından eğitimin **düşülmesi** anlamına
  geldiğini açıkça yazacak şekilde netleştirildi. Eşik, seed, budget veya ölçüm birimi
  değişmedi; yalnızca zaten kilitli olan tanım açık hâle getirildi.
- Ölçüm ~71 sn sürer (Windows'ta 90 sn per-file cap'ini aşabilir) ve `HEAVY_FILES`'a kaydedilir.
