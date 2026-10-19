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

SUPERSEDED, bkz. Re-check 2026-10-20 @ 1cc4f0db. (Historical verdict at audit base `37f68cfd`: BLOCKED, all three connection points. `GITHUB-APP-TRUST-LOOP-0` was the only closeable increment at that time.)

---

## Re-check 2026-09-10 — this report is stale on two of its three blockers

The audit above was taken at `main @ 37f68cfd`, package version `0.9.1`. Re-checked at
`main @ 8db6f84d`, version `0.12.0`. Three of its four "known gaps" have moved. Recorded
here rather than in a new document so nobody reads the verdict above without this beside it.

| Blocker as recorded | Status on 2026-09-10 | Evidence |
| --- | --- | --- |
| `V5_IMPLEMENTATION_ENTRY: FAIL` stands | **PASS** | `docs/current-operating-roadmap.md:29` |
| "No GitHub write-back code" anywhere | **False now** | `lib/pr-guardian/github-client.js`, `lib/pr-guardian/review-service.js`, `scripts/comment-pr-guardian-block.js` |
| No Ed25519 key management | **Exists** | `lib/receipt/issuer-seal.js`, `lib/receipt/trusted-key-resolver.js`, `lib/issuer-seal-config.js` |
| `beta_observation_only` hardcoded, locked by test | **Still true** | `lib/github-app-beta-handler.js:16` |

The report's central claim — "no partial runtime wiring of the loop is safe to ship" —
rested on all three being blocked at once. That is no longer the situation, so the
verdict above should not be cited as current.

### What is still genuinely missing, restated

One thing, not three: **a defined notion of what "verified" means for a pull request.**
The original report was right that inventing one inside an implementation task would be a
product decision smuggled in as a detail. It remains right about that.

### A candidate definition that does not have to be invented

`lib/coder/verify-derivation.js` answers exactly that question for one class of change:

> A file is verified when re-running its recorded transform against the base tree
> reproduces the file that is in the tree under review.

This is not a new concept needing product sign-off. It is a mechanical property that
either holds or does not, checkable by a party that did not produce the patch, which is
the property the original report said was absent. It covers only derived files, and it
says nothing about the rest of a diff — a narrow answer that is true, rather than a broad
one that would need defending.

`huqan coder verify <record.json> --base <ref>` is the surface. It exits non-zero when the
answer is no.

### Sequencing note

This does not unblock GitHub write-back, and does not touch `beta_observation_only`.
It supplies the missing input to that decision, so the write-back question can be argued
about a concrete verdict instead of a hypothetical one.

---

## Re-check 2026-10-20 @ 1cc4f0db

Yeniden kontrol kaynağı: `origin/main @ 1cc4f0db` (`#4081` sonrası). Bu bölüm
tarihsel metni değiştirmez; yukarıdaki "Verdict" artık güncel değildir.

| Engel (raporun kaydı) | Durum 2026-10-20 | Kanıt (`origin/main`) |
| --- | --- | --- |
| `V5_IMPLEMENTATION_ENTRY: FAIL` | KAPANDI (PASS) | `docs/current-operating-roadmap.md:29`, `:163` |
| GitHub'a geri yazan kod yok | KAPANDI: C8 Streaming Trust check run yazıyor | `lib/github-app-streaming-trust-check-run.js:104-123` (`writeCheckRun`), `lib/github-app-beta-http-boundary.js:110-139` |
| `createInstallationAccessToken()` çağrılmıyor | KISMEN: C8 kendi kopyasını (`createStreamingTrustAccessToken`) çağırıyor; `createInstallationAccessToken` üretimde hâlâ yalnız testten | `lib/github-app-streaming-trust.js:54`, `lib/github-app-beta-auth.js:120`, `test/gateA-outbound-timeouts.test.js:6` |
| PR doğrulama kavramı yok | KAPANDI: C8 değişen dosya metadatasını `evaluateCodeChange` ile değerlendiriyor; derivation doğrulaması PR Guardian tarafında | `lib/github-app-streaming-trust-receipt.js:13`, `lib/pr-guardian/derivation-check.js:23` |
| `beta_observation_only` / `review` her webhook'ta sabit | KISMEN: karar hâlâ sabit (`BETA_DECISION`); verdict artık türetiliyor (`toCanonicalVerdict`) ve `beta_observation_only -> review` eşlemesi tek yerde | `lib/github-app-beta-handler.js:16`, `:131`, `:136`; `lib/verdict/action-verdict.js:47-49`; `test/v5-c7-github-app-beta.test.js:76-90` |
| Ed25519 anahtar yönetimi yok | KISMEN: issuer seal anahtarı var; GitHub App receipt'leri mühürlenmiyor ve public receipt'e çevrilmiyor | `lib/issuer-seal-config.js:28-53` |
| Public receipt'in production çağıranı yok | AÇIK: `exportPublicTrustReceipt` yalnız `scripts/a2a-conformance/run-fixture.js:6,68` tarafından çağrılıyor | `lib/receipt/public-trust-receipt.js:132` (export) |
| Canlı GitHub kanıtı | KAPANDI: #279 kapandı (closure seal PASS). Canlı kanıt: genuine ping, genuine PR delivery, aynı GUID ile idempotent redelivery, check run `101862039574`, installation token create/revoke | Canlı kanıt yorumu: https://github.com/ali-ulu/huqan/issues/279#issuecomment-5575691435 ; kapanış mührü: https://github.com/ali-ulu/huqan/issues/279#issuecomment-5575898097 |

### Satır iddiası düzeltmesi

- Raporun `:136` ve `:158` iddiası artık birebir doğru değil. `lib/github-app-beta-handler.js:136` şimdi `status: 'observed'`, `:158` `appendReceiptToChain(...)` çağrısıdır. `verdict: 'review'` literal'i kalktı; verdict türetiliyor (`:131`).
- `decision` sabiti (`BETA_DECISION`, `:16`) ve `test/v5-c7-github-app-beta.test.js:76-90` kilidi hâlâ geçerli.

### Yazılmamış dosya

`lib/github-app-writeback-contract.js` `origin/main`'de yok. Rapor bu dosyayı "tek kapatılabilir artefakt" diye önermişti. C8 gerçek write-back'i getirdiği için bu sözleşme dosyası artık gerekli değil ve oluşturulmadı.

### Kalan açıklar

- Non-V5 "verified" tanımı: C8 bunu yapmıyor; `lib/coder/verify-derivation.js` için önceki Re-check'teki aday tanım hâlâ geçerli. Ürün kararı olarak açık.
- GitHub App receipt'lerinin Ed25519 ile mühürlenmesi ve public receipt üretimi (`exportPublicTrustReceipt` için üretim çağıranı yok).
- Bu bölüm yeni issue numarası açmaz; izleme `#4084` altında.

### Not: `engineering-foundation-20261002-evidence.json:164`

Bu dosya `fullC8RunVerified: false` alanını `ciRouting` bloğunda taşır. Alan CI yönlendirme (classifier) ölçümünün parçasıdır; GitHub App C8 kanıtını değil. Dosyanın `statusSemantics` alanı kendisini "Immutable local-preparation snapshot" olarak tanımlar. Bu nedenle alan değiştirilmedi. GitHub App kanıtı yukarıdaki #279 linklerindedir.
