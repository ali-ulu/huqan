# ADR-010 - V5 Ecosystem Boundary and Entry Audit

## Status

Accepted boundary decision.

V5 implementation entry decision:

```text
V5_IMPLEMENTATION_ENTRY: FAIL
```

This ADR completes the `V5-C1` decision/audit surface only. It does **not**
authorize V5 runtime implementation.

## Source Snapshot

This decision was reconciled against live repository state at:

```text
repository: ali-ulu/huqan
package: 0.9.1
main: 75821f6dd4fa2f0efb0fc8669acb9c733954e5c0
```

Source authority follows `docs/agent-canon.md`: live source, tests, exact Git
SHA and current CI evidence outrank roadmap or planning text. A later source
change does not silently turn this FAIL into PASS; a successor audit must record
a new decision.

## Context

HUQAN already contains local trust primitives and bounded V5 library contracts,
but those facts are not equivalent to a shared trust ecosystem.

The repository currently has:

- local graph, provenance, approval, audit and canonical receipt behavior;
- V4 Workbench read/action surfaces with source-backed evidence;
- a now-closed V4-B3 receipt inspection/export user-flow gate;
- bounded V5 package writer/reader/verification code in `lib/v5/`; and
- ATP/Axiom package and conformance lineage in the existing runtime.

The repository does **not** currently have source-backed evidence that V4 has
completed its final closeout or that an external consumer independently passes
the shared-trust conformance boundary.

The controlling open closeout issue is `#272` (`V4-B5`). The external
conformance/runner track is still open under `#277` (`V5-C5`), and the current
connector source-reality matrix records the V5 writer/reader as library-only,
with no production connector caller and no end-to-end production V5 Agent
Identity binding.

## Decision 1 - V4 / V5 Boundary

The phase boundary is:

```text
V4 = local/workbench trust runtime + product-runtime evidence
V5 = portable/external trust exchange + interoperability evidence
```

V4 owns the local product boundary: Workbench inspection, bounded action and
approval behavior, receipt inspection/export, product-runtime smoke and final
source/test/CI/package/release closeout.

V5 begins only when HUQAN is allowed to carry trust evidence across a system,
agent, tool or organization boundary without replacing source-backed evidence
with self-declared trust.

V5 planning documents may exist before implementation entry. Planning is not
implementation authorization.

## Decision 2 - Artifact Status Vocabulary

Every V5 artifact and claim must use one of these meanings:

| Status | Meaning |
| --- | --- |
| `draft` | Exploratory proposal or illustrative shape. It is not a binding runtime contract. |
| `spec` | Accepted deterministic contract or decision. It may exist before runtime wiring. |
| `implementation` | Executable code exists in live source. Reachability must be stated separately. |
| `future` | Intentionally not authorized or not yet implemented. |

`implementation` must never be used as shorthand for `production-reachable`,
`externally interoperable`, or `ecosystem-ready`.

For the current source:

- the V5 planning documents in `docs/v5/` remain `draft`/planning unless a
  narrower accepted decision says otherwise;
- bounded V5 writer/reader/verification modules are `implementation`, but are
  library-only and do not prove production connector enforcement;
- external conformance, public-safe receipt exchange, A2A exchange, GitHub App
  ecosystem wiring, Certified Node and TrustBench remain `future` until their
  own gates pass.

## Decision 3 - Entry Dependencies

The V5 implementation entry gate is evaluated as follows at the source
snapshot above:

| Dependency | Evidence | Decision |
| --- | --- | --- |
| V4 receipt inspection/export user flow | Issue `#271` is closed completed; PR `#588` merged into the source snapshot. | `PASS` for this component |
| V4 final source/test/CI/package/release closeout | Issue `#272` (`V4-B5`) is open and explicitly forbids a V4 stable/complete claim before closeout evidence exists. | `FAIL` |
| External shared-trust interoperability/conformance evidence | No source-backed external consumer/runner PASS is recorded. `#277` remains open, and the connector coverage reconciliation records no production connector invoking Shared Trust Package validation. | `FAIL` |
| Bounded local V5 trust-object primitives | `lib/v5/runtime-writer.js`, `lib/v5/runtime-reader.js` and verification helpers exist, but the connector matrix classifies the writer/reader as library-only with V5 enforcement absent. | `PARTIAL` |
| ATP lineage | `lib/atp-conformance.js` and existing Axiom package validation remain live source. | `PRESENT` |

Therefore:

```text
V5_IMPLEMENTATION_ENTRY: FAIL
PRIMARY_BLOCKERS:
- V4-B5 final closeout is not closed
- external interoperability/conformance entry evidence is not proven
```

A local V5 unit/conformance pass, by itself, cannot satisfy the external
interoperability dependency.

## Decision 4 - ATP / HTP Naming

ATP/Axiom lineage remains the current source-backed protocol/package lineage.

This ADR does not rename ATP to HTP, change package names, change schema names,
or migrate receipts. Any HTP naming or ATP-to-HTP compatibility decision belongs
in the separately reviewed compatibility RFC gate.

Until that RFC exists and passes its own compatibility evidence:

- existing ATP receipts/packages remain ATP/Axiom lineage;
- documentation must not imply that a runtime HTP migration has happened; and
- no compatibility claim may be inferred from branding alone.

## Decision 5 - Marketplace Is Deferred

Marketplace behavior is explicitly deferred and remains a non-goal for V5
entry.

No public agent/service marketplace, package bazaar, public reputation economy,
paid exchange, badge launch or self-declared certification is authorized by
this ADR.

The existing marketplace security planning boundary may describe future
requirements, but it does not make marketplace publish/consume paths safe or
production-ready.

## Claim Audit

### Source-backed claims allowed now

- HUQAN is a local-first partial trust layer.
- V4-B3 receipt inspection/export user-flow work is closed at this source
  snapshot.
- Bounded V5 trust-object writer/reader/verification code exists in live source.
- Those V5 modules are library-level building blocks, not proof of production
  connector enforcement or external interoperability.
- V5 planning/spec work may continue without authorizing ecosystem runtime.
- V5 implementation entry is currently `FAIL`.

### Claims forbidden by this decision

- `V4 is stable/complete` before `V4-B5` closes with exact evidence.
- `V5 implementation is authorized` or `V5 is complete`.
- `all connectors are V5-enforced`.
- `external interoperability/conformance is proven`.
- `Shared Trust Package import/export is production-reachable` merely because
  library modules exist.
- `A2A trust exchange is implemented`.
- `public-safe Trust Receipt exchange is complete`.
- `GitHub App / Streaming Trust is production-ready`.
- `Certified Node`, public badge, reputation economy or marketplace is live.
- `ATP has been renamed/migrated to HTP`.
- local fixtures/tests are external interoperability evidence.

## Re-entry Rule

A successor V5 entry audit may record `PASS` only after live source proves both:

1. `V4-B5` final closeout is closed with source, targeted test, full-suite,
   hardened CI, package/release smoke, limitations and canonical SHA evidence;
   and
2. the external interoperability/conformance entry dependency has a real
   external consumer/verifier smoke with fail-closed invalid/tampered cases.

The successor audit must run against its own exact `main` SHA. It must not reuse
this snapshot's PASS/FAIL rows as current evidence.

## Consequences

- `V5-C1` may close with a `FAIL` implementation-entry verdict because its job
  is to establish the boundary and decision, not to manufacture a PASS.
- V5 planning and narrow contract work may be discussed, but runtime ecosystem
  implementation remains unauthorized while this decision is controlling.
- No runtime file, protocol name, package format or connector behavior changes
  as a consequence of this ADR.
- Any future implementation gate must preserve the draft/spec/implementation/
  future distinction and re-check live source authority.

## Non-Claims

This ADR does not implement or prove:

- V4 final closeout;
- external conformance;
- a production Shared Trust Package transport;
- public receipt redaction/import;
- A2A exchange;
- GitHub App or Streaming Trust;
- Certified Node, TrustBench or marketplace behavior;
- ATP-to-HTP migration;
- V5 ecosystem readiness.
