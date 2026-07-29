# Current Operating Roadmap

**Live baseline:** `main` at `15fe658` (PR #96 merge).

This is the execution-order source for current runtime work. It is not a release claim and it does not replace architecture ADRs. When this file conflicts with live source, tests, CI, or an exact merged SHA, the live evidence wins.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification, gate, provenance, audit, approval, and receipt primitives. It is not yet a fully inline trust control plane for every client, connector, or mutation path.

## Completed hardening sequence

| Merged PR | Completed boundary | Deliberate limit |
| --- | --- | --- |
| #90 / #91 | CLI one-shot and persisted approval workflow | Does not prove every external client path |
| #92 | Plugin ingest status reports admission truthfully | Status is not a universal ingest proof |
| #93 | Atomic approval claim for persisted MCP approvals | Claim alone is not durable mutation evidence |
| #94 | Durable mutation journal and hash-chained canonical receipts on its integrated path | Not every plugin mutation uses this path |
| #95 | HTTP ingest approval queue for manual and decision snapshots | GitHub and markdown ingest remain fail-closed |
| #96 | Expiring HTTP ingest execution leases with visible failed recovery | Failure means execution outcome is unknown, not rollback or transactionality |

## Active product boundary

`/api/ingest` currently accepts only `manual` and `decision` into the approval queue. Each accepted request has a content snapshot hash and idempotency key; review/approve/reject is persisted. A reviewed-action receipt records the review decision, snapshot, and plugin-result reference. It does **not** claim that graph state was transactionally committed.

GitHub and markdown requests deliberately return `INGEST_SNAPSHOT_REQUIRED`. They must not be enabled through a permissive fallback.

## Ordered next gates

1. **INGEST-SNAPSHOT-0** — before enabling GitHub or markdown ingest: immutable content snapshot, source identity, commit SHA or file hash, immutable approval reference, and replay protection.
2. **MCP dogfood proof** — run a real MCP client through queue, decision, receipt, restart, and replay behavior; preserve the resulting evidence.
3. **Connector provenance coverage** — close only evidenced gaps in the connector-to-provenance/audit/graph chain; do not claim universal coverage.
4. **Mutation-journal decision** — separately decide whether company-brain and other direct plugin mutations must migrate to the durable journal. This is a migration/transaction design gate, not a small follow-up patch.
5. **Self-Healer / V4 / Rust work** — remain deferred until the preceding trust-boundary evidence is current and honest.

## Explicit non-goals until the gates above close

- No automatic retry of an approval whose execution outcome is unknown.
- No claim that every plugin mutation is durable or transactional.
- No external-source ingest without immutable source binding.
- No auto-fix, auto-merge, or release/deploy expansion.

## Operating discipline

One PR has one purpose. Each runtime PR must carry exact base/head, targeted tests, full CI, review evidence, merge SHA, and post-merge smoke. Update this file only when that evidence changes the current execution order.
