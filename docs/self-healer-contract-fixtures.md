# Self-Healer Contract Fixtures

Bu belge, Self-Healer contract paketindeki kayıt tipleri için örnek JSON fixture'ları içerir.

## A. `scan_run` Example

```json
{
  "scanRunId": "scan_20260612_0001",
  "workspaceId": "repo:agiulucom42-del/axiom",
  "branch": "main",
  "commit": "26d73e9",
  "actor": "huqan.self_healer",
  "mode": "dry_run",
  "startedAt": "2026-06-12T10:00:00.000Z",
  "sourceRef": "local-clean-main",
  "scope": ["lib/", "test/"],
  "status": "completed"
}
```

## B. `finding` Example

```json
{
  "findingId": "finding_20260612_0001",
  "scanRunId": "scan_20260612_0001",
  "type": "test_failure",
  "severity": "medium",
  "confidence": 0.82,
  "title": "SQLite dependency missing before memory test",
  "description": "memory-store-sqlite requires better-sqlite3 after clean clone setup",
  "evidence": [
    "test/memory-store-sqlite.test.js failed before npm ci",
    "test passed after npm ci"
  ],
  "riskFlags": ["dependency_setup"],
  "affectedFiles": ["test/memory-store-sqlite.test.js"],
  "status": "candidate"
}
```

## C. `memory_lookup_result` Example

```json
{
  "lookupId": "lookup_20260612_0001",
  "findingId": "finding_20260612_0001",
  "similarFindings": [],
  "knownFalsePositive": false,
  "acceptedFixPatterns": [],
  "rejectedFixPatterns": [],
  "summary": "No prior matching finding found."
}
```

## D. `fix_proposal` Example

```json
{
  "proposalId": "fix_20260612_0001",
  "findingId": "finding_20260612_0001",
  "strategy": "documentation_or_setup_note",
  "risk": "low",
  "requiresApproval": true,
  "patchAllowed": false,
  "rationale": "This is an operational setup note, not a runtime bug.",
  "expectedTests": ["npm ci", "node --test test/memory-store-sqlite.test.js"]
}
```

## E. `regression_test_proposal` Example

```json
{
  "testProposalId": "test_20260612_0001",
  "findingId": "finding_20260612_0001",
  "testType": "setup_smoke",
  "suggestedCommand": "npm ci && node --test test/memory-store-sqlite.test.js",
  "required": false,
  "reason": "Locks clean-clone setup expectation."
}
```

## F. `bug_classification` Example

```json
{
  "classificationId": "class_20260612_0001",
  "findingId": "finding_20260612_0001",
  "category": "dependency_or_environment",
  "riskLevel": "low",
  "requiresHumanReview": true,
  "patchAllowed": false,
  "recommendedAction": "propose",
  "reasoningSummary": "Observed setup dependency issue, not a runtime correctness bug."
}
```

## G. `trust_receipt_summary` Draft Example

```json
{
  "receiptId": "receipt_20260612_0001",
  "scanRunId": "scan_20260612_0001",
  "findingId": "finding_20260612_0001",
  "decision": "propose",
  "evidenceSummary": [
    "SQLite test failed before dependency install",
    "SQLite test passed after npm ci"
  ],
  "riskSummary": "Low risk operational setup note.",
  "approvalRequired": true
}
```

## Fixture Kuralları

- Tüm fixture örnekleri deterministic alan adları kullanmalıdır.
- Kimlik alanları örnektir; runtime implementasyonu aynı prefix düzenini koruyabilir ama zorunlu değildir.
- `confidence` ve risk alanları açık ve parse edilebilir kalmalıdır.
- Fixtures contract testleri veya gelecekteki schema helper testleri için referans olarak kullanılabilir.
