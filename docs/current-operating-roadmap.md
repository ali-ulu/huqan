# Current Operating Roadmap

**Live baseline:** `main` at
`6b62b5e7df376cdc9316e12f8b809fdbaf77ed69` (PR #114 merge).

This is the execution-order source for current runtime work. It is not a
release claim and it does not replace architecture ADRs. When this file
conflicts with live source, tests, CI, or an exact merged SHA, the live evidence
wins.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gate, provenance, audit, approval, and receipt primitives. It is not yet a fully
inline trust control plane for every client, connector, or mutation path.

## Completed hardening sequence

| Merged PR | Completed boundary | Deliberate limit |
| --- | --- | --- |
| #90 / #91 | CLI one-shot and persisted approval workflow | Does not prove every external client path |
| #92 | Plugin ingest status reports admission truthfully | Status is not a universal ingest proof |
| #93 | Atomic approval claim for persisted MCP approvals | Claim alone is not durable mutation evidence |
| #94 | Durable mutation journal and hash-chained canonical receipts on its integrated path | Not every plugin mutation uses this path |
| #95 | HTTP ingest approval queue for manual and decision snapshots | GitHub and markdown ingest remain fail-closed |
| #96 | Expiring HTTP ingest execution leases with visible failed recovery | Failure means execution outcome is unknown, not rollback or transactionality |
| #100 | Real stdio MCP approval, restart, receipt, and replay proof | Does not prove every external MCP host integration |
| #104 / #105 | Graph durability capability and ingest snapshot gate contracts | Contracts do not enable external-source ingest |
| #109-#113 | Connector provenance source reality and bounded contract tests | Does not prove universal connector provenance or journal coverage |
| #114 | Mutation-journal migration decision | Plugin batch migration is deferred; proposal admission is not transactionality |

## Active product boundary

`/api/ingest` currently accepts only `manual` and `decision` into the approval
queue. Each accepted request has a content snapshot hash and idempotency key;
review/approve/reject is persisted. A reviewed-action receipt records the
review decision, snapshot, and plugin-result reference. It does **not** claim
that graph state was transactionally committed.

GitHub and markdown requests deliberately return `INGEST_SNAPSHOT_REQUIRED`.
They must not be enabled through a permissive fallback.

## Closed trust-boundary gates

1. **INGEST-SNAPSHOT-0** - external-source snapshot and refusal boundaries are
   locked; GitHub and Markdown remain fail-closed on the HTTP queue path.
2. **MCP dogfood proof** - real stdio queue, decision, receipt, restart, and
   replay evidence is merged.
3. **Connector provenance coverage** - reachable connector boundaries are
   documented and tested without a universal-coverage claim.
4. **Mutation-journal decision** - universal plugin migration is deferred until
   a retry-safe product path owns the operation ID, transaction unit, receipt,
   and backend semantics.

## Ordered next gates

1. **SELF-HEALER-0_RUNTIME_REACHABILITY_RECONCILIATION** - reconcile the
   implemented audit-only helper with its lack of a production caller. Decide
   whether an explicit caller-supplied audit API is needed before any scanner,
   proposal, patch, or PR work.
2. **V4 source-reality reconciliation** - separately reconcile historical
   runtime/read closeout language with the absence of a kernel-connected
   Workbench UI and browser smoke. Existing receipt and memory inspectors are
   building blocks, not a product UI claim.
3. **Rust integration source reality** - remains deferred. The tracked Rust
   binary and wrapper do not currently establish a reachable Kernel offload,
   parity, persistence, distribution, or performance claim.

## Explicit non-goals

- No automatic retry of an approval whose execution outcome is unknown.
- No claim that every plugin mutation is durable or transactional.
- No external-source ingest without immutable source binding.
- No Self-Healer autonomous scan, write, receipt, patch, or PR claim.
- No V4 Workbench UI or browser-smoke completion claim.
- No Rust production offload, parity, persistence, or performance claim.
- No auto-fix, auto-merge, or release/deploy expansion.

## Operating discipline

One PR has one purpose. Each runtime PR must carry exact base/head, targeted
tests, review evidence, merge SHA, and post-merge smoke. Expensive full-suite,
benchmark, and Docker validation are run only when the active gate requires
them. Update this file only when evidence changes the current execution order.
