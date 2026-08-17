# ADR-012 - Audit Evidence and the Admission Decision

## Status

**Accepted.**

```text
AXIS:                      mutation_position
PRE_MUTATION_FAILURE:      fail_closed
POST_MUTATION_FAILURE:     must_be_visible
POST_MUTATION_PROPAGATION: TBD_per_caller_contract
SILENT_CONTINUE:           forbidden
```

This ADR answers one question and refuses to answer more than one:

> **How does a failure to produce audit evidence affect the admission
> decision?**

It is `docs/task-packs/p1d-audit-family-independence.md` verdict 2
(`REFUSAL_VISIBILITY_UNRESOLVED`), separated out as its own unit so that the
eight-call-site kernel chokepoint is not routed against a contract nobody has
written down.

**Nothing is routed here and no code changes.** Accepting this ADR creates
conformance debt, listed below, rather than changing behaviour.

## Source Snapshot

```text
repository: ali-ulu/huqan
main: 0659b362e6c83a6b09c6a949b18f7d6d95a15224
```

Sink-call ledger at this commit: `UNROUTED 20 / ROUTED 24 / TOTAL 44`.

## The distinction this must not lose

**An admission refusal is not an audit write failure.**

The first is a security decision. The second is a problem persisting the
evidence *of* a decision. Collapsing them — binding every audit failure to one
exception, or treating every refusal as an evidence gap — would make one
unreadable in terms of the other.

But they are not independent either, and the question that connects them has to
be answered on purpose rather than inherited:

> Is a mutation acceptable when the system cannot prove the security decision
> that allowed it?

## Finding 1 — the contract already exists, for one holder, undocumented

`lib/cli-mutation-gate.js` (#760) has already answered this question, and it
answered it **by the audit write's position relative to the mutation**, not by
which subsystem it belongs to.

| Position | Behaviour on audit failure | Source |
|---|---|---|
| **Before** the mutation (`phase: 'attempted'`) | **Blocks it.** `if (!audit.auditRecorded) return blockedByAudit(...)` | `lib/cli-mutation-gate.js:115` |
| **After** the mutation (`commitCliMutation`) | **Reports it.** Returns a warning string; the command stands | `cli.js:800-805` |

Both halves state their reasoning in source, and the two reasons are opposites
of each other *because the position is opposite*:

> "Persisting without its audit record is the fail-open this gate exists to
> prevent, so an unwritable audit stops the write (#760)." — `cli.js:667`

> "Its failure is reported, not fatal: the state change already happened, so
> refusing it here would only hide it (#760)." — `cli.js:799`

This is a coherent product contract. It is also invisible: it lives in one
module's comments, is not stated as a rule, and nothing checks that any other
holder follows it.

## Finding 2 — every audit write in scope classifies cleanly by position

Applying that same test to the rest of the family. "Pre" means no mutation has
happened yet — including the case where the write *records a refusal*, so no
mutation will happen at all. "Post" means the state change is already durable.

| Holder | Position | On failure today | Consistent with finding 1? |
|---|---|---|---|
| `lib/cli-mutation-gate.js` (attempted) | pre | blocks | — (it *is* the contract) |
| `cli.js` `_commitCliMutation` | post | reports | — |
| `agent.v3.js` `_recordBudgetAuditEvent` | pre (records a refusal) | swallows | **no** — a pre-mutation failure that does not block |
| `lib/workbench/ingest-approval-audit-writer.js` | post | throws → `AUDIT_EVIDENCE_MISSING`, `retry: false` | **yes** — reports, does not undo |
| `kernel.js:359, 374, 597, 613` | pre (records a refusal) | swallows | **no** |
| `kernel.js:796` | pre (records a refusal, after rollback) | swallows | **no** |
| `kernel.js:392, 641, 912` | post (after `addNode`/`addEdge`) | swallows | **partially** — reports nothing at all |

Two things fall out of this table, and neither was visible before it was built.

### The kernel chokepoint straddles both positions

`_appendAuditEvent`'s eight call sites are **five pre-mutation and three
post-mutation**. They are not one contract wearing one method — they are two
contracts sharing one method.

This is the concrete reason the ordering matters. Routing `_appendAuditEvent`
as a single unit would necessarily impose one error contract on both, and
either choice is wrong for one half of the call sites: blocking on a
post-mutation failure hides a completed write, and swallowing on a
pre-mutation failure is the fail-open #760 was raised to close.

### `agent.v3.js` is the one genuine inconsistency

Its budget audit is a **pre-mutation** write that swallows failure. Under the
CLI contract that is a fail-open — but a mild and bounded one, and it is worth
being precise rather than alarming about it: what is lost is the *evidence of a
refusal*, and the refusal itself still happens. Nothing becomes permitted that
was not permitted. What is lost is the ability to show later that AB10 fired.

## Decision

**A — accepted. The axis is mutation position, not the caller or module.**

> Audit failure semantics are determined by the audit write's position relative
> to the mutation, not by which caller or module performs it.

```text
PRE-MUTATION
    audit evidence failure -> the mutation MUST NOT proceed

POST-MUTATION
    audit evidence failure -> the mutation MUST NOT be undone,
                              and MUST NOT be hidden
```

Position is the axis because it is a property of the code the rule governs
rather than of who wrote it: a new call site classifies itself, and the
classification is mechanically checkable. Finding 2 is the evidence that it
partitions cleanly — every write in the family falls on one side, and the 5/3
split inside `_appendAuditEvent` is the proof that the axis cuts *through*
modules rather than between them.

**B — decided in part, and deliberately not further.**

| Case | Decision |
|---|---|
| Pre-mutation audit failure | **Fail closed** |
| Post-mutation audit failure | **Must be visible** |
| Exact post-mutation propagation | **TBD — per caller contract** |
| Silent `continue` (B3) | **Forbidden** |

### The distinction this rests on

> **"Must be visible" is not "must throw."**

B1 (surface as a bounded error state) and B2 (report alongside success) are
both ways of being visible, and this ADR does **not** choose between them. The
draft recommended a rule — B1 where a receipt or reconciliation identifier is
issued, B2 elsewhere — and that rule is **not adopted**: it is not yet proven
general. #883's MCP finding is exactly why. There, an already-B1 write is
flattened by the transport into a generic code, which shows that "which
propagation is right" is a question about the caller's contract and its
transport, not one that the audit position can answer on its own.

Binding the two together now would tie audit evidence to the error API for no
demonstrated benefit, and would have to be untied later.

What **is** decided is the floor: B3 is forbidden. A post-mutation audit
failure that is swallowed makes the absence of evidence invisible, which is the
one outcome that renders an audit trail unfalsifiable. Everything above that
floor stays open.

### Consequence: `_appendAuditEvent` is no longer one routing unit

This ADR structurally splits it:

```text
5 PRE sites   (kernel.js:359, 374, 597, 613, 796)
    -> admission / fail-closed semantics

3 POST sites  (kernel.js:392, 641, 912)
    -> visible audit-evidence failure
       (exact propagation TBD)
```

Counting `kernel.js` only. See the correction under "Conformance debt": the
chokepoint's full production reach is 8 pre and 9 post across three files.

The earlier plan — "route all eight through one chokepoint" — is superseded.
Not because it was inconvenient, but because the two halves now have different
contracts, and one change cannot satisfy both.

## Conformance debt

Accepting this ADR does not change behaviour. It converts three readings from
"inconsistent" into "known non-conformant", which is a stronger statement and
is why they are listed rather than left in prose:

| Site | Position | Today | Required | Gap |
|---|---|---|---|---|
| `kernel.js:359, 374, 597, 613, 796` | pre | swallows | fail closed | ~~fail-open~~ **evidence only** |
| `kernel.js:392, 641, 912` | post | swallows | visible | **B3, forbidden** |
| `agent.v3.js` `_recordBudgetAuditEvent` | pre | swallows | fail closed | ~~fail-open~~ **evidence only** |

> **Corrected by `docs/task-packs/p1g-pre-site-source-reality.md`.**
>
> **"Fail-open" was the wrong label for the pre sites.** A fail-open means
> something gets through. Nothing gets through at any of them: all six are
> refusal-recording branches, the mutation is decided against before the audit
> is attempted, and the refusal is carried by the return value or the throw.
> Measured by running them against a throwing audit sink, not by reading.
>
> They are **conformant on enforcement** and **non-conformant on evidence** —
> the wording this ADR already used for `agent.v3.js` and should have used for
> all six. The fix is real but smaller and differently shaped than "make them
> fail closed": they are already closed.
>
> **The chokepoint has 17 production call sites, not 8.** The count below is
> only those inside `kernel.js`. `_appendAuditEvent` is also called from
> `lib/learn-use-case.js` (3 pre, 4 post) and `lib/conflict-detector.js`
> (2 post), for 8 pre and 9 post in production; `lib/github-connector.js` also
> reaches it and is `NOT_YET_WIRED`. The axis decision is unaffected — every
> additional site classifies cleanly by the same test — but step 2 is nine call
> sites across three files, not three in one.

The `agent.v3.js` gap is bounded and it is worth staying precise about it: what
is lost is the *evidence that AB10 refused*, not the refusal. Nothing becomes
permitted that was not permitted. It is still a fail-open under this contract,
and its caller contract is evaluated on its own — see step 3 below.

Conformant already, and unchanged by this ADR: `lib/cli-mutation-gate.js`
(pre, blocks), `cli.js` `_commitCliMutation` (post, reports),
`lib/workbench/ingest-approval-audit-writer.js` (post, surfaces).

## Implementation order

Each step is its own unit, and none of them is authorized by this document
beyond its position in this list.

1. **The 5 pre sites** -> fail closed.
2. **The 3 post sites** -> remove the silent swallow; measure the propagation
   contract separately rather than choosing it here.
3. **`agent.v3.js`** -> evaluated against its own caller contract.
4. **`lib/cli-mutation-audit.js`** -> evaluated against the #760 contract it
   already participates in.
5. **The MCP flattening** -> its own small decision. Not patched ahead of the
   rule.

## What this ADR does not decide

- It does not decide whether admission refusals and audit failures share a
  vocabulary. They stay distinguishable regardless of what is chosen above.
- It does not decide the MCP surface's flattening of `AUDIT_EVIDENCE_MISSING`
  to `APPROVAL_EXECUTION_FAILED` (recorded in `p1d`). It is step 5, and it is a
  caller-contract question, not one the position axis settles.
- **It does not require any site to throw.** Visibility is the requirement;
  the mechanism is the caller's contract.
- It does not authorize routing anything. `kernel._appendAuditEvent`,
  `agent.v3.js` and `lib/cli-mutation-audit.js` stay unrouted; the
  implementation order above says in what order that is taken up, not that it
  is approved.
- It does not claim the classification in finding 2 is permanent. It is pinned
  by `test/audit-evidence-position.test.js`, which asserts the code as it is
  today -- including the three non-conformant sites -- so that the debt above
  is measured rather than asserted, and a new audit write cannot join the
  family unclassified.
