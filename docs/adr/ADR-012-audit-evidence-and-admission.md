# ADR-012 - Audit Evidence and the Admission Decision

## Status

**Draft — decision not taken.**

```text
CONTRACT_EXISTS_IN_SOURCE: yes, partially, undocumented
CONTRACT_GENERALIZED:      no
DECISION_REQUIRED_ON:      post-mutation audit failure surfacing
```

This ADR answers one question and refuses to answer more than one:

> **How does a failure to produce audit evidence affect the admission
> decision?**

It is `docs/task-packs/p1d-audit-family-independence.md` verdict 2
(`REFUSAL_VISIBILITY_UNRESOLVED`), separated out as its own unit so that the
eight-call-site kernel chokepoint is not routed against a contract nobody has
written down.

**Nothing is routed here and no code changes.** This is a decision document.

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

## The decision to take

Finding 1 supplies a rule for both positions and the repository already follows
it in three of seven places. Two questions remain genuinely open, and only the
second is hard.

**Question A — is position the right axis?** The alternative is per-holder
decisions. Position is proposed because it is a property of the code the rule
governs rather than of who wrote it, so it can be checked mechanically and a
new call site classifies itself.

**Question B — what does a post-mutation audit failure owe the caller?** Three
behaviours exist in the repository today for the same position:

| Option | Behaviour | Cost |
|---|---|---|
| **B1 — surface it** | throw / return a reconciliation state, as the ingest writer does | every post-mutation caller must handle a new outcome |
| **B2 — report it** | return a warning alongside success, as `_commitCliMutation` does | callers may ignore it; it is advisory |
| **B3 — record it** | swallow, log, continue, as the kernel does | the gap is invisible to anyone but an operator reading logs |

These are not equally good, but they are not simply ranked either: B1 is right
where a receipt claims to prove something, and disproportionate where the audit
line is a trace rather than evidence.

The recommendation, offered as one and not as a conclusion:

- **A: adopt position as the axis**, since it is checkable and already implicit.
- **B: B1 where a receipt or reconciliation identifier is issued** (the ingest
  path already does this), **B2 elsewhere**, and **B3 nowhere** — because a
  silent post-mutation gap is what makes an audit trail unfalsifiable.

Under that recommendation the work implied is bounded and known: `agent.v3.js`
moves from swallow to block (pre-position), and the kernel's three
post-mutation sites move from B3 to B2. The five pre-mutation kernel sites
would move from swallow to block, which is the largest behavioural change in
the family and the one most in need of an explicit decision rather than a
default.

## What this ADR does not decide

- It does not decide whether admission refusals and audit failures share a
  vocabulary. They stay distinguishable regardless of what is chosen above.
- It does not decide the MCP surface's flattening of `AUDIT_EVIDENCE_MISSING`
  to `APPROVAL_EXECUTION_FAILED` (recorded in `p1d`). That is a *surfacing*
  question that question B governs, and it should be settled by the rule rather
  than patched ahead of it.
- It does not authorize routing anything. `kernel._appendAuditEvent`,
  `agent.v3.js` and `lib/cli-mutation-audit.js` stay unrouted until this is
  accepted.
- It does not claim the classification in finding 2 is permanent. It is pinned
  by `test/audit-evidence-position.test.js` so that a new audit write cannot
  join the family unclassified.
