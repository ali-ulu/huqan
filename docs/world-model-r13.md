# R13: sınırlı sembolik dünya modeli (I4, B5)

Dünya modeli üç seviyedir ve her seviye kendi yetki sınırını taşır:

| Seviye | Yüzey | Ne söyler | Ne söylemez |
|---|---|---|---|
| 0 | `CausalSimulator.simulateChange` | Graf üzerindeki nedensel zincir traversal'ı, `stoppedReason`, döngüler | Durum geçişi veya sonuç tahmini |
| 1 | `predictTransition` (R12) | Kontrollü bağımsız destekle öğrenilmiş tek adım | Çok adımlı sonuç |
| 2 | `rolloutPlan`, `comparePlans`, `explainPrediction` | Öğrenilmiş adımların sınırlı zinciri, planların karşılaştırması | Kalibre olasılık, yürütme izni |

```js
const { CausalRuntime } = require('huqan');
const { CausalSimulator } = require('huqan/causalSimulator');
const runtime = new CausalRuntime({ graph, journal, frameId, evaluatePolicy: existingReceiverPolicy });
const simulator = new CausalSimulator(graph, { causalRuntime: runtime });
const rollout = simulator.rolloutPlan({ preState, plan: [energize, unlock], desiredState: { door: true } });
const choice = simulator.comparePlans({ preState, desiredState: { door: true }, plans });
const why = simulator.explainPrediction(rollout);
```

Rollout her adımda önce receiver policy'yi, sonra Level 1 modelini sorar.
İlk policy reddi `REJECTED`, ilk desteklenmeyen adım `UNKNOWN` olur ve rollout
orada durur: `finalState` ve `goalReached` `null` kalır. Desteklenen önek
görünür kalır; boşluğun ötesi tahmin edilmez. Böylece gözlenmemiş bir sonuç
hedefe ulaşmış sayılamaz. İlk adımın pre-state'i `observed`, sonrakiler
`predicted` işaretlidir; ara durumlar gözlem değildir. Policy hatası veya eksik
policy fail-closed'dur. Plan en fazla sekiz adım, karşılaştırma en fazla on altı
plan ve rollout başına sınırlı öğrenilmiş işlem bütçesi taşır.

`comparePlans` en az iki plan ister. Her plan bir `disposition` ile döner:
`selected`, `feasible_not_selected`, `goal_not_reached`, `unknown`,
`policy_rejected`. Seçim, desteklenen ve hedefe ulaşan planlar arasında maliyet,
uzunluk ve deterministik anahtar sırasıyla yapılır. Hiçbiri yoksa sonuç
`UNKNOWN`'dır; en ucuz tahmin seçilmez. `supportFloor` en zayıf adımın bağımsız
destek sayısıdır, olasılık değildir.

Her sorgu `CausalRuntime.snapshot()` ile tek tutarlı okuma kullanır: bir
rollout'un bütün adımları aynı desteği görür. Sonradan kaydedilen
`withdrawSupport` bir sonraki sorguda etkili olur. Motor eylem yürütmez,
canonical graph kuralı yazmaz, yeni tablo veya migration açmaz; host yürütmeden
önce kendi güncel admission ve approval kapılarını uygular.

## B5 deneyi

```powershell
node --test test/symbolic-world-model.test.js test/symbolic-world-model-mutation.test.js test/cognitive-lab-world-model-experiment.test.js
$sourceSha = git rev-parse HEAD
huqan-causal-lab --benchmark B5 --source-commit $sourceSha --source-dirty false
```

Dünya `bounded-door-multistep-v1`'dir: `energize`, `unjam`, `unlock`, `release`
eğitilir; `force` policy tarafından engellenir; `reset` hiç eğitilmez, bu yüzden
içinden geçen her plan `UNKNOWN` kalmalıdır. Tasarım, eşikler, baseline'lar,
kill criteria, girdi üreticisi ve tasarım/girdi/çevre yasası digest'leri
ölçümden önce `067a3573` commit'inde donduruldu
(`fixtures/cognitive-lab/world-model-design.json`). Koşucu tasarım veya girdi
digest'i tutmazsa en fazla `INSUFFICIENT` döner; CLI çevre yasası digest'i
tutmazsa çalışmaz.

Tahmin tarafı, her vakanın probe planının final durumunu persistence
baseline'ına karşı ölçer; `UNKNOWN` sıfır puan alır. Planlama tarafı seçilen
planı çevrede yürütüp hedefe ulaşmayı modelsiz en ucuz izinli plan baseline'ına
karşı, maliyeti ise R12 tek adımlı `proposeActions` planlayıcısına karşı
karşılaştırır. Herhangi bir yanlış geçiş, yanlış başarı, güvensiz seçim,
tek adımlı planlayıcıya karşı maliyet gerilemesi veya görünmeyen
unknown/rejected alternatif split'i `REJECT` yapar.

Sonuç `fixtures/cognitive-lab/world-model-result.json`'dadır; holdout ve
transfer ikisi de `KEEP`: final-state doğruluğu 0.294'ten 0.85'e (alt sınır
+0.36), hedefe ulaşma 0.25'ten 1.0'a (alt sınır +0.56), tek adımlı planlayıcıya
göre ortalama maliyet 5'ten 3'e; yanlış geçiş, yanlış başarı ve güvensiz seçim
sıfır; `reset` planlarının hepsi `UNKNOWN` (oran 0.15). İlk ölçüm `01357267`
kaynağında aynı sonucu verdi; ardından Level 2 çağrısı katman kuralı için
`CausalRuntime`'a taşındı ve kayıtlı sonuç bu son kaynakla yeniden koşudur.

Sınırlar: sentetik, ayrık ve deterministik tek bir frame; sabit yedi planlık
kütüphane; transfer yalnız yeni nuisance değerleri ve kimlikler içerir, yeni
mekanizma içermez. Yanlış geçiş sıfır olduğu için kalibrasyon ölçülmedi
(`NOT_MEASURED`). Aday her plan için rollout yaptığından gerçek CPU/wall-time
eşitliği iddia edilmez; eşit olan dış çağrı ve token bütçesidir (sıfır). Alt
sınır sınırlı sentetik vaka skorudur, gerçek görev popülasyonu için güven
aralığı değildir. KEEP otomatik model, plan veya kural terfisi değildir.
