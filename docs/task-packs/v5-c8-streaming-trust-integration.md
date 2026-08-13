# V5-C8 Streaming Trust — bounded integration task pack

## [BAĞLAM]

- Repository: `ali-ulu/huqan`
- Issue: #280
- Exact base: `main @ 9e34ee560fe831790a2f04c4281c68c29f425be4`
- Branch: `work/280`
- Predecessor: C7 webhook/auth/store primitives are already on `main`.
- Owner override recorded on #280 (2026-08-14): hosted/public HTTPS proof from #279 is deferred; C8 implementation may proceed now. This does not convert #279 to PASS and does not authorize production/general coverage claims.
- `graphify-out/GRAPH_REPORT.md` is absent at this base; live source is the fallback evidence path per `GRAPHIFY-001`.

## [GÖREV]

Wire the existing authenticated GitHub pull-request event boundary to the existing `evaluateCodeChange()` gate, bind the result to the exact repository/PR/head SHA, emit a canonical C8 receipt, and update a GitHub check run through a bounded installation-token client.

The C8 path must reuse C7 HMAC/event/replay binding and the existing code-change gate. It must not invent a second risk engine or a new canonical verdict vocabulary.

## Failing evidence before implementation

At the exact base:

1. `lib/github-app-beta-handler.js` authenticates/binds a PR delivery and emits only the C7 `beta_observation_only` receipt; it never calls `evaluateCodeChange()`.
2. `lib/github-app-writeback-contract.js` hardcodes `writebackReachable: false`; no reachable GitHub check-run writeback exists.
3. `lib/github-app-beta-auth.js` requests an installation token scoped only to `checks: write`; no bounded pull-request read permission is requested for changed-file evidence.
4. No C8 runtime test proves exact-head changed-file retrieval, gate evaluation, canonical receipt binding, review-gate writeback, or replay behavior.

## [KABUL]

The change is acceptable only if all of the following are proved by tests:

- C7 authentication and immutable delivery binding remain the ingest authority.
- Live PR metadata is re-read with the installation token and `pull_request.head.sha` must equal the webhook-bound head SHA before evaluation.
- Changed-file retrieval is bounded by page count, file count, path length, and numeric change totals; malformed/oversized input fails closed.
- Only bounded file metadata (`filename`, `status`, additions/deletions) is fed to `evaluateCodeChange()`; PR title/body, patch bodies, sender identity, and secrets are not persisted in the C8 receipt/check output.
- Existing code-change decisions are projected through the canonical verdict owner; unknown source decisions fail closed.
- C8 receipt metadata binds delivery ID, repository ID/full name, installation ID, PR number, exact head SHA, C7 receipt hash, and deterministic evidence summary.
- Review gate mapping is bounded: `allow -> success`, `review|dry_run_only -> action_required`, `block -> failure`.
- Writeback uses the Checks API with the exact bound head SHA and a deterministic external ID.
- Before outbound writeback, durable state is marked `started`; if the process/network outcome becomes ambiguous, replay refuses a second write and returns an explicit fail-closed state.
- A completed delivery replay returns the stored C8 result without a second changed-file fetch or second check-run write.
- GitHub 401/403/404/422/5xx, malformed JSON, head drift, excessive pagination, and writeback ambiguity never return a misleading success.
- Existing C7 tests remain unchanged in semantics and pass.

Targeted commands:

```text
node --test test/v5-c8-streaming-trust.test.js
node --test test/v5-c7-github-app-beta.test.js test/v5-c7-github-app-beta-auth.test.js
```

Final verification:

```text
npm test
```

## [YASAK]

- No PR title/body NLP or persistence.
- No new risk classifier; reuse `lib/code-change-gate.js`.
- No new canonical verdict values.
- No auto-merge, auto-push, release, or deploy behavior.
- No public-receipt/Ed25519/key-distribution wiring in this task.
- No Cloudflare/hosting work; that remains the deferred #279 hosted-proof item.
- No roadmap/checkpoint rewrite.
- No generic server/kernel/graph refactor.
- No claim that #279 hosted proof is PASS or that the GitHub App/Streaming Trust surface is production-ready.

## Allowed implementation files

- `lib/github-app-beta-auth.js` — minimum token permission expansion for bounded PR read + check write.
- `lib/verdict/action-verdict.js` — identity projection table for existing code-change decisions only.
- `lib/github-app-streaming-trust-store.js` — C8 durable replay/writeback state.
- `lib/github-app-streaming-trust.js` — bounded exact-head evidence fetch, gate, receipt, check writeback orchestration.
- `lib/github-app-beta-http-boundary.js` — opt-in C8 wiring behind explicit configuration; C7 path remains the default.
- `test/v5-c8-streaming-trust.test.js` — acceptance/falsification tests.
- This task-pack.

## Stop conditions

Stop rather than weaken a guard if exact-head identity cannot be proven, changed-file evidence exceeds bounds, installation credentials are unavailable in C8-enabled mode, a source decision cannot be mapped canonically, or writeback state is ambiguous.

## [SÜRÜM]

Base artifact: Git commit `9e34ee560fe831790a2f04c4281c68c29f425be4`.
