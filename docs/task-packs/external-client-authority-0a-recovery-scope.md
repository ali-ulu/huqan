# EXTERNAL-CLIENT-AUTHORITY-0A - Package Surface and Boundary Recovery

## Plan Check

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact scope-amendment base: `main @ 81203953cb651e8b979783105244126d11ef4ac6`
- Blocked implementation PR: `#177`
- Frozen blocked head: `1fb6e2f4d3e0fc1c6d45e241edb652b2aa05a2fb`
- Amends: `docs/task-packs/external-client-authority-0.md`
- Mode: docs-only recovery scope definition
- Reachable route, persistence, mutation and production V2 writer: forbidden

## Source-Reality Blockers

PR #177 cannot merge at its frozen head.

1. `lib/sdk.js` requires `./external-client-authority`, but the package `files`
   allowlist omits `lib/external-client-authority.js`. The installed-tarball
   deep-import smoke therefore fails with `MODULE_NOT_FOUND`.
2. A trusted-key entry is not checked against an exact own-key allowlist. A
   valid public-key entry can silently carry an additional `privateKey`, an
   unknown own property or a symbol property.
3. The exported authority function verifies a caller-owned package and then
   separately rereads `manifest.createdAt`. A getter or proxy can make the
   freshness value differ from the signed package value.
4. `createAxiomClient(kernel)` treats the mere presence of
   `kernel.admitExternalPackage` as complete Authority-0 configuration. That
   can break callers that use only non-package SDK methods.

The first blocker requires `package.json`, which the original task-pack
forbids. This amendment is therefore required before any implementation
recovery commit.

## Authorized Recovery Files

After this docs-only amendment is independently reviewed and merged, PR #177
may be reconciled onto the new canonical `main` and may contain exactly:

```text
lib/external-client-authority.js
lib/external-client-authority.test.js
lib/sdk.js
lib/sdk-external-package.test.js
package.json
```

The first four paths retain their original Authority-0 ownership.
`package.json` is newly authorized only for one additive `files` entry:

```text
lib/external-client-authority.js
```

No other `package.json` field may change. `package-lock.json` must remain
unchanged.

## Required Recovery

### Package surface

- Add the new authority module to the existing package `files` allowlist.
- Preserve package version, scripts, dependencies, entry points and export-map
  state.
- Prove that an installed tarball can load `huqan/lib/sdk` and the retained
  deep-import surface.

### Exact trusted-key entry boundary

Each trusted-key entry must reject every own key outside this exact set:

```text
publicKey
workspaceId
packageIds
identitySubjects
identityKinds
notBefore
notAfter
revoked
```

Unknown string keys, `privateKey`, symbol keys, inherited fields and accessor
descriptors fail closed before signature, replay or handler side effects.
Existing rejection of private-key material supplied as `publicKey` remains
unchanged.

### Signed freshness binding

The authority boundary must use one deterministic package snapshot for both:

1. package signature and scope verification; and
2. `manifest.createdAt` freshness validation.

It must not reread caller-owned package state after verification. Getter,
proxy, mutation or descriptor changes cannot make freshness differ from the
signed bytes. The SDK may keep its existing snapshot, but direct callers of
the exported authority function receive the same protection.

### SDK construction compatibility

Creating an SDK client for non-package methods must not require Authority-0
configuration solely because the supplied Kernel exposes an
`admitExternalPackage` method.

Authority-0 configuration remains fail-closed when package-admission options
are explicitly supplied or package admission is invoked. This recovery must
not create an implicit handler, permissive fallback or reachable route.

## Required Adversarial Tests

The recovery must add tests proving:

1. trusted-key entries with `privateKey`, unknown string, symbol, inherited or
   accessor-backed fields fail before replay reservation and handler calls;
2. a getter or proxy cannot present one signed `createdAt` to the package gate
   and another value to freshness validation;
3. direct authority calls and SDK calls bind freshness to one immutable
   package snapshot;
4. `createAxiomClient(kernel)` remains usable for non-package SDK methods when
   the Kernel exposes `admitExternalPackage` but no Authority-0 options exist;
5. calling package admission without exact authority configuration still
   fails closed;
6. handler ordering, replay reservation and all original Authority-0 negative
   cases remain unchanged;
7. the packed artifact contains `lib/external-client-authority.js` and loads
   `huqan/lib/sdk` successfully.

## Required Validation

```text
node --test lib/external-client-authority.test.js
node --test lib/external-client-package-gate.test.js lib/sdk-external-package.test.js lib/external-client-endpoint-contract.test.js
node --test test/kernel-facade-contract.test.js
npm pack --dry-run
npm test
git diff --check
git status --short
```

Exact-head Security Checks and Benchmark Regression must both succeed before
merge. A skipped or failed runtime test is not green evidence.

## Forbidden Scope

```text
server.js
kernel.js
graph.js
receipt writers or schemas
route registration
HTTP parsing or authentication
replay-store persistence implementation
package-lock.json
dependency, version, script or export-map change
production V2 writer selection
historical receipt rewrite or backfill
release or deployment change
```

No sixth implementation file is authorized.

## Stop Conditions

Stop if recovery requires:

- any implementation file outside the five authorized paths;
- more than one additive package `files` entry;
- weakening exact authority, key, freshness, replay or handler ordering;
- new public API, error code, configuration, dependency or product behavior;
- a reachable external endpoint, mutation path or receipt writer;
- force-push, squash of evidence, or merge before exact-head CI and independent
  adversarial review are green.

## Successor

PR #177 remains unmerged until this amendment closes, the implementation is
reconciled onto the new canonical base, all four blockers are fixed, package
and full regression tests pass, and the corrected exact head receives a fresh
independent review.

`EXTERNAL_CLIENT_ADVERSARIAL_0_AUTHORIZATION` remains closed until Authority-0
implementation merge, post-merge smoke and checkpoint reconciliation are
green.

## Non-Claims

This amendment does not implement or prove a reachable endpoint, HTTP client
authentication, durable replay storage, mutation, production receipt writing,
V2 trust-root writer ownership, external interoperability, V4 completion or
V5 ecosystem completion.
