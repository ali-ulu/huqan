# GitHub App Trust Loop -- BLOCKED_GAP Evidence Report

## Audit identity

- Repository: `ali-ulu/huqan`
- Package version: `0.9.1` (unchanged)
- Authorization: `docs/task-packs/github-app-trust-loop-0-wiring-gap-authorization.md`
- Exact audit base: `main @ 37f68cfd7b36093b59f72a134e94217315e90daf`
- Audit mode: source/test/roadmap reality check on the PR-event -> verification -> public-receipt -> visible-result loop
- Runtime wiring in this report: none; this report and one pure contract artifact are the entire authorized change

## Executive verdict

BLOCKED. All three connection points needed to close the loop described in the task brief are blocked, each for an independent reason. This is not a single missing function call; it is three separate authorization/credential/product gaps that do not share a fix.

## Evidence classification

### GOZLENDI (observed)

1. `lib/github-app-beta-handler.js:136` and `:158` hardcode `decision: 'beta_observation_only'` and `verdict: 'review'` on every accepted webhook; no conditional branch computes either value from any verification result.
2. `test/v5-c7-github-app-beta.test.js:70-77` asserts exactly those two values. This is a locked test contract, confirmed by reading the assertions, not an inferred stub.
3. `lib/github-app-beta-auth.js:99-160` exports a real `createInstallationAccessToken()`. `grep -rn "createInstallationAccessToken" --include=*.js .` outside `test/` returns only the definition itself; zero production callers.
4. `grep -rln "octokit|check-run|check_run|createComment|checks/create|issues/comments" --include=*.js .` (excluding `node_modules`) returns zero files. No code anywhere writes to GitHub.
5. `lib/github-app-beta-http-boundary.js:168-172` returns `{ ok, duplicate, receiptHash }` as the entire HTTP response body; this is the only thing GitHub's webhook delivery ever receives back.
6. `docs/v5/v5-d3-public-trust-receipt.md:8-9` states in its own status section that V5-D3 adds no HTTP route, CLI command, MCP tool, or key-distribution service.
7. `lib/module-reachability.js:87` classifies `lib/v5/public-trust-receipt.js` as `NOT_YET_WIRED`; `lib/module-reachability.js:86` and `:92` classify `lib/v5/cryptographic-verification-adapter.js` and `lib/v5/verification-core.js` the same way, each with the reason "V5 track; V5 entry audit (#273) has not passed".
8. `docs/current-operating-roadmap.md:29` records `V5_IMPLEMENTATION_ENTRY: FAIL`; `docs/current-operating-roadmap.md:186` lists "GitHub App / Streaming Trust production-ready" as a current non-claim.
9. `github-app-server.js` is itself listed as a production entry point in `lib/module-reachability.js:35`; a require chain from it into any `lib/v5/*` module would make that module reachable per the static analysis in `lib/module-reachability.js`, which `test/module-reachability.test.js` enforces.
10. No Ed25519 key generation, storage, rotation, or distribution code exists anywhere in the repository (checked by reading `lib/v5/public-trust-receipt.js` and its doc; no `KeyObject` source, no key file, no key-service module).

### TURETILDI (derived)

1. Closing the loop needs three independent unblocks, not one:
   - a defined, non-V5, privacy-reviewed notion of "verify a pull request" (does not exist today; inventing one is a product-direction decision, not an implementation detail);
   - GitHub write-back code (Octokit or equivalent call plus route wiring) and a security review of a new outbound mutating capability, on top of the token-exchange code that already exists but is uncalled;
   - the V5 entry audit (#277/V5-C5) passing, plus Ed25519 key generation/storage/distribution, before `lib/v5/public-trust-receipt.js` may gain a production caller.
2. The task brief's initiating assumption -- that the verification step "may be reachable" while write-back and public-receipt publication are blocked -- does not hold. Verification is blocked too, and for a different reason than the other two (no defined non-V5 concept exists, and the current hardcoded behavior is a locked test contract, not a stub).
3. Because all three points are blocked for independent reasons, no partial runtime wiring of the loop is safe to ship under this authorization. Implementing any one of them now would either violate the standing `V5_IMPLEMENTATION_ENTRY: FAIL` gate, add an unreviewed outbound write capability, or make an unauthorized product-direction decision (defining what "verified" means for a PR) inside an implementation task.
4. The one artifact that is safe to ship is a pure, statically-unreachable contract descriptor for the eventual write-back shape (`lib/github-app-writeback-contract.js`), following the precedent set by `lib/external-client-endpoint-contract.js` (see `docs/task-packs/external-client-endpoint-0-contract.md`) of freezing a future surface's shape before any of it is reachable.

## Risk note

Shipping a computed `decision`/`verdict` in `lib/github-app-beta-handler.js` without a defined non-V5 verifier, or shipping a GitHub write-back without a security review of the new outbound capability, or wiring `lib/v5/public-trust-receipt.js` into `github-app-server.js` while `V5_IMPLEMENTATION_ENTRY: FAIL` stands, would each be an unproven product claim resting on an insufficient foundation -- the exact failure mode this repository's work protocol calls out as previously causing a PR retraction.

## Milestone mapping

This report closes the audit half of the CORE-AUDIT -> TASK-PACK -> implementation -> review flow (`docs/HUQAN_WORK_PROTOCOL.md` section 2) for the GitHub App trust loop. It authorizes `GITHUB-APP-TRUST-LOOP-0` (this PR: docs plus one pure contract file) and leaves `GITHUB-APP-TRUST-LOOP-1` (verification concept), `-2` (write-back), and `-3` (public-receipt transport) as separately authorizable successor gates.

## Known gaps

- No non-V5 pull-request verification concept is defined.
- No GitHub write-back code, no security review of that new outbound capability.
- No Ed25519 key management for public receipts.
- V5 entry audit (#277/V5-C5) has not passed; `V5_IMPLEMENTATION_ENTRY: FAIL` stands.

## Dirty root

None. This audit read live source, tests, and roadmap docs only; no unrelated file was touched.

## Verdict

BLOCKED (all three connection points). `GITHUB-APP-TRUST-LOOP-0` (this task-pack's authorized contract-only artifact) is the only closeable increment right now.
