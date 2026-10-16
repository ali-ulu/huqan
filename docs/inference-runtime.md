# Inference runtime (#3038)

Durum: CLI üzerinden çalışan, sınırlandırılmış inference ve outcome kalibrasyonu.
Otomatik canonical admission başarısı henüz üretim politikası altında kanıtlanmadı.

## Kullanım

CLI `inference <JSON>` komutunu kabul eder. JSON en fazla 256 KiB olabilir.
Programatik karşılığı `runInference(kernel, input)` fonksiyonudur.
Kural oluşturmak için mevcut Rule IR kullanılır:

```js
const { atom, variable, createRule } = require('../lib/inference-rule-ir');
const { runInference } = require('../lib/cli-inference-runtime');
const args = [variable('X'), variable('Y')];
const rule = createRule({
  id: 'connected-from-knows',
  head: atom('connected', args),
  body: [atom('knows', args)],
});
const result = runInference(kernel, { action: 'evaluate', rules: [rule] });
```

Bu örnekte grafikte provenance taşıyan aktif `knows(Alice, Bob)` varsa
`connected(Alice, Bob)` provisional olarak türetilir. Canonical kenar yazılmaz.
Aynı rule id farklı içerikle tekrar kullanılamaz.

| action | Girdi | Davranış |
| --- | --- | --- |
| evaluate | rules, isteğe bağlı limits | Semi-naive değerlendirme; snapshot, destekler ve provisional kayıtlar |
| query | rules, query, isteğe bağlı limits | Backward proof; provisional çıktı |
| abduce | rules, query, isteğe bağlı limits | Eksik destek önerileri; proposal_only çıktı |
| history | workspaceId | Değiştirilmeden tutulan runtime journal sürümleri |
| reconcile | workspaceId | Destekleri yeniden kontrol etme ve bağımlıları geri çekme |
| observe | workspaceId | Bağımsız aktif graph kanıtından prediction/outcome gözlemi |
| calibrate | ruleId, declaredConfidence | En az 5 gözlem sonrası tighten-only belief revision |
| admit | derivationId | Kalibrasyon, doğrulama ve mevcut candidate admission yolu |

Varsayılan workspace `default` olur. Her istek workspaceId belirtebilir.
query/history/abduce runtime journal yazmaz; CLI audit kapısından geçer.
Diğer işlemler mevcut graph mutation journal içinde sürümlenir.

## Kanıt ve admission sınırı

Snapshot yalnız aktif, provenance taşıyan, contest edilmemiş bağımsız kenarları
kullanır. `background_inference` kenarları bağımsız gözlem sayılmaz.
Eksik, pending veya yalnız bildirilmiş outcome başarı sayılmaz. declaredConfidence
mevcut rule için sabittir; calibration policy yetkisini genişletemez.

Admission için destekler geçerli, türetilmiş destekler admitted ve rule calibrated
olmalıdır. Kernel verifier `verified` demeli; kanıttaki kenar önerilen
from/relation/to üçlüsüyle tam eşleşmelidir. Sayısal doğrulama veya farklı ilişki
üzerinden bulunan bir yol bu şartı sağlamaz. Ardından mevcut ingestCandidateClaim
ve admission politikası çalışır; committed canonical receipt olmadan sonuç
admitted olamaz. Gerçek politika testinde `admission_review` sonucu provisional
kalır. Başarılı canonical admission için enjekte edilmiş evaluator kullanılan
recovery testi, üretim politikasının izin verdiğini kanıtlamaz.

Canonical admission tamamlanıp runtime kaydı kesilirse yeniden çağrı mevcut
committed candidate, edge ve canonical receipt eşleşmesini doğrulayarak toparlar.
Destek geri çekilince ilgili inference projection confidence/weight sıfıra düşer
ve contest kaydı eklenir; eski kenar, receipt ve runtime geçmişi korunur.
HIGH contested read bunu kullanılabilir canonical kanıt saymaz.

## Bütçeler ve yeniden üretim

En fazla 128 rule ve 10.000 graph kenarı kabul edilir. Üst limitler:
100.000 operation, 64 round, 1.000 derived fact, 1.000 ms, backward depth 32.
İstek bu limitleri yalnız azaltabilir. Çıktı stoppedReason bilgisini taşır.
evaluate çıktısındaki rules, snapshot.facts ve limits aynı evaluator ile
tekrar çalıştırılabilir; kaynak provenance ve rule snapshot kimlikleri saklanır.

## Doğrulama sınırı

`test/cli-inference-runtime.test.js` gerçek CLI, kalibrasyon, policy hold,
provenance değişimi, bağımlı withdrawal, restart, canonical recovery, contested
read ve yanlış ilişki kanıtını kapsar. Çok süreçli concurrency ve gerçek disk
hatası enjeksiyonu ayrıca doğrulanmadı. GitHub exact-head CI ve merge sonrası
main doğrulaması yerel testlerin yerine geçmez; ayrı teslim kapılarıdır.

## Değişen dosyalar

- `config/reachability-baseline.json`
- `docs/inference-runtime.md`
- `lib/cli-command-handlers.js`
- `lib/cli-inference-command.js`
- `lib/cli-mutation-audit-intent.js`
- `lib/cli-mutation-gate.js`
- `lib/command-parser.js`
- `lib/inference-derived-admission.js`
- `lib/inference-derived-dependency.js`
- `lib/inference-derived-record.js`
- `lib/inference-runtime-beliefs.js`
- `lib/inference-runtime-projection.js`
- `lib/inference-runtime-records.js`
- `lib/inference-runtime-recovery.js`
- `lib/inference-runtime-snapshot.js`
- `lib/inference-runtime-store.js`
- `lib/cli-inference-runtime.js`
- `lib/module-reachability.js`
- `lib/workflow-contract.js`
- `package.json`
- `scripts/capability-usage.js`
- `test/cli-command-dispatch.test.js`
- `test/cli-command-handlers-split.test.js`
- `test/cli-inference-runtime.test.js`
