# Self-Healer Contracts

## Amaç

Bu belge, Self-Healer implementasyonundan önce gerekli veri sözleşmelerini tanımlar.

Bu paket yalnız contract, schema, fixture ve acceptance criteria içindir.

## Kapsam

Bu belgede şu sözleşmeler tanımlanır:

- `scan_run`
- `finding`
- `bug_classification`
- `memory_lookup_result`
- `fix_proposal`
- `regression_test_proposal`
- `trust_receipt_summary`
- `safety_decision_matrix`

## Temel İlke

`AXIOM judges, human decides.`

Self-Healer hiçbir contract seviyesinde bile otonom merge, otonom deploy veya otonom canonical write yetkisi almaz.

## 1. `scan_run` Contract

Bir tarama oturumunun üst kayıt nesnesidir.

### Required fields

- `scanRunId`
- `workspaceId`
- `branch`
- `commit`
- `actor`
- `mode`
- `startedAt`
- `sourceRef`
- `scope`
- `status`

### Optional fields

- `endedAt`
- `summary`
- `findingCount`
- `notes`

### Rules

- `mode` başlangıçta `dry_run` veya `review_only` olmalıdır.
- `scope` dosya/dizin/alan sınırını açık taşımalıdır.
- `status` en az `running`, `completed`, `blocked`, `failed` değerlerini desteklemelidir.

## 2. `finding` Contract

Tarama sonucunda bulunan tekil mühendislik bulgusudur.

### Required fields

- `findingId`
- `scanRunId`
- `type`
- `severity`
- `confidence`
- `title`
- `description`
- `evidence`
- `riskFlags`
- `affectedFiles`
- `status`

### Optional fields

- `relatedTests`
- `workspaceId`
- `branch`
- `commit`
- `tags`
- `firstSeenAt`
- `lastSeenAt`

### Rules

- `severity` en az `low`, `medium`, `high`, `critical` olmalıdır.
- `confidence` `0..1` aralığında olmalıdır.
- `evidence` boş bırakılmamalıdır; en az bir gözlenebilir kanıt gerekir.
- `status` başlangıçta `candidate`, sonra `confirmed`, `false_positive`, `resolved`, `blocked` gibi hallere gidebilir.

## 3. `bug_classification` Contract

Bulgunun teknik doğasını, riskini ve aksiyon sınırını tanımlar.

### Required fields

- `classificationId`
- `findingId`
- `category`
- `riskLevel`
- `requiresHumanReview`
- `patchAllowed`
- `recommendedAction`
- `reasoningSummary`

### Optional fields

- `subtype`
- `ruleHits`
- `blockedByPolicy`
- `notes`

### Rules

- `recommendedAction` en az `observe`, `propose`, `require_review`, `block`, `quarantine` kümesinden türemelidir.
- `patchAllowed` `true` olsa bile bu doğrudan patch izni anlamına gelmez; sadece policy açısından teorik uygunluğu gösterir.

## 4. `memory_lookup_result` Contract

Mevcut finding için Memory Core içinde geçmiş örnek, pattern ve karar özetini döndürür.

### Required fields

- `lookupId`
- `findingId`
- `similarFindings`
- `knownFalsePositive`
- `acceptedFixPatterns`
- `rejectedFixPatterns`
- `summary`

### Optional fields

- `matchingTrustReceipts`
- `matchingTestOutcomes`
- `matchingPrOutcomes`
- `notes`

### Rules

- Bu contract read-only davranır.
- Memory lookup sonucu kanonik kararı tek başına vermez; yalnız karar desteği sağlar.

## 5. `fix_proposal` Contract

Önerilen düzeltme stratejisini tanımlar.

### Required fields

- `proposalId`
- `findingId`
- `strategy`
- `risk`
- `requiresApproval`
- `patchAllowed`
- `rationale`
- `expectedTests`

### Optional fields

- `candidateFiles`
- `negativeScope`
- `blockedReasons`
- `humanQuestions`

### Rules

- `patchAllowed: false` ise uygulama önerisi değil, yalnız yönlendirme veya not üretilebilir.
- `expectedTests` boşsa sebebi açıkça yazılmalıdır.
- Runtime code patch için varsayılan durum `requiresApproval: true` olmalıdır.

## 6. `regression_test_proposal` Contract

Bir bulgunun tekrarını önlemek için önerilen test taslağıdır.

### Required fields

- `testProposalId`
- `findingId`
- `testType`
- `suggestedCommand`
- `required`
- `reason`

### Optional fields

- `candidateTestFiles`
- `coversFiles`
- `notes`

### Rules

- Test önerisi, finding ile izlenebilir bağ kurmalıdır.
- `required: false` yalnız setup veya ops note türü durumlarda kabul edilir.

## 7. `trust_receipt_summary` Draft Contract

Tam emitter implementasyonu değil, alan taslağıdır.

### Required fields

- `receiptId`
- `scanRunId`
- `findingId`
- `decision`
- `evidenceSummary`
- `riskSummary`
- `approvalRequired`

### Optional fields

- `memorySummary`
- `testSummary`
- `scopeSummary`
- `policyVersion`

### Rules

- Bu nesne, Self-Healer önerisinin neden güvenli veya neden bloklu olduğunu özetlemelidir.
- Tam trust receipt emitter bu PR kapsamında implement edilmez.

## 8. Safety Decision Matrix Contract

Karar motorunun sözleşmesel çıktısı beş seviyede tanımlanır:

- `observe`
- `propose`
- `require_review`
- `block`
- `quarantine`

### Contract fields

- `decisionId`
- `findingId`
- `decision`
- `reason`
- `riskLevel`
- `requiresApproval`
- `allowedNextSteps`

## Acceptance Criteria

Bu contract pack başarılı sayılmak için:

1. Tüm ana Self-Healer kayıt tipleri isimli ve açıklamalı olmalı.
2. Her contract required/optional alanları ayırmalı.
3. Safety decision sonuçları açıkça tanımlanmalı.
4. Runtime implementasyonu veya source code değişikliği içermemeli.
5. Memory Core bağımlılığı ve human-gated sınırlar açık yazılmalı.

## Kapsam Dışı

- runtime scanner
- patch runner
- GitHub automation
- draft PR writer
- auto-fix execution
- auto-merge
