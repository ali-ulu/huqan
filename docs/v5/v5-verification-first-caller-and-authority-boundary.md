# P2 Child 2 — First production caller and authority boundary

**Status:** `spec`

**Parent issue:** #847

**Child issue:** #875

**Mode:** Docs-first task pack only. This document authorizes no implementation; the wiring PR is a separate, single-purpose unit.

**Canonical base:** `main @ 50faaec879bc3fbb0df70a133bf6e140dac50362`

## 1. Source reality: what the five modules actually do

Read from live source at the canonical base. All five are pure, require-free libraries (except `shared-trust-package-validator.js`, which requires only its own schema JSON and `node:fs`): no network, no clock, no store, no mutation of caller input.

| Module | Lines | Exports | Actual job |
|---|---|---|---|
| `lib/v5/runtime-writer.js` | 285 | `validateWriterInput`, `writeRuntimePackage` | Validates writer input shape, then **builds** a package object in memory. `writeRuntimePackage` writes to nothing — it returns `{ok, verdict: 'ACCEPT', reason_category, package}`. |
| `lib/v5/runtime-reader.js` | 299 | `validateReaderCandidate`, `readRuntimePackage` | Read-side mirror: validates a candidate against the same schema and returns an expanded package object. Reads nothing from storage. |
| `lib/v5/verification-core.js` | 294 | `normalizeCryptographicVerificationEvidence`, `evaluateBoundedVerification` | Bounded verification only. Output is `{verificationStatus, reasonCategory}` — **status, not trust, not authorization**. Fail-closed on every malformed or missing-evidence path. |
| `lib/v5/structural-signing-helper.js` | 304 | `validateStructuralSigningInput`, `prepareStructuralSigning` | Test-structural signature preparation (`test-structural-v1`); a fixture/scaffold aid, not a cryptographic authority. |
| `schemas/v5/shared-trust-package-validator.js` | 297 | `validateSharedTrustPackage`, `validateSharedTrustPackageFile` | Validates the full `v5-shared-trust-package/v0.1` schema (`schemaVersion`, `packageId`, `issuer`, `subject`, `verdict`, `receipt`, `evidence`, `routeReceipt`, `reasoningMetadata`, `nonClaims`). It is the validator for the package **the writer builds**. |

Two consequences that shape the caller decision:

1. **Writer and validator are the natural pair.** `runtime-writer`'s `buildPackage` emits the exact shape `shared-trust-package-validator` consumes, and the schema is the one surface in the #847 work list with a self-contained validator (the issue body names Shared Trust Package import/export as the strongest candidate for this reason).
2. **The writer already enforces the receiver-owned rule.** Its input rejects forged claims (`unsigned_but_claimed_signed`), unknown verdict statuses, and anything outside the bounded key paths. The boundary a caller must cross is therefore legible at the code level, not invented for this pack.

## 2. Decision: the first production caller

**`POST /api/v5/packages` — Shared Trust Package import — as the single first caller.** It consumes, in order:

```text
shared-trust-package-validator   (is it a valid package?)
      ↓
verification-core.evaluateBoundedVerification   (is the evidence acceptable?)
      ↓
runtime-writer.writeRuntimePackage              (build the bounded package object)
```

Read-side (`runtime-reader`) stays out: import is the authoritative write direction, and importing "the most files" was explicitly rejected as an ordering heuristic in #847's decomposition comment. Export, Route Receipt write contract, snapshots, atomicity, outbox and replay are all later, separately bounded units.

Justification against #847's work list: this is the import half of the first listed item, exactly the item the list marks as the strongest candidate, and it is the only candidate whose validator lives in the same package family — the wiring PR can be checked end-to-end against one schema, one verification contract, and one writer contract, with no transaction story invented for it.

### The two stop conditions

1. **No defensible single first caller exists** at wiring time (e.g., a real import surface cannot be bounded without dragging in durability or atomicity): the implementing PR must report this as a blocked outcome rather than widen the surface. This pack does not pre-authorize that widening.
2. **Discovery/registry surfaces** would make a more honest first caller only after #876's record shape exists. This pack therefore blocks the wiring PR from being a registry entry point; registry consumption of packages is a later unit.

## 3. The authority boundary

The caller crosses exactly one authority line: **a package is admitted only when its issuer identity is resolved through the receiver's own trust authority, never through anything in the request body.**

| Boundary element | Who decides | Never comes from |
|---|---|---|
| Issuer key trust | receiver via `lib/v5/trusted-key-resolver.js` | request body, self-assertion |
| Allowed packages / allowlists | receiver policy | request body |
| Clock | receiver server time | request body, package fields |
| Verdict vocabulary | canonical `allow / review / dry_run_only / block` | caller-invented statuses |
| Verification evidence | `verification-core` fail-closed contract | claims such as `packageTrust`, `actionAuthorization` |

The shape of a rejected package (fail-closed) is fixed by the existing contracts, and this pack does not amend it: an unverifiable or malformed package returns an explicit rejection result with a bounded `reasonCategory`; nothing is partially admitted, nothing is persisted on rejection, and a rejection must never read as a misleading success (no 5xx dressed as 2xx, no `ok: true` on a blocked verdict).

`runtime-writer` already rejects unsigned-but-claimed-signed inputs and unsupported verdict statuses; `verification-core` already rejects forbidden key material and non-evidence claims. The wiring PR's authority job is only to ensure these library rejections are the admission decision — no default-to-accept path around them.

## 4. The route contract the wiring PR will be checked against

```text
POST /api/v5/packages            (in lib/http/route-auth-policy.js::AUTHENTICATED_ROUTES — not public)
  → auth via route-auth-policy (receiver-owned identity)
  → validateSharedTrustPackage        (schemas/v5/shared-trust-package-validator.js)
  → evaluateBoundedVerification       (lib/v5/verification-core.js)
  → writeRuntimePackage               (lib/v5/runtime-writer.js)
  → persist via the existing V4 journal family only; no new store
```

**Exact file list the wiring PR may touch:**

- `lib/http/routes/...` (the single new route handler; name must not advertise export, registry, or replay)
- `lib/http/route-auth-policy.js` (one registry entry — public surface stays unchanged)
- `lib/journal/...` or the existing V4 receipt-family entry point reused for the persistence step
- one test file, plus doc/task-pack updates

**Forbidden in the wiring PR:** any change to the five library modules above, to V4 wire formats, to `module-reachability.js`'s NOT_YET_WIRED acknowledgements (ledger graduation happens only as a consequence of a real caller being proven reached by tests), to `POST /api/a2a/exchange`, or to any discovery/registry/observability surface.

## 5. Acceptance preview (binding only in the wiring PR)

The implementing PR must prove by tests: an authentic package imports and persists through the V4 journal family; a malformed, unsigned-but-claimed-signed, expired-key, or forged-issuer package fails closed with a bounded reason; a `verified` evaluation result alone does not imply admission (verification status is not trust); rejections leave no durable trace of the package body; and module-reachability plus `check-doc-status` stay green. This preview exists to keep the wiring PR single-purpose; the actual acceptance criteria live in the wiring PR's own task pack.

## Non-claims

This document does not claim that a production caller exists today, that the caller chosen here is final, that persistence semantics (atomicity, outbox, replay) are defined, or that export has any shape. It claims only that the first-caller decision and its authority boundary are made explicitly, on source reality at `main @ 50faaec`, before any wiring starts.
