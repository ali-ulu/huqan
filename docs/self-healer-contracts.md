# Self-Healer Contracts

> Source-of-truth note:
>
> This document is not fully invalid, but it is split between implemented and
> planned contracts. The implemented finding contract is authoritative only in
> `lib/self-healer/finding-schema.js` and its tests. The other contract
> families below remain planned design material until source and tests prove
> implementation.

## Amaç

Bu belge, Self-Healer implementasyonundan önce gerekli veri sözleşmelerini tanımlar.

Bu paket yalnız contract, schema, fixture ve acceptance criteria içindir.

## Kapsam

Implemented contracts:

- `finding` - runtime schema authority is
  `lib/self-healer/finding-schema.js`.
- `safety_decision_matrix` - runtime authority is
  `lib/self-healer/safety-decision.js`. It encodes
  `docs/self-healer-safety-matrix.md` and is the only place that mapping
  exists in source.
- `trust_receipt_summary` - emitted by `lib/self-healer/dryrun-runner.js`.
  Note the limit: this is a summary object recording why a proposal was
  safe or refused. It is not a canonical Trust Receipt, is not hash-chained,
  and is not written through `lib/receipt/receipt-chain.js`.
- `asi10_behavioral_containment` - emitted by
  `lib/self-healer/behavioral-containment.js` and consumed by the production
  Agent adapter. It contains only bounded baseline/version/hash, scoped
  observation, deviation code, sequence summary, and reintegration prerequisites.
- `asi10_behavioral_runtime` - implemented by
  `lib/self-healer/behavioral-containment-runtime.js`. It applies logical
  executor suppression to an exact workspace/agent scope and exposes operator
  controlled revoke/reintegration; it never claims provider credential or IAM
  revocation.

Planned contracts:

- `scan_run`
- `bug_classification`
- `memory_lookup_result`
- `fix_proposal`
- `regression_test_proposal`

Runtime modes in source are `audit_only` (`audit-runner.js`) and `dry_run`
(`dryrun-runner.js`). Neither applies anything. `review_only` below remains
historical/planned terminology and is not current runtime authority.

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

This section is historical/planned shape material. Current runtime finding
authority is `lib/self-healer/finding-schema.js`, which uses fields such as
`kind`, `summary`, `suggestedTests`, `suggestedFix`, `createdAt`, `updatedAt`,
and `receiptId`; it does not use this document's `type`, `description`, or
`scanRunId` fields as runtime authority.

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

## 9. ASI10 Behavioral Telemetry and Containment Runtime

The production Agent run creates a hash-bound behavioral baseline from the
receiver-declared goal scope, workspace, agent identity, selected tools, and
bounded internal capabilities. The raw goal is not stored in the behavioral
manifest; only its fingerprint is part of the baseline. Every attempted step
adds a bounded telemetry event containing sequence number, normalized tool and
action, decision, deviation code, containment action, and summary receipt ID.
The event ring is capped at 64 events and the unique-tool summary at 16 items.
Raw step input, targets, credentials, and provider material are not copied into
this telemetry.

The runtime containment state is keyed by `(workspaceId, agentId)`, so a
quarantine or logical revoke cannot suppress another workspace or agent. The
executor guard denies further work while `pause`, `review`, `block`,
`quarantine`, or `revoke` is active. `revoke` means only logical executor
capability suppression; external credential/IAM revocation is intentionally
not claimed. Reintegrating a contained scope requires fresh identity,
dependency, and policy verification plus explicit operator approval.

The Agent stops its run immediately after a blocked step and persists the
bounded manifest, telemetry, findings, and containment state so a resumed run
reconstructs the same scoped guard before executing another step. The
self-healer audit path remains dry-run and recommendation-only; it does not
apply containment automatically.

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
