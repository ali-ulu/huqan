# Data processing and privacy (KVKK / GDPR)

**Status:** Implemented description. This document describes what the shipped
code stores, what leaves the machine, and which obligations remain with the
operator. It names the source file behind each claim so the text can be
checked against the code that runs.

**Scope:** the local-first deployment in this repository. HUQAN is software the
operator runs; it does not operate a hosted service for the operator.

## 1. Who is responsible

| Role | Who | Why |
| --- | --- | --- |
| Data controller (veri sorumlusu) | The operator who deploys HUQAN | Chooses the purpose, the workspace contents and the retention; runs the store |
| Data processor (veri işleyen) | None in the default deployment | HUQAN sends no data to the project and has no backend that receives it |
| Data subject | The people whose data ends up in a memory node, an approval, a receipt or an audit event | Their data is whatever the operator's agents recorded |

No telemetry, crash reporting or usage analytics endpoint exists in the source.
The only outbound calls are the ten sites recorded in
`coverage-manifest.json` and described in section 4.

## 2. What is stored

| Record class | Content | Where | Source |
| --- | --- | --- | --- |
| Memory nodes and edges | The text, labels, provenance and workspace of what was learned; may contain personal data the agent was given | Graph store (JSON or SQLite) | `lib/graph-node-delete.js`, `lib/graph-sqlite-schema.js` |
| Mutation journal | The ordered record of graph mutations, used to replay and audit | Graph store | `lib/default-persistence-path.js` |
| Approval requests and decisions | Tool name, arguments, workspace, verdict, reason, approver, timestamps | Approval store and authority ledger | `lib/approval-flow.js`, `lib/authority/ledger-store.js` |
| Receipts | Reviewed or blocked action receipts bound to an action hash | Receipt store and receipt bundles | `lib/approval-receipts.js` |
| Audit log | `APPROVAL_REQUESTED`, `APPROVAL_APPROVED`, `APPROVAL_REJECTED` and other events, append-only in SQLite | `audit_log` table | `lib/audit-query.js` |
| Observability records | Events, runs, alerts, queue jobs for the dashboard | Observability tables | `docs/observability-retention.md` |
| Evidence pack | A collected, hashed and signed snapshot of receipts, ledger, audit and invariant rows | Directory the operator names; the pack never overwrites | `lib/evidence-pack/collect.js` |

The arguments stored with an approval are the arguments the tool was called
with, so any personal data in those arguments is stored there too. The runtime
does not classify or redact them; classification happens on the way out (see
section 4) and in the evidence pack, which reports the PII types it found and
refuses to produce a pack when a secret-looking value is present
(`lib/evidence-pack/collect.js`).

## 3. Where it lives

Persistence is local by default: `memory.json` in the working directory
(`lib/default-persistence-path.js`). `HUQAN_DB_PATH`, `AXIOM_DB_PATH`,
`HUQAN_MEMORY_PATH` and `AXIOM_MEMORY_PATH` override it; a path that names a
directory puts `memory.json` inside it, a path that names a file uses that
file. Under `node --test` the default is a per-run temporary directory instead,
so a test run never writes into the repository root.

The operator therefore decides the jurisdiction and the storage medium. Moving
the store to another machine, backup destination or hosted volume is an operator
act, not something this code does on its own.

## 4. What leaves the machine

`coverage-manifest.json` is generated from the enforcement registry and lists
every egress site with its role and reason. There are ten:

| Site | Role | What leaves |
| --- | --- | --- |
| `adapters/github-adapter.js` | adapter read | The repository reference being ingested; public GitHub data comes back |
| `lib/web-research.js` | adapter read | The operator's search query; results come back; secret- and PII-shaped queries are blocked before transport |
| `lib/authority/authority-client.js` | enforcement | A decision request to `127.0.0.1` on the port named by the admin-only pin; the answer must be signed by the pinned key |
| `lib/mcp/stdio-proxy.js` | enforcement | Signed client envelopes to the loopback endpoint named by the operator's pin; a non-loopback `--url` is refused |
| `lib/mcp/rekor-anchor-client.js` | evidence | A signed sha256 digest of the authority ledger head, and the anchor public key, to `rekor.sigstore.dev`; no ledger content, approval or workspace |
| `lib/cli-mcp-service-commands.js` | operator tool | Enrollment and revocation against the protected registry, only under direct human invocation; the status probe is a fixed loopback POST with an empty body |
| `lib/pr-guardian/github-client.js` | egress, operator-gated | GitHub API calls on the PR Guardian path, which is its own deployment and enabled by configuration |
| `lib/pr-guardian/ocr-review-check.js` | egress, operator-gated | The PR diff range to the operator-configured LLM endpoint; the result is an observed signal and never blocks |
| `lib/siem/siem-syslog-sink.js` | egress, operator-gated | An allowlisted, scrubbed SIEM event of a decision already made, to the syslog collector the operator named |
| `lib/runtime-watchdog.js` | unguarded | A health fetch to the supervised local server's health URL |

Every entry except the watchdog health check is either loopback-only, fixed in
source, or enabled by an explicit operator command. The runtime watchdog is the
one recorded open item in `docs/adr/ADR-014-admission-boundary-egress-exceptions.md`.
None of these sends the memory store, the audit log or an approval to the HUQAN
project.

## 5. Retention and deletion

Observability data has a defined, operator-invoked retention: events 7 days,
runs 30 days, resolved alerts 30 days, terminal queue jobs 7 days, deleted in
bounded batches of at most 1,000 per record class per call
(`docs/observability-retention.md`). There is no timer; retention runs when the
operator calls `service.cleanup`.

A memory node can be removed with `removeNode` (`lib/graph-node-delete.js`),
which calls the store's `deleteNode` and drops the SQLite row for that node and
workspace (`DELETE FROM nodes WHERE id = ? AND workspace_id = ?`).

Two limits are stated rather than hidden:

- `audit_log` is append-only; SQLite triggers reject updates and deletes
  (`lib/audit-log.test.js`). Deleting a memory node does not rewrite the audit
  events that recorded how it was created or approved. Those events are the
  accountability record, and their retention is the operator's decision, made at
  the database file level.
- There is no retention setting for approval rows, receipts or memory nodes
  themselves; they live until the operator deletes them or the store is
  replaced.

## 6. Data subject rights

| Right (KVKK m.11 / GDPR) | How it is served today |
| --- | --- |
| Access and information (m.11/a-b; Art. 15) | Query the graph store and read the audit log, receipts and evidence pack; the pack is a hashed snapshot of exactly what was recorded |
| Purpose and recipients (m.11/c-d; Arts. 13-14) | This document plus `coverage-manifest.json` for the recipients |
| Rectification (m.11/d; Art. 16) | Update the node through the normal mutation path, which leaves a journal entry and a receipt |
| Erasure (m.11/e; Art. 17) | `removeNode` for memory; observability cleanup for events and runs; the audit-log limit above applies |
| Restriction and objection (m.11/f; Arts. 18, 21) | Do not approve the action; the human approval gate is the control point |
| Portability (Art. 20) | The store is a JSON file or a SQLite database the operator already holds |
| Automated decision-making (m.11/g; Art. 22) | Approval decisions are made by a human through the authority envelope, not by the model; the runtime cannot approve its own action |

## 7. Security measures that carry the privacy claim

- Approval decisions require the authority's Ed25519 envelope for that
  approval, workspace, tool, action hash and verdict
  (`lib/authority/decision-guard.js`); an operator token or a terminal is not a
  substitute.
- Records are bound by hash and receipts are signed, so a deleted or altered
  record is detectable (`lib/approval-receipts.js`,
  `lib/evidence-pack/signature.js`).
- Egress is gated before transport, and the evidence pack refuses to be
  produced when a secret-looking value is bound
  (`lib/evidence-pack/collect.js`).
- The local server fails closed when `HUQAN_API_KEY` is missing
  (`docs/SECURITY-GATE.md`).

## 8. Known gaps

| Gap | Why it matters | Tracking |
| --- | --- | --- |
| There is one operator token, so a decision cannot be attributed to a named person | KVKK m.11 and Art. 30 accountability expect an identifiable actor per decision | #4204 (SSO), #4205 (RBAC) |
| Roles are not enforced on approval decisions | Separation of duties cannot be shown | #4205 |
| No policy for anonymising or expiring audit payloads | The append-only log keeps argument text that may hold personal data | Follow-up issue linked from #4206 |

## 9. What the operator must add

This document does not replace the operator's own record. Before processing
personal data with HUQAN, the operator completes: the processing purpose and
legal basis, a VERBIS notification where KVKK requires one, a DPIA where the
processing is high-risk (GDPR Art. 35), the retention period for the store and
the audit database, and the procedure that answers a data subject request
within the statutory period.

## 10. Review

Re-read this document when an egress site is added or removed
(`coverage-manifest.json` changes), when the approval boundary changes
(`docs/adr/ADR-016-approval-authority-os-boundary.md`), or when operator
identity changes (#4204, #4205).
