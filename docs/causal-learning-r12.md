# R12: sınırlı nedensel öğrenme

`CausalRuntime` doğrulanmış ExperienceJournal sonuçlarından tek adımlı,
ayrık state transition modelleri çıkarır. `CausalSimulator` eski graph traversal
davranışını korur; öğrenilmiş işlemler yalnız açıkça verilen runtime üzerinden
`predictTransition`, `proposeActions` ve `explainFailure` ile çağrılır.

```js
const { CausalRuntime } = require('huqan');
const { CausalSimulator } = require('huqan/causalSimulator');
const runtime = new CausalRuntime({
  graph, journal, workspaceId: 'default', frameId,
  evaluatePolicy: existingReceiverPolicy,
});
const simulator = new CausalSimulator(graph, { causalRuntime: runtime });
runtime.observeJournalEpisode({ runId, eventId });
const prediction = simulator.predictTransition({ preState, action });
const choices = simulator.proposeActions({ preState, desiredState, actions });
```

Host gerçek executor/verifier sonucunu journal'a `verification` olayı olarak
yazar: `executionStatus: completed`, `outcomeStatus: verified`, `attemptId` ve
`payload.causalEpisode`. Payload `frameId`, `preState`, `action`, `postState`,
`effect`, `observedAt`, `assignment` içerir. Assignment `kind`, `pairId`, `arm`,
`independenceKey` alanları taşır. State ve args en fazla sekiz sonlu scalar alan,
action ise `name`, `args`, `cost` içerir. Effect, gerçekten gözlenen değişimle
bire bir uyuşmalıdır; planlanan state veya eksik outcome kabul edilmez.

Kontrollü treatment/control aynı pre-state ve independence grubuna bağlıdır.
Control değişiyorsa, eşleşme eksik veya belirsizse pozitif öğrenme yapılmaz.
En az üç bağımsız çift gerekir; ortak kaynak grupları ve aynı run tekrarları
tek destek sayılır. Değişmeyen state boyutları koşul olarak korunur. Değişen
boyutlar üzerindeki genelleme sınırlı model hipotezidir. Zaman sırası veya
observational korelasyon pozitif causal destek olmaz; doğrulanmış karşı sonuç
modeli geçersiz kılabilir. Bu ilk sürüm değiştirilmiş bir control etkisinin
çıkarılmasını öğrenmez: fail-closed `UNKNOWN` döner.

Kaynak hashleri journal olayına ve workspace/frame'e bağlıdır. Episode ve
support withdrawal mevcut Graph mutation journal'ında idempotent saklanır;
yeniden açılışta modeller bu kayıtlardan türetilir. Yeni tablo, migration,
signer veya canonical graph rule yazımı yoktur. `withdrawSupport` ilgili
modelin desteğini kaldırır. Hash kaynağın değiştiğini yakalar; dış kaynağın
doğruluğunu veya bağımsızlığını kendiliğinden kanıtlamaz. Controlled assignment
ve independence grubu host'un deney kaydıdır, kriptografik dış doğrulama değildir.

Inverse yalnız mevcut receiver policy'sinin açıkça izin verdiği adayları
döndürür; reddedilen alternatifleri gerekçeleriyle korur. Policy hatası,
`unknown`, eksik policy ve işlem bütçesi aşımı fail-closed'dur. Motor eylem
yürütmez ve prediction bir approval makbuzu değildir. Host execution öncesi
kendi güncel admission ve approval kapılarını uygular. `confidence` bağımsız
destek sayısından türeyen support score'dur; kalibre edilmiş olasılık değildir.
Failure sonucu eksik koşul hipotezi üretir; hipotez `UNVERIFIED` kalır.

## İki dakikalık kontrol

```powershell
node --test test/learned-causal-engine.test.js test/causal-learning-mutation.test.js test/cognitive-lab-causal-experiment.test.js
huqan-causal-lab --help
```

Tam deney çağrısı:

```powershell
$sourceSha = git rev-parse HEAD
huqan-causal-lab --source-commit $sourceSha --source-dirty true
```

SHA ve dirty alanları caller-declared'dır; CLI dosyaların gerçek hashlerini
ayrıca raporlar. Temiz teslimde dirty `false` verilir. CLI yalnız kendine ait
geçici Graph kullanır; canonical hafızayı açmaz ve ağ/model çağrısı yapmaz.

İlk seed 3467 sonucu exploratory'dir: tam fixture/generator önceden
dondurulmamıştı ve source SHA deklarasyonu yanlıştı. Confirmatory seed 3468
tam input JSON, generator/environment hashleri ve değişmeyen eşiklerle
`57d00991` commit'inde ölçümden önce donduruldu. İlk confirmatory ölçümden sonra
pozitif-only context'teki değişmeyen boyutlar için fail-closed düzeltme yapıldı;
aynı sabit fixture ile tekrar koşu current-source reproducibility kanıtıdır.

B2 persistence baseline ile post-state doğruluğunu; B3 en ucuz policy-allowed
baseline ile hedefe ulaşma, maliyet ve unsafe rejection'ı karşılaştırır.
False-causal-rule metriği yanlış asserted effect oranıdır; canonical rule
terfisi yapılmadığı için graph kuralı terfi doğruluğu ölçülmez. Equal budget
prediction/action evaluation slotları ve sıfır external call/token içindir;
CPU ve wall-time eşitliği ölçülmez. Raporun lower bound değeri sınırlı sentetik
case score'dur; gerçek görev popülasyonuna ilişkin confidence interval değildir.
Transfer yeni nuisance değerleri/ID'ler içerir, yeni causal mekanizma içermez.
KEEP otomatik sürüm/model terfisi veya genel öğrenme kazanımı iddiası değildir.
