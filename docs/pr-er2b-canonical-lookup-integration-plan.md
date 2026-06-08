# PR-ER2B — Canonical Lookup Integration Plan

## 1. Purpose and Scope

This document plans **PR-ER2B — Canonical Lookup Integration**, the second runtime step in the Entity Resolution rollout after PR-ER1 (deterministic core), PR-ER2 (integration plan), and PR-ER2A (read-only verify probe).

PR-ER2B introduces a single, narrowly-scoped behavioural change to `lib/verify.js`:

> When the user-provided subject literal does not hit the graph directly, the verifier may attempt an additional read-only lookup using the **entity-resolution canonical key** as a fallback lookup key. If that canonical lookup returns existing graph evidence, the verifier's normal evidence-aggregation pipeline may produce a different verdict (e.g. `bilinmiyor` → `dogrulandi` or `celiski`).

The change is critical because it is the first PR in the Entity Resolution rollout that may **alter verify verdicts**. PR-ER1 and PR-ER2A never changed verdicts. PR-ER2B may change verdicts **only** when the new lookup key surfaces pre-existing canonical graph evidence that the original literal alone would not have surfaced.

**Scope is deliberately narrow**:

- Only `lib/verify.js` lookup helpers change.
- Only a new test file is added: `test/verify-canonical-lookup.test.js`.
- No other file under `lib/**`, `kernel.js`, `graph.js`, `server.js`, `requestGuards.js`, `package.json`, or `package-lock.json` may be touched.
- No `docs/` file other than this plan is touched in this PR.
- No graph writes. No learn-path change. No canonical-node creation. No H-score. No embeddings. No LLM / model / network call. No new endpoint, CLI, or MCP surface.

**Out of scope** (reserved for later PRs and explicitly listed in §8):
- Write-side anchoring of canonical nodes (PR-ER2C).
- Search / provenance alias-aware expansion (PR-ER2D).
- Ingest-time alias resolution (PR-ER3+).
- Learn-path integration (PR-ER4+).

**Critical policy** (defined precisely in §5):

- Entity resolution **alone** never produces a verdict.
- Entity resolution **expands** the set of lookup keys.
- Verdict still comes from graph evidence + verifier semantic-trust, as it does today.
- Ambiguous alias (no domain) never changes a verdict.
- Unknown alias never changes a verdict.

---

## 2. Current Sealed State

The following three PRs are merged into `origin/main` and form the precondition for PR-ER2B:

| PR | Commit | Scope | Sealed? |
|----|--------|-------|---------|
| PR-ER1 | `c9b7dce` | `lib/entity-resolution.js` (132 lines) + `test/entity-resolution.test.js` (273 lines, 29/29 pass) | yes |
| PR-ER2 | `f9ec73f` | `docs/pr-er2-entity-resolution-integration-plan.md` (497 lines, plan-only) | yes |
| PR-ER2A | `0f77212` | `lib/verify.js` (+12 / -5) + `test/verify-entity-resolution.test.js` (306 lines, 22/22 pass) | yes |

`origin/main` HEAD is `104cafd` (merge of `feature/pr-er2a-verify-entity-resolution-probe`).

Sealed test baseline on `origin/main`:

> Historical note: the counts in this section are the sealed baseline for this plan snapshot only. Current `main` may have a larger passing suite.

- Targeted: `node --test test/entity-resolution.test.js test/verify-entity-resolution.test.js` → **51/51 pass** (29 ER + 22 ER2A).
- Full: `npm test` → **913 tests / 897 pass / 0 fail / 16 skipped** (sqlite-skip tests are pre-existing environmental skips, not regressions).

Sealed state is therefore the strongest baseline the project has had since the deterministic-causal traversal PR. PR-ER2B must not regress this baseline; it may only add new passing tests and may allow additional existing tests to start passing **as a side effect of canonical-key lookup** (e.g. a future "Boeing 737" integration test that was previously only "bilinmiyor" could become "dogrulandi" if canonical evidence exists — but no such test exists yet in the sealed baseline).

---

## 3. Current Verify Flow and Where `entityResolution` Metadata Exists

This section describes the runtime surface that PR-ER2B will extend. It is read-only documentation of the current code path; no runtime change is proposed in this PR.

### 3.1 `lib/verify.js` entry

`VerifyService.verify(statement, opts)` is the public entry. It performs numeric-comparison short-circuit, then runs the rest of the pipeline through `VerifyService._verifyResult(statement, opts, data, evidence, context)` (private method, line 440 in the sealed `lib/verify.js`).

### 3.2 `_verifyResult` pipeline (sealed)

Inside `_verifyResult`, the pipeline is:

1. `workspaceId` normalisation.
2. `semanticTrust` computation via `buildVerifySemanticTrust({ statement, result, evidence, subject, predicate, edges, workspaceId, pathSearch, fuzzy, typeConflict })`. The `nextData.status` and `nextData.confidence` are derived from this call.
3. Decomposition (either from `context.decomposition` or a fresh `decomposeClaim` call).
4. Subclaim-outcome construction (single-element fallback when not provided).
5. Aggregate verdict via `aggregateSubclaimVerdicts`.
6. Reasoning trace via `buildReasoningTrace`.
7. `trustReceiptPreview` derivation.
8. **PR-ER2A step:** probe — `entityResolution` is computed from `context.subject` via `resolveEntity(subjectLiteral, { domain: opts.domain })` and attached to the meta object.
9. Final `this.kernel._ok('verify', nextData, evidence, { semanticTrust, reasoningTrace, trustReceiptPreview, entityResolution })`.

### 3.3 `entityResolution` meta shape (sealed)

The probe result attached to `meta.entityResolution.subject` is either:

- `{ original: <trimmed literal>, ...resolveEntity(...) }` when `context.subject` is a non-empty string, or
- `{ original: '', matched: false, reason: 'empty_subject' }` otherwise.

`resolveEntity` returns one of the following six shapes (PR-ER1 contract):

- `empty_alias` — alias is empty.
- `exact_alias` (matched) — alias is exactly registered; carries `canonical`, `domain`, `confidence`, `aliases[]`, `reason: 'exact_alias'`.
- `unknown_alias_in_domain` — alias is unknown inside a known domain.
- `exact_alias` without domain (matched) — alias is registered and globally unique without domain context.
- `ambiguous_alias_requires_domain` (not matched, `ambiguous: true`) — alias maps to multiple candidates across domains; carries `candidates[]`.
- `unknown_alias` — alias is not registered anywhere.

### 3.4 Where `entityResolution` flows today (sealed)

In the sealed `lib/verify.js`, the probe result is **only attached to the meta object** of the `kernel._ok` response. It is **not** consumed by any downstream graph-lookup, semantic-trust, evidence-aggregation, or verdict path. The probe is observable to callers (UI, tests) but has no effect on the verdict.

PR-ER2B is the first PR that consumes this probe data to widen the lookup key set.

---

## 4. Canonical Lookup Policy

The canonical-lookup policy is the single behavioural rule introduced by PR-ER2B.

### 4.1 Definition

> A *canonical-lookup* is a read-only graph query whose key is the `entityResolution.subject.canonical` value (e.g. `boeing_737`), used as a fallback only when the original-subject lookup did not yield a usable result.

### 4.2 Conditions for attempting a canonical-lookup

A canonical-lookup may be attempted **only if all** of the following hold:

1. `entityResolution.subject.matched === true`.
2. `entityResolution.subject.canonical` is a non-empty string.
3. `entityResolution.subject.ambiguous !== true`.
4. The original subject literal (`context.subject.trim()`) is not already identical to the canonical key (i.e. the canonical would not be a no-op duplicate lookup).
5. The original-subject graph lookup did not already return a usable result (i.e. the original literal was not found in the graph, or was found but with insufficient evidence for a non-`bilinmiyor` verdict).

If any of these conditions fail, the canonical-lookup **must not** be attempted, and the verifier must continue with the original-literal evidence path unchanged.

### 4.3 Read-only guarantee

The canonical-lookup is **read-only**:

- It calls the same read-only graph APIs that the original-literal lookup already calls (`getNode`, `getEdges`, `getEdge`).
- It never calls `addNode`, `addEdge`, `removeNode`, `setEdge`, `setNode`, or any other write API on the graph or kernel.
- It never instantiates a new canonical node. If the canonical key is not present in the graph, the lookup returns empty and the verifier falls back to the original-literal evidence path with no verdict change.
- It never modifies `memoryStore`, `ingest`, `learn`, or any persistence layer.

### 4.4 Original literal preserved

The original-literal subject is **always** preserved. It remains:

- The value of `meta.entityResolution.subject.original`.
- The primary lookup key (canonical-lookup is only a fallback).
- The value used in any error message, evidence-text, or trust-receipt preview.

If the canonical-lookup succeeds, the response meta additionally surfaces a `canonicalLookup` field (defined in §6) describing the fallback attempt, so callers can see that the verdict change is rooted in canonical evidence and not in entity-resolution alone.

---

## 5. Verdict Policy

This is the most important section of this plan. It locks down what may and may not change a verdict in PR-ER2B.

### 5.1 Five normative rules

1. **Entity resolution alone never verifies a claim.** The probe result `entityResolution.subject.canonical` is a *lookup key*, not *evidence*. A canonical key with no underlying graph data is just a string and produces no verdict change.

2. **Canonical graph evidence may verify a claim.** If a canonical-lookup (§4) returns usable existing graph evidence for the canonical key, the verifier's normal evidence-aggregation pipeline (semantic trust, evidence weighting, subclaim verdicts) may produce a non-`bilinmiyor` verdict for the claim. This verdict is justified by the **existing graph evidence**, not by the entity-resolution module.

3. **Ambiguous alias must not change a verdict.** When `entityResolution.subject.ambiguous === true` (e.g. `AI` with no domain), no canonical-lookup is attempted (§4.2 condition 3), so no verdict change can occur via this path. The verdict remains whatever the original-literal flow produced.

4. **Unknown alias must not change a verdict.** When `entityResolution.subject.matched === false` and `entityResolution.subject.ambiguous !== true` (e.g. `XYZ999`), no canonical-lookup is attempted (§4.2 condition 1), so no verdict change can occur via this path. The verdict remains `bilinmiyor` (or whatever the original-literal flow produced, which in practice is also `bilinmiyor` because unknown aliases have no graph data).

5. **Empty or missing subject must not change a verdict.** When `entityResolution.subject.reason === 'empty_subject'`, no canonical-lookup is attempted. No verdict change.

### 5.2 Truth-source contract

The truth source for any verdict change in PR-ER2B is the **existing graph evidence** that the canonical key surfaces. Entity resolution is the *index* that lets the verifier find that evidence under an alias; it is not the *evidence* and not the *verifier*.

This is the same conceptual model as a database index: the index helps a query find a row faster; the row's data is the truth. Removing the index would not change the truth; it would only slow down (or fail) the lookup.

### 5.3 Backward compatibility

For claims whose original-subject literal already finds sufficient evidence in the graph, the canonical-lookup path is **not** taken (condition 5 in §4.2). These claims produce exactly the same verdict as in the sealed baseline.

For claims whose original-subject literal does **not** find evidence, the new behaviour is:

- If the canonical key also finds no evidence → verdict is `bilinmiyor` (same as sealed baseline).
- If the canonical key finds evidence → verdict may be `dogrulandi`, `celiski`, or another non-`bilinmiyor` value, depending on what the existing evidence supports. This is a **strictly wider verdict set**, never a narrower one. Existing `dogrulandi` and `celiski` verdicts for cases that already worked are preserved.

### 5.4 Why this is safe

The risk surface is bounded by the read-only contract (§4.3) and by the five rules in §5.1. Specifically:

- No graph mutation means no new false-positive "evidence" can be created.
- The canonical-lookup uses the **same** read-only APIs the original-literal lookup already uses, with the **same** evidence-weighting and semantic-trust pipeline. There is no second, weaker, or special-cased evidence path for canonical keys.
- Ambiguous and unknown aliases are explicitly short-circuited out of the canonical-lookup path, eliminating the dominant false-positive risk surface (alias collision across domains).

---

## 6. Proposed Integration Point in `lib/verify.js`

This section describes where and how the canonical-lookup is integrated. It is a **plan**, not the implementation; the implementation will be done in the code-PR that follows this plan-PR.

### 6.1 Location

The integration is a **single helper function** added to `lib/verify.js` and called from one place: the body of `_verifyResult`, after the `entityResolution` probe is computed (current line ~494–500) and before the final `kernel._ok` call.

### 6.2 Helper signature (proposed)

```
attemptCanonicalLookup({ subjectLiteral, canonicalKey, opts, context })
  -> { attempted: boolean, hit: boolean, evidence: Evidence[], matchedNode: Node|null }
```

- `attempted` is `true` only when all §4.2 conditions are satisfied.
- `hit` is `true` when the canonical-key read-only graph query returns at least one evidence item.
- `evidence` is the array of read-only evidence items the canonical-key lookup produced (or `[]` if not hit).
- `matchedNode` is the graph node the canonical key resolved to (or `null`).

### 6.3 Verifier pipeline modification (proposed)

Inside `_verifyResult`, after the `entityResolution` probe is computed:

1. Call `attemptCanonicalLookup(...)`. If it returns `attempted: false` or `hit: false`, the verifier proceeds exactly as in the sealed baseline.
2. If it returns `hit: true`, the verifier extends the **evidence** array passed to the semantic-trust and verdict pipeline with the canonical-key evidence. The original-literal evidence is also retained. The aggregate is computed over the **combined** evidence.
3. The combined evidence path uses the **same** `buildVerifySemanticTrust`, the **same** `aggregateSubclaimVerdicts`, and the **same** `buildReasoningTrace` calls. There is no special-cased "canonical-key" path through the verifier; canonical evidence is just more evidence of the same kind.

### 6.4 Meta attachment (proposed)

The `kernel._ok` call's meta object gains one new field in addition to the existing `entityResolution`:

```
canonicalLookup: {
  attempted: <bool>,
  hit: <bool>,
  canonical: <string|null>,     // the canonical key used for the lookup
  original: <string>,            // the original literal, preserved
  evidenceCount: <number>,      // number of evidence items added from canonical lookup
}
```

This is observable to callers and tests so that the canonical-lookup path is auditable.

### 6.5 No other changes

- `kernel.js`, `graph.js`, `server.js`, `requestGuards.js` are not touched.
- `lib/ingest.js`, `lib/provenance-query.js`, `lib/memory-store.js` are not touched.
- `package.json` and `package-lock.json` are not touched.
- No new dependencies.
- No new CLI flags, no new HTTP endpoints, no new MCP tools.

---

## 7. Proposed Tests

A new test file `test/verify-canonical-lookup.test.js` is added. It must cover, at minimum, the following eight scenarios. All tests must be deterministic, hermetic, and run in the standard `node --test` harness with the existing stub-kernel pattern used by `test/verify-entity-resolution.test.js`.

### 7.1 Test list

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Subject `B737` with `domain: 'aviation'`, stub graph has node `boeing_737` with positive evidence, no node for `B737` | Verdict `dogrulandi` (canonical evidence found via fallback). `meta.canonicalLookup.hit === true`. `meta.canonicalLookup.canonical === 'boeing_737'`. `meta.entityResolution.subject.original === 'B737'`. |
| 2 | Subject `Boeing-737` and subject `Boeing 737` with `domain: 'aviation'`, stub graph has node `boeing_737` | Both resolve to the same canonical lookup; both produce identical `canonicalLookup` meta. Original literal is preserved in each. |
| 3 | Subject `B737` with `domain: 'aviation'`, stub graph has node `B737` (the original literal hit) with positive evidence, also has node `boeing_737` | Verdict `dogrulandi` from the original-literal path. `meta.canonicalLookup.attempted === false` (condition 5 of §4.2: original hit already had sufficient evidence). Verdict unchanged from sealed baseline. |
| 4 | Subject `AI` with no domain (empty / undefined / null) | `entityResolution.subject.ambiguous === true`. `canonicalLookup.attempted === false`. Verdict unchanged from sealed baseline. |
| 5 | Subject `AI` with `domain: 'aviation'`, `domain: 'tech'`, `domain: 'design'`, stub graph has canonical nodes for each | Each domain-scoped resolution produces its respective canonical lookup key (`air_india`, `artificial_intelligence`, `adobe_illustrator`). Original literal `AI` is preserved in every meta. |
| 6 | Any subject with `entityResolution.subject.matched === false` (e.g. `XYZ999`) | `canonicalLookup.attempted === false`. Verdict unchanged from sealed baseline. |
| 7 | Empty / whitespace-only / missing subject | `canonicalLookup.attempted === false`. Verdict unchanged. `entityResolution.subject.reason === 'empty_subject'`. |
| 8 | Stub graph that exposes `addNode` / `addEdge` / `removeNode` and counts write calls during a verify call that triggers canonical-lookup | Write-call count is exactly **zero**. Read-only contract enforced. |

### 7.2 Existing-test compatibility

All existing tests in `test/entity-resolution.test.js` (29 tests) and `test/verify-entity-resolution.test.js` (22 tests) must continue to pass unchanged. The full `npm test` baseline (913 tests / 897 pass / 0 fail / 16 skipped) must be preserved or improved (only improvements are allowed: more tests passing, no new failures).

> Historical note: this paragraph refers to the baseline that existed when the plan was authored, not the current global test total on `main`.

### 7.3 Determinism

Repeated verify calls with identical inputs must produce byte-identical responses (including `canonicalLookup` meta). This is the same determinism contract that PR-ER2A's tests already cover for the `entityResolution` probe.

---

## 8. Out-of-Scope

The following items are **explicitly out of scope** for PR-ER2B and will be planned and implemented in later PRs:

- **Write-side anchoring** of canonical nodes (`kernel.companyBrain` capability or similar). Reserved for PR-ER2C.
- **Learn-path integration** of canonical evidence into memory. Reserved for PR-ER4+.
- **Ingest-time alias resolution**. Reserved for PR-ER3+.
- **Search and provenance alias-aware expansion** in `lib/provenance-query.js`. Reserved for PR-ER2D.
- **H-score** and any confidence-boosting scoring system that incorporates entity resolution.
- **High-risk admission gate** based on entity resolution.
- **Embeddings, vector search, semantic similarity scoring** for entity resolution.
- **LLM, model, or network calls** for entity resolution. The `lib/entity-resolution.js` module remains a pure deterministic function.
- **New HTTP endpoints, CLI flags, or MCP tools** related to entity resolution.
- **Canonical-node schema changes** in `lib/memory-schema.js`. The graph schema is not modified in PR-ER2B.
- **Cross-workspace canonical resolution**. PR-ER2B operates inside the workspace passed via `opts.workspaceId`, the same as the sealed baseline.

---

## 9. Risks

### 9.1 False canonical collapse

Two distinct entities accidentally collapsing to the same canonical key would cause the verifier to mix their evidence. Mitigation:

- The canonical-lookup uses the same `resolveEntity` registry as PR-ER1 / PR-ER2A, which is hand-curated and explicitly avoids collisions.
- Ambiguous aliases are short-circuited out of the canonical-lookup path.
- The canonical-lookup does not invent or merge nodes; it only reads existing ones.
- PR-ER1 already includes 29 unit tests for the registry. PR-ER2B's new test file will add additional integration-level coverage.

### 9.2 Domain missing ambiguity

If a caller forgets to pass `opts.domain`, an alias like `AI` becomes ambiguous and the canonical-lookup is skipped. This is **correct behaviour** under rule 3 of §5.1, but a UX concern: callers may be surprised that `AI` does not get a canonical hit.

Mitigation:

- This is a pre-existing design choice from PR-ER1; PR-ER2B does not change it.
- The `entityResolution.subject.ambiguous` flag is exposed in the meta so callers can detect the ambiguity and either re-prompt the user for a domain or fall back to the original-literal flow.
- A future PR (not PR-ER2B) may add a workspace-level default domain or a UI-level domain picker.

### 9.3 Status change attribution

If a verify call's verdict changes from `bilinmiyor` to `dogrulandi`, the caller may want to know whether the change came from the canonical-lookup path or from some other cause. Mitigation:

- The new `meta.canonicalLookup` field (§6.4) explicitly records `attempted`, `hit`, `canonical`, `original`, and `evidenceCount`.
- The existing `meta.entityResolution.subject.canonical` field from PR-ER2A still records the resolved canonical key.
- A test in §7.1 row 3 explicitly asserts that when the original-literal path already produces `dogrulandi`, `canonicalLookup.attempted === false`, so the attribution is unambiguous.

### 9.4 Backward compatibility

Existing callers that depend on the sealed `bilinmiyor` verdict for cases that, in the future, may resolve to `dogrulandi` via canonical-lookup, may be surprised. Mitigation:

- The sealed baseline has no tests that fail when this PR is applied (verified pre-merge).
- The full `npm test` baseline (913/897/0/16) must remain at 0 fail post-merge.
- A new explicit test in §7.1 row 3 documents that pre-existing `dogrulandi` verdicts are preserved.

### 9.5 Probe-only consumers

Callers that consume the `entityResolution` meta field added in PR-ER2A but do not pass a `domain` option will see `ambiguous: true` for many common aliases (`AI`, `JS`, etc.) and `canonicalLookup.attempted === false`. This is correct under rule 3, but it is worth noting that the canonical-lookup power of PR-ER2B is only activated for callers that already pass `domain`.

---

## 10. Acceptance Criteria

PR-ER2B is accepted when **all** of the following hold:

1. **Scope is narrow:** only `lib/verify.js` and a new test file `test/verify-canonical-lookup.test.js` are modified. `git diff --stat` shows exactly these two files (and no others).
2. **Read-only contract:** no graph write APIs (`addNode`, `addEdge`, `removeNode`, `setNode`, `setEdge`, etc.) are called from the new code path. The §7.1 row 8 test enforces this.
3. **Verdict policy respected:** the five rules in §5.1 are enforced. Tests in §7.1 rows 4, 6, 7 enforce rules 3, 4, 5 explicitly. Tests in §7.1 rows 1, 2, 5 exercise rules 1, 2 under positive conditions.
4. **Backward compatibility:** the sealed full `npm test` baseline of 913/897/0/16 does not regress. No existing test that passed pre-PR may fail post-PR.
5. **Original literal preserved:** every `canonicalLookup` meta entry includes `original` set to the trimmed input literal. Tests in §7.1 rows 1, 2, 5 assert this.
6. **Determinism:** repeated verify calls with identical inputs produce byte-identical responses, including the new `canonicalLookup` meta. A new determinism test asserts this.
7. **No new dependencies:** `package.json` and `package-lock.json` are byte-identical pre- and post-PR.
8. **No out-of-scope changes:** no new endpoint, no new CLI flag, no new MCP tool, no new HTTP API, no write to `kernel.js` / `graph.js` / `server.js` / `requestGuards.js` / `lib/ingest.js` / `lib/provenance-query.js` / `lib/memory-store.js` / `lib/memory-schema.js`.
9. **UTF-8 clean:** this plan file is the only `docs/**` file changed. It is saved UTF-8 without BOM. Encoding is verified post-write.
10. **Code review acceptance:** the PR passes Codex-style review with no P0 or P1 issues. P2/P3 nits are addressed in commit follow-ups if minor.

---

## 11. Next PR Sequence

PR-ER2B (this PR) is the second runtime step. The planned sequence is:

1. **PR-ER2B (this PR — plan-only docs):** `docs/pr-er2b-canonical-lookup-integration-plan.md` (this file). Sealed, UTF-8 clean, no runtime code.
2. **PR-ER2B (code):** `lib/verify.js` lookup helper + `test/verify-canonical-lookup.test.js`. Sealed via the same narrow-worktree / selective-stage / `--no-ff` merge / clean-clone-verify workflow used in PR-ER1 / PR-ER2A.
3. **PR-ER2C (write-side anchoring):** the canonical-lookup from PR-ER2B may discover canonical keys for which no node yet exists in the graph. PR-ER2C will plan and implement how such canonical keys are anchored as first-class nodes in the graph, gated by the workspace's provenance and trust rules. This is where `kernel.companyBrain` and the graph schema may first be touched.
4. **PR-ER2D (search / provenance alignment):** extend `lib/provenance-query.js` (`queryProvenance` and `queryTrustGraph`) so search and trust-graph queries can also fall back to canonical keys via the same `entityResolution` module. This is where `lib/provenance-query.js` is first touched by the ER rollout.
5. **PR-ER3+ (ingest, learn, embeddings, H-score):** later, after ER2B and ER2C are stable in production for at least one release cycle. None of these are approved yet and will require their own separate plans and approvals before any code is written.

---

## 12. Sealing Plan (this PR)

This PR is a **docs-only plan PR**. The sealing workflow for this PR is:

1. Open new worktree at `C:/Users/sonfi/Desktop/axiom-pr-er2b-clean` on a new branch `docs/pr-er2b-canonical-lookup-integration-plan` from `origin/main @ 104cafd`.
2. Write this file (`docs/pr-er2b-canonical-lookup-integration-plan.md`) only.
3. Verify UTF-8 cleanliness: no BOM, file decodes cleanly as UTF-8.
4. Verify `git status --short` shows exactly one untracked file: `docs/pr-er2b-canonical-lookup-integration-plan.md`.
5. Verify `git diff --stat` shows no tracked file changes.
6. Stage only this file: `git add docs/pr-er2b-canonical-lookup-integration-plan.md`.
7. Commit with message `docs(entity): plan canonical lookup integration`.
8. Push branch to `origin`.
9. In the V1-PR1-clean-equivalent main worktree, `git merge --no-ff docs/pr-er2b-canonical-lookup-integration-plan` from `origin/main`.
10. Push `origin main` (`104cafd..<merge>`).
11. No `npm test` is required for a docs-only PR; running it is allowed but not required for sealing.

If any file outside `docs/pr-er2b-canonical-lookup-integration-plan.md` changes, stop and report.
