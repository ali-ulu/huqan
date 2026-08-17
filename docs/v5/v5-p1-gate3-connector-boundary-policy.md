# V5 P1 Gate 3 — Connector Boundary Policy

**Status:** `spec`

**Parent issue:** `#846` (P1, agent identity enforcement chain). Gate 3 of
the eight gates named in
`docs/v5/v5-agent-identity-closeout-audit.md`.

**Child issue:** none assigned yet; this document is the task pack. The
implementation unit is a separate, single-purpose PR and is **not**
authorized here.

**Mode:** Docs-first task pack only. No implementation, no new tests, no
wiring. This document changes exactly one file.

**Canonical base:** `main @ 1015d53` (merge of PR `#896`). A successor
must re-verify its own exact SHA.

## 1. Source reality

Read from live source and merged documents at the canonical base.

### 1.1 What the threat model assigns to this gate

`docs/v5/v5-p1a-identity-threat-model.md` closes its connector-boundary
section with two separable problems and an explicit deferral:

- **Credential lifecycle** — revocation, expiry, rotation, and
  compromised-credential behaviour — *does not exist*, and
  "credential lifecycle enforcement … is deferred to Gate 3".
- **Structural boundary scope** — the threat model records the split
  between the structural boundary ("which connector may be used, which
  capability is open") and the lifecycle family, and defers the
  implementation-scope decision to this gate as well.

The threat model's known-gap wording is precise: *"Connector boundary
exists as a package allowlist only."* That is the entire current
surface. Everything else this pack must define is absent by inspection.

### 1.2 The enforcement contract the policy inherits

The threat model fixes the evaluation predicate and its order:

```text
valid → boundTo → notExpired → withinDelegationScope → connectorContextIntact
```

Two properties of that order bind this gate directly:

- **`notExpired` is a fact about the evaluation, not the document** —
  `evaluationTime` is a receiver-owned clock input, and a receipt must
  name the clock it was judged against. Any connector-boundary policy
  that checks expiry against a time taken from the payload reopens the
  claim-validation row of the threat table.
- **`connectorContextIntact` is the only row a connector boundary
  catches.** A valid claim with a broken connector context passes every
  other control. The policy this gate writes must not treat the row as
  optional or collapsible.

The reason namespaces are already fixed: `connector.context_invalid`
and `connector.revoked`. Growth rules: a control family must never fall
through to a generic denial, and the vocabulary grows under review. The
policy may add sub-reasons only under those rules.

### 1.3 Existing evidence and its limits

The A2A exchange surface carries conformance-tested negative cases
(`workspace_confusion`, `revoked_source_key`, `delegation_chain_invalid`,
etc.) — 50 cases, but only at **exchange acceptance**, only for the
canonical `default` workspace, only for a single caller. The threat
model restates the distinction this pack must keep honest: conformance
validator evidence is not runtime enforcement evidence. The connector
coverage matrix (`docs/v5/v5-connector-coverage-matrix.md`) records the
same gap per path — the GitHub/repo action path reads "GitHub App/repo
trust path not proven in V5", the HTTP protected mutation path reads
"no V5 protected mutation connector coverage".

### 1.4 What exists today on the connector surface

- `lib/github-connector.js` — an ingestion module: candidate routing,
  idempotency keys, audit append. **No credential lifecycle code** — no
  revocation, no expiry evaluation, no rotation handling.
- `lib/github-app-beta-*` — the GitHub App boundary (app-id, JWT,
  webhook secret). It is a *transport* boundary for `#279`/`#292`, not a
  policy surface; the app's live installation remains stalled by the
  user's one-week deferral.
- `lib/a2a/bounded-exchange.js` — the working precedent for evaluation
  order and identically-readable refusal reasons.
- No module today implements `connectorContextIntact` beyond the package
  allowlist, and the registry wiring that would hold revocable connector
  credentials shares the `#848` receiver-held-card blocker
  (`A2A_AUTHORITY_FILE` unset in production).

## 2. The decision

Gate 3 writes the **connector boundary policy** — what must be
enforced — without choosing where (Gate 2 keeps hook selection) and
without implementing enforcement. The policy has three parts:

### 2.1 Structural boundary rule

A connector boundary policy must first name what "a connector" is per
path family, because the structural boundary is what makes the lifecycle
family meaningful: a credential's revocation only matters inside the
set of capabilities the credential may act through. The policy declares:

- The boundary is **path-based, not connector-based**: every
  classification follows the connector coverage matrix's path families
  (MCP tools, CLI, HTTP routes, local file tools, GitHub/repo, browser,
  memory adapters, external SaaS, A2A, marketplace, workbench) — a
  connector is any surface that reaches mutation through one of those
  paths.
- Each path declares, in the matrix's existing vocabulary, whether
  connector context is required for mutation — `docs_only` paths stay
  `docs_only`; nothing graduates a path by policy alone.

### 2.2 Credential lifecycle rule

The policy adopts the threat model's four lifecycle events as its
complete event set — **revoke, expire, rotate, compromised-credential
behaviour** — and fixes the semantics of each:

- **Revoke** is fail-closed and immediate in observation: after
  `revokedAt`, every later evaluation returns
  `connector.revoked`; no generic denial may substitute; an
  unresolvable revocation record rejects whole (mirroring
  `#896`'s revocation record contract).
- **Expire** is evaluated against `evaluationTime` on the receiver
  clock; a credential whose expiry is supplied in the payload is
  treated as malformed (`connector.context_invalid`), never as
  honoured.
- **Rotate** is a replacement event, not a grant: a rotated credential
  inherits only the prior credential's bounded scope; the rotation
  record itself must be unforgeable in the same way a revocation
  record is (exact key set, forbid private material — the
  `FORBIDDEN_FIELDS` discipline carries over).
- **Compromised-credential behaviour** is the strongest event: it
  carries an implicit revoke of the compromised credential and a
  mandatory replay check over its lifetime (the `replayed`/
  `persisted` receipt flags of the conflict detector are the
  observation tool; the replay owner is `lib/a2a/replay-store.js` —
  no second store).

### 2.3 Evidence rule

Every connector-boundary decision must emit evidence linkable to a
Trust Receipt under the fixed namespaces — `connector.context_invalid`,
`connector.revoked` — and every refusal must name which control engaged,
per the threat model's no-fallthrough rule. A decision the evidence
plane cannot record is a decision the policy does not authorize.

**Two deliberate non-decisions** this gate keeps:

- **Hook location** stays Gate 2's — the policy is written so that
  `module-reachability.js` can verify any candidate hook against its
  four criteria (before-mutation, single entry, fail-closed,
  receipt-linkable) without re-reading this pack.
- **Identity-plane vs transport-plane split** stays explicit: the
  trusted-key resolver's record states govern *claims*; this policy
  governs *connector credentials*. One resolver, one vocabulary, but
  two distinct subjects — the registry card blocker applies to the
  resolver's surface, not to this policy's definition of events.

## 3. What the implementation unit may do

**Allowed**, in exactly this order — a single bounded PR whose subject
is the policy's *shape* as executable contract, not enforcement on any
path:

1. A bounded `connectorBoundaryPolicy` module (or equivalent home): the
   three rules above as pure, deterministic functions — path
   classification, lifecycle event validation, and decision vocabulary
   — with no side effects, consistent with the writer kernel
   discipline of `#894`/`#895`.
2. One conformance test set asserting the lifecycle semantics by the
   four events (revoke → `connector.revoked`; in-payload expiry →
  `connector.context_invalid`; rotation inherits bounded scope;
   compromised → revoke + replay check), and one assertion that the
   policy module emits no side effects.
3. A connector coverage matrix amendment recording the policy's
   path-family declaration, using the matrix's existing status
   vocabulary — no path graduates.

**Forbidden:**

- any change to `lib/v5/trusted-key-resolver.js`, the package schema,
  the receipt plane, the writer/reader kernels, `audit-log`, `ingest`,
  `storage.js` lookups, the A2A exchange, `replay-store.js` beyond the
  read-keys contract, tracing, metrics, or logging semantics;
- enforcement on any production path (MCP, CLI, HTTP, GitHub, browser,
  marketplace) — paths stay at their current matrix status until their
  own wiring PRs;
- a hook choice, a registry table, an outbox, or a second key authority;
- any decision that treats `connectorContextIntact` as optional or
  collapsible into another control;
- expiry honoured from payload-supplied times.

## 4. Acceptance preview (binding only in the implementation unit)

1. The policy module is pure: same inputs, same outputs, no side
   effects, no environment reads.
2. All four lifecycle events have failing-on-violation conformance
   tests; refusal reasons read identically in the conformance output
   and the API response (the bounded-exchange precedent).
3. `lib/module-reachability.js` can verify a candidate hook's four
   criteria against this policy without code changes elsewhere.
4. File-size, cycle, status-declaration, and acyclicity checks stay
   green; touched files stay within their ratchet limits; tarball smoke
   tests (`4C1`) and module reachability stay green; the 4437-test
   suite stays green; no ledger graduation happens.

## 5. Invariants

1. One key authority, one lifecycle vocabulary, one replay store — the
   split is subject-level (claims vs connector credentials), not
   vocabulary-level.
2. Fail-closed in both directions: an unresolvable credential state
   rejects, and an unresolvable lifecycle record rejects whole; neither
   failure opens anything.
3. The policy defines *what*, never *where*: hook selection remains
   Gate 2's evidence comparison.
4. The registry's receiver-held-card blocker is not worked around —
   the policy's events and evidence shape are defined now so the wiring
   can proceed the moment its own unit reopens.
5. Observability adds no new authority; evidence records decisions, it
   never changes them.

## 6. Non-claims

This record does not claim that connector identity enforcement exists
anywhere; that any connector credential has been revoked, expired, or
rotated; that the GitHub App boundary (`lib/github-app-beta-*`) is
covered by this policy — its trust path is the `#279`/`#292` subject and
stays outside this gate; that `connectorContextIntact` is implemented on
any path; or that this pack authorizes enforcement. It also does not
claim the A2A negative-case evidence proves mutation enforcement — the
threat model's own known-gap wording says it does not.

## 7. Gate order

- [x] Gate 1 — identity enforcement threat model (`v5-p1a-identity-threat-model.md`)
- [ ] Gate 2 — runtime hook location and fail-closed behavior
- [x] Gate 3 — connector boundary policy (this task pack, docs-only)
- [ ] Gate 4 — workspace binding and delegation policy
- [ ] Gate 5 — revocation / expiry behavior
- [ ] Gate 6 — Trust Receipt linkage requirements
- [ ] Gate 7 — conformance fixtures for enforcement behavior
- [ ] Gate 8 — rollback and migration plan

Note: Gate 5's title overlaps this gate's credential lifecycle rule.
This pack defines the *events and evidence shape*; Gate 5 remains the
runtime behaviour specification, and its successor must reconcile with
the namespaces and event semantics defined here rather than re-define
them.
