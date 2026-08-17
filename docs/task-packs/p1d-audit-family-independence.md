# P1-D — Audit family: independence measurement

## Purpose

The candidate family is now fully routed through `lib/mutation-admission.js`.
The two families still open are **audit** and **knowledge**, and both meet in
`kernel.js`.

Before routing either, one question decides the order: *does the audit family
have a common entry the way the candidate family did?* `lib/conflict-detector.js`
showed that twelve sink calls across three families sat behind a single
production entry, which made one small routing change close a lot of surface. If
the audit family has the same shape, it should be routed the same way. If it does
not, routing it the same way would be a guess.

**This document makes no implementation decision.** It measures and reports a
verdict.

## Canonical base

```text
repository: ali-ulu/huqan
main: df524102e099992914ce8c6ada21d6764c404563
```

Ledger at this base, from `test/mutation-admission-boundary.contract.test.js`:

```text
UNROUTED = 21
ROUTED   = 24
TOTAL    = 45
```

## Scope

The five **production-reachable** unrouted audit sink calls. Reachability is
`lib/module-reachability.js`, not judgement: every holder below is in
`analyzeReachability().reachable`.

| Holder | Sink calls | Surface |
|---|---|---|
| `kernel.js` | 1 | all kernel audit writes |
| `agent.v3.js` | 2 | agent loop budget gate (AB10) |
| `lib/cli-mutation-audit.js` | 1 | CLI mutation gate |
| `lib/mcp-ingest-execute-tool.js` | 1 | MCP ingest approval |

Out of scope, and already classified in the unrouted ledger:
`lib/github-connector.js` (`NOT_YET_WIRED`) and `rustGraph.js` (second sink
provider, not a caller).

## Measurement 1 — how many independent entries?

### `kernel.js`: one chokepoint, not one call

The scan counts one sink call in `kernel.js`, and that count understates how much
it governs. `kernel.js:535` is the only `graph.appendAuditEvent` in the file, and
it sits inside a private method:

```js
_appendAuditEvent(event, provenance = null, workspaceId = 'default') {
  if (!this.graph || typeof this.graph.appendAuditEvent !== 'function') return null;
  try {
    return this.graph.appendAuditEvent(event, provenance ? { provenance, workspaceId } : { workspaceId });
  } catch (error) {
    console.error('[Kernel] Audit log error:', error.message);
    return null;
  }
}
```

Eight call sites inside `kernel.js` reach it (lines 359, 374, 392, 597, 613, 641,
796, 912) — background node admission outcomes, background edge admission
outcomes, the provenance-rejection re-append, and derived-edge learning.

So the kernel's audit family already has an internal chokepoint. One routing
change at `_appendAuditEvent` covers all eight call sites, and `kernel.v2.js` adds
no second path — it exposes no audit method of its own.

**This is the same shape `lib/conflict-detector.js` had:** many writes, one entry.

### The other three do not share it

| Holder | Reaches `_appendAuditEvent`? | Why not |
|---|---|---|
| `agent.v3.js` | no | `KernelV2` is a facade over an internal `Kernel` and does not proxy the private method; `AgentV3` reaches `.graph` directly instead. The source says so in a comment at `agent.v3.js:176-187` — this is a documented bypass, not an oversight. |
| `lib/cli-mutation-audit.js` | no | Kernel exposes `recordCliMutationAudit(intent)` as the CLI's only entry and delegates to this module, which writes to `graph` directly so both kernels share one implementation. |
| `lib/mcp-ingest-execute-tool.js` | no | Writes through `kernel.graph` directly. See measurement 3 — this one is not an independent entry at all. |

**Verdict 1:** `AUDIT_FAMILY_HAS_NO_SINGLE_ENTRY`. There are four entries, not
one. The kernel's chokepoint governs eight of the call sites but is reachable by
none of the other three holders, and two of the three bypass it for reasons that
are recorded in source and still true.

## Measurement 2 — the failure contract collides

Every audit writer in scope refuses to let a failed audit write escalate:

| Holder | On write failure |
|---|---|
| `kernel.js` `_appendAuditEvent` | catches, logs, returns `null` |
| `agent.v3.js` `_recordBudgetAuditEvent` | catches, returns; comment: losing the audit line "must not escalate into an exception that hides the refusal" |
| `lib/cli-mutation-audit.js` | returns `{ auditRecorded: false }`; the docblock states it "must be able to say *no* without also taking the process down" |
| `lib/mcp-ingest-execute-tool.js` | the enclosing `decideMcpIngestApproval` catches and returns `APPROVAL_EXECUTION_FAILED` with `retrySafe: false` |

This is a deliberate, family-wide property, and it is the opposite of what the
one already-routed audit caller does.
`lib/workbench/ingest-approval-audit-writer.js` **throws** on refusal, precisely
so the refusal lands on the existing `audit_append_failed` →
`AUDIT_EVIDENCE_MISSING` path.

The collision is real and matters:

- an admission **refusal** must be visible, or enforcement is not enforcement;
- an audit **write failure** must be swallowed, or a fail-closed refusal turns
  into a thrown exception that hides the very refusal it was recording.

A routing change that swallows refusals would make the seam decorative at these
call sites. `lib/cli-mutation-audit.js` is the sharpest case: its return value is
*already* the CLI gate's admission signal (#760), so it has an admission concept
of its own that a second one has to be reconciled with rather than layered over.

**Verdict 2:** `REFUSAL_VISIBILITY_UNRESOLVED`. Each audit holder needs a decided
refusal path before routing, and that decision is per-holder — it is not a
property the seam can supply.

## Measurement 3 — one of the five is not a new call at all

`lib/mcp-ingest-execute-tool.js` and `server.js` both drive the **same** approval
owner, `lib/workbench/ingest-approval-action.js::decideIngestApproval`, which
takes the audit write as an injected `recordAudit` port.

They inject different things:

```js
// server.js:87 -- the routed writer
const recordIngestApprovalAudit = createIngestApprovalAuditWriter({
  graph: kernel.graph, admission: createMutationAdmission(), hashResult: sha256,
});

// lib/mcp-ingest-execute-tool.js:136 -- an inline unrouted duplicate
recordAudit: runtime.recordIngestApprovalAudit
  || ((approval, receipt, result) => recordMcpIngestApprovalAudit(kernel, approval, receipt, result)),
```

`recordMcpIngestApprovalAudit` writes the same event the routed writer writes:
same `eventType` derivation, same `targetType: 'ingest_approval'`, same
`details` keys, same `executionGuarantee: 'bounded_action_outcome'`, and the same
`sha256` from `lib/ingest.js` for `pluginResultRef`. One difference exists: the
routed writer resolves a missing workspace to `'default'` in the open, while the
MCP duplicate passes `snapshot.workspaceId` through and lets the sink coerce it.

So this is not a fourth kind of audit write. **It is the HTTP surface's write,
reached through a second transport that injects an unrouted copy of it** — a
bypass of a boundary that already exists, rather than a boundary that does not
exist yet.

**Verdict 3:** `MCP_INGEST_AUDIT_IS_A_DUPLICATE_OF_A_ROUTED_WRITE`.

> **Resolved.** The duplicate was deleted and the MCP surface now builds the
> same routed writer `server.js` builds. The measurement above describes the
> state at `df52410`; it is kept as written because it is the evidence the
> change rests on. Three consequences are worth carrying forward:
>
> - The sink-call total fell from 45 to 44. Every earlier routing step left the
>   total constant and moved a call from `UNROUTED` to `ROUTED`; a duplicate
>   deletion is the one legitimate way for the total itself to drop.
> - The scope of this family shrank by one: four holders became three, and the
>   remaining three each need a decision rather than a deletion.
> - One thing this measurement got wrong is corrected below.

### Correction to this document's original claim

The first version of this document said the MCP surface's audit-gap path
already carried the same meaning as `AUDIT_EVIDENCE_MISSING`. Measuring the
path end to end while making the change showed that it does not, and the
difference is in a shape mismatch rather than in intent:

`auditEvidenceGap` returns `{ status, json: { error } }`, `apiError` returns
`{ status, error }`, and `approvalFailure` reads `response.error` — which the
gap shape does not have. So on the MCP surface the reconciliation code is
flattened to `APPROVAL_EXECUTION_FAILED` and the reconciliation identifiers do
not reach the caller. Over HTTP they do, because `server.js` writes
`outcome.json` as the 409 body.

`retrySafe: false` survives on both, so the rule that actually prevents a
duplicate write holds. The behaviour is identical before and after the change —
measured against `origin/main`, where a *failing* writer produced the same
`APPROVAL_EXECUTION_FAILED` — so it is neither introduced nor fixed here.

It is recorded rather than repaired because it belongs to verdict 2: what an
audit-evidence gap should mean to a caller is a product decision, and two
transports currently answer it differently without anyone having chosen that.

## Verdicts

```text
AUDIT_FAMILY_HAS_NO_SINGLE_ENTRY                = true
KERNEL_AUDIT_HAS_INTERNAL_CHOKEPOINT            = true   (_appendAuditEvent, 8 call sites)
REFUSAL_VISIBILITY_UNRESOLVED                   = true
MCP_INGEST_AUDIT_IS_A_DUPLICATE_OF_A_ROUTED_WRITE = true
AUDIT_FAMILY_IS_ANALOGOUS_TO_CANDIDATE_FAMILY   = false
```

Verdict 3 has since been acted on; the section that states it records how. The
other four stand.

## What this measurement does not claim

- It does not claim the audit family is harder to route than the knowledge
  family. The knowledge family has not been measured; `kernel.js` still holds
  four unrouted knowledge sinks and they are untouched by this document.
- It does not claim `_appendAuditEvent` is the right hook. It claims it is a
  chokepoint. Whether admission belongs there depends on verdict 2, which is
  unresolved.
- It does not claim the three bypasses are defects. Two of them state their
  reason in source and the reason still holds.
- It does not route anything or change any count. The ledger is untouched.

## What follows from it

The five calls are three different problems, and only one is ready:

1. ~~**`lib/mcp-ingest-execute-tool.js`**~~ — **done.** The smallest and best-evidenced unit.
   Verdict 3 says the boundary already exists and one transport does not use it.
   Making MCP inject the same routed writer `server.js` injects removes a
   duplicate rather than adding a seam, and verdict 2 does not block it: the
   routed writer's throw-on-refusal already has a defined meaning on this path,
   because `decideMcpIngestApproval` catches and returns `APPROVAL_EXECUTION_FAILED`
   with `retrySafe: false`, which is the same "durable part may have happened,
   evidence did not, do not retry" meaning `AUDIT_EVIDENCE_MISSING` carries.

2. **`kernel.js` `_appendAuditEvent`** — high coverage, blocked on verdict 2.
   Eight call sites for one change, but every one of them currently treats a
   failed write as `null` and continues. What a refusal means there has to be
   decided before it is routed, not during.

3. **`agent.v3.js` and `lib/cli-mutation-audit.js`** — separate decisions.
   Each has a documented reason for bypassing the kernel chokepoint, and
   `cli-mutation-audit` additionally has its own admission signal to reconcile.

Ordering follows the evidence: (1) is a duplicate removal provable from source
today; (2) and (3) need a refusal-semantics decision first.
