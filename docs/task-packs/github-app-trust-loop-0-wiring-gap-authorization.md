# GITHUB-APP-TRUST-LOOP-0 -- Wiring Gap Authorization

## Plan Check

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact authorization base: `main @ 37f68cfd7b36093b59f72a134e94217315e90daf`
- Predecessors: V5-C7 GitHub App beta webhook handler (`lib/github-app-beta-handler.js`), V5-C4/D3 public trust receipt (`docs/v5/v5-d3-public-trust-receipt.md`), V4-B3 receipt bundle export, V4-B4 Trust Receipt Viewer
- Mode: wiring-gap audit plus one pure, unreachable contract artifact
- Reachable write-back to GitHub: forbidden
- Wiring any `lib/v5/*` module into a production entry point: forbidden
- Modifying `lib/github-app-beta-handler.js`, `github-app-server.js`, or their locked test assertions: forbidden

## Source-Reality Finding

HUQAN has four finished, independently tested trust primitives that a PR event should connect, and does not:

1. `lib/github-app-beta-handler.js` receives a real `pull_request` webhook, verifies its HMAC signature (`verifyWebhookSignature`, `lib/github-app-beta-auth.js:62`), dedupes by delivery GUID (`store.reserveDelivery`, `lib/github-app-beta-handler.js:220`), and always writes a receipt with `decision: 'beta_observation_only'` (`lib/github-app-beta-handler.js:136`) and `verdict: 'review'` (`lib/github-app-beta-handler.js:158`). No branch in this file ever produces a different decision or verdict; `test/v5-c7-github-app-beta.test.js:70-77` locks these exact values as the contractual behavior of the handler, not as a placeholder awaiting completion.
2. `lib/github-app-beta-auth.js` exports `createInstallationAccessToken()` (`lib/github-app-beta-auth.js:99-160`), a real JWT-to-installation-token exchange against `POST /app/installations/{id}/access_tokens`. It is exercised only by `test/v5-c7-github-app-beta-auth.test.js`. Grepping for `createInstallationAccessToken` outside tests returns zero production callers. Grepping the whole repository for `octokit`, `check-run`, `check_run`, `createComment` returns zero matches anywhere. `lib/github-app-beta-handler.js` and `lib/github-app-beta-http-boundary.js` (lines 161-176) return only `{ ok, duplicate, receiptHash }` to the HTTP caller (GitHub itself); nothing is ever POSTed back to GitHub.
3. `lib/v5/public-trust-receipt.js` implements `exportPublicTrustReceipt()` / `verifyExportedBundle()` per `docs/v5/v5-d3-public-trust-receipt.md`, status `V5_D3_PUBLIC_TRUST_RECEIPT_PROVEN`. Its own doc states explicitly (lines 8-9): it does not add an HTTP route, CLI command, MCP tool, key-distribution service, or production caller. `lib/module-reachability.js:87` classifies it under `NOT_YET_WIRED` with reason "V5 D3 public receipt exchange library; no production transport caller".
4. `/api/workbench/receipt-bundle` (V4-B3) and the Trust Receipt Viewer (V4-B4) both operate on the private local ledger. Nothing produced by the GitHub App handler, and nothing the public-receipt exporter could produce, is fed into either.

The exact missing calls, concretely:

- `lib/github-app-beta-handler.js` never calls any verification function before choosing `decision`/`verdict`. There is no non-V5 product concept of "verify a pull request" in this repository. `kernel.js:1637` (`kernel.verify(statement, opts)`) verifies a natural-language statement against the knowledge graph; it has no defined mapping from a `pull_request` webhook payload to a statement, and the handler's own test fixture (`test/v5-c7-github-app-beta.test.js:26-27`) marks PR `title`/`body` as content that "must not be persisted" -- there is no privacy-reviewed path from raw PR content into any verifier. The only PR-trust-relevant verification primitives that exist at all are `lib/v5/verification-core.js` and `lib/v5/cryptographic-verification-adapter.js`, both `NOT_YET_WIRED` under the V5 gate (`lib/module-reachability.js:86` and `:92`).
- `lib/github-app-beta-handler.js` never calls `createInstallationAccessToken()`, never constructs an Octokit/REST client, and never calls `POST /repos/{owner}/{repo}/check-runs` or `POST /repos/{owner}/{repo}/issues/{number}/comments`.
- No caller anywhere invokes `exportPublicTrustReceipt()` against a receipt produced by the GitHub App handler, and no HTTP route, CLI command, or MCP tool exists to serve the result if it were called.

## Hard Blockers (verified, not assumed)

1. V5 gate. `docs/current-operating-roadmap.md:29` records `V5_IMPLEMENTATION_ENTRY: FAIL`, controlling until a successor entry audit (issue #277, V5-C5) records `PASS` (`docs/current-operating-roadmap.md:157-164`). `docs/current-operating-roadmap.md:186` explicitly lists "GitHub App / Streaming Trust production-ready" under Current non-claims. Any production caller of `lib/v5/public-trust-receipt.js`, `lib/v5/verification-core.js`, or `lib/v5/cryptographic-verification-adapter.js` -- including from `github-app-server.js`, which is itself a declared production entry point in `lib/module-reachability.js:35` -- would flip those modules from `NOT_YET_WIRED` to reachable while the gate that authorizes their production use is still `FAIL`. Connecting V5-D3 to the GitHub App loop is therefore not merely undocumented, it would violate a standing gate decision. CONFIRMED BLOCKER.
2. Write-back credentials/capability. `createInstallationAccessToken()` is real and unit-tested, but nothing calls it, and there is no Octokit dependency, no check-run/comment call, and no `GITHUB_APP_PRIVATE_KEY`/`GITHUB_APP_ID` wiring anywhere outside `lib/github-app-beta-auth.js` itself and its test. Beyond the missing code, this is a new outbound, mutating capability against a third party (GitHub) that has not been through a security review for a new external write path. CONFIRMED BLOCKER -- both missing code and missing security review, not just missing secrets.
3. Ed25519 key management for public receipts. `exportPublicTrustReceipt()` requires an Ed25519 private KeyObject supplied by the caller (`docs/v5/v5-d3-public-trust-receipt.md:16-17`). No key generation, storage, rotation, or distribution mechanism exists anywhere in the repository; the D3 doc disclaims this by design (no key-distribution service). CONFIRMED BLOCKER, independent of and additional to blocker 1.
4. No non-V5 "real verification" concept exists. The assumption that "the verification step may be reachable" while write-back and publication are blocked does NOT hold. Replacing `decision: 'beta_observation_only'` / `verdict: 'review'` with a computed value requires either (a) a V5-gated verifier (blocked by #1), or (b) inventing a new, currently undefined, non-V5 verification concept for pull requests, which is a product-direction decision that the roadmap owner approves (per `docs/HUQAN_WORK_PROTOCOL.md` P-05), not something an implementation agent may add unasked. The current `beta_observation_only` behavior is also a locked test contract (`test/v5-c7-github-app-beta.test.js:70-77`), not a stub awaiting completion; changing it without a task-pack and without explicit product-direction approval would itself be a protocol violation. THIS STEP IS BLOCKED, CONTRARY TO THE INITIATING ASSUMPTION.

## Decision

All three connection points (real verification, GitHub write-back, public receipt publication) are blocked for reasons that are independent of each other, and none is closable inside this authorization. This task-pack authorizes exactly one pure, unreachable contract artifact for the write-back path -- mirroring the established `external-client-endpoint-contract.js` pattern (`docs/task-packs/external-client-endpoint-0-contract.md`) -- so a future gate has a frozen shape to implement against. It authorizes no runtime wiring, no server route, no GitHub API call, and no change to `lib/github-app-beta-handler.js` or its tests.

## Authorized Files (this PR)

```text
lib/github-app-writeback-contract.js
lib/github-app-writeback-contract.test.js
lib/module-reachability.js   (append one NOT_YET_WIRED entry only)
docs/task-packs/github-app-trust-loop-0-wiring-gap-authorization.md
docs/reports/github-app-trust-loop-blocked-gap.md
```

No other file is authorized in this PR.

## Exact Contract

`buildGitHubAppWritebackContract(env)` is a pure function returning a deeply frozen descriptor with exactly:

```text
contractVersion            = "github-app-writeback-0-v1"
checkRunPath                = "/repos/{owner}/{repo}/check-runs"
issueCommentPath             = "/repos/{owner}/{repo}/issues/{number}/comments"
tokenExchangeReady           (boolean; true only if lib/github-app-beta-auth.js exports createInstallationAccessToken)
writebackReachable           = false (always, under this gate)
verificationSourceReady      = false (always, under this gate; no non-V5 verifier exists)
securityReviewComplete       = false (always, under this gate)
```

It must not call `fetch`, `createInstallationAccessToken`, or any network API. It may only `require('./github-app-beta-auth')` to type-check that the export exists, exactly as `lib/external-client-endpoint-contract.js` inspects shape without calling production code.

## Required Adversarial Tests

1. the descriptor is deeply frozen and contains only the approved keys;
2. `writebackReachable`, `verificationSourceReady`, and `securityReviewComplete` are false under every input, including attacker-controlled/prototype-polluted env;
3. the module does not import `node:http`, `node:https`, `undici`, or any fetch-capable module;
4. `github-app-server.js` and `lib/github-app-beta-handler.js` do not import this contract file (static source assertion, read-only);
5. the exact implementation diff touches only the authorized files above.

## Stop Conditions

Stop and record a blocker if implementation requires:

- calling `createInstallationAccessToken()` or any GitHub REST endpoint;
- registering a route in `github-app-server.js` or `lib/github-app-beta-http-boundary.js`;
- changing `decision`, `status`, or `verdict` in `lib/github-app-beta-handler.js`;
- requiring any `lib/v5/*` module from `github-app-server.js` or any file it reaches;
- generating, storing, or loading an Ed25519 signing key;
- a fifth authorized file.

Any of the above requires a separate, explicitly approved successor gate (GITHUB-APP-TRUST-LOOP-1 or later), not implicit authorization here.

## Definition of Done

1. the five authorized files exist and nothing else changed;
2. the descriptor is pure, frozen, and unreachable from any production entry point;
3. `node --test lib/github-app-writeback-contract.test.js` and `node --test test/module-reachability.test.js` pass;
4. `npm test` shows no new failures beyond the pre-existing, unrelated Windows EPERM failures documented separately;
5. the blocked-gap report (`docs/reports/github-app-trust-loop-blocked-gap.md`) is filed alongside this task-pack.

## Non-Claims

This task-pack does not claim or authorize:

- a closed PR-event-to-public-receipt loop;
- real verification replacing `beta_observation_only`;
- any write-back to GitHub (comment or check run);
- public trust receipt publication or key distribution;
- V5 entry audit completion or override of `V5_IMPLEMENTATION_ENTRY: FAIL`;
- any change to `lib/github-app-beta-handler.js` behavior or its locked tests.
