# ADR-018: Agent boundary decisions — boundary value, store layout, MCP accounts, client contract

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** repository owner
- **Supersedes:** none
- **Cross-references:** #3978 (this decision), #3948, #3860 (epic), #3982, [ADR-017 agents run as a separate OS user and session](ADR-017-agent-user-boundary.md), [ADR-016 approval authority behind an OS boundary](ADR-016-approval-authority-os-boundary.md)
- **Scope:** answers the four owner questions ADR-017 left open. No runtime change is authorised by this document; each section names the issue that implements it.

## Context

[ADR-017](ADR-017-agent-user-boundary.md) decided that agents run as a
separate local standard Windows user in their own session, that the memory
store moves to a protected state root, and that shared MCP servers leave the
agent's process tree. It closed on a design, not on four details that the code
cannot answer: the boundary value to report, the store layout and its
migration, the MCP service account model, and the MCP client contract. #3978
tracked them. This ADR records the answers.

## Decision

### 1. Boundary value: two orthogonal fields, `os-user` only on verified evidence

`boundary` keeps its ADR-016 meaning: which **approval authority** the runtime
answers to (`same-user`, `os-service`, `env-override`). The agent split is a
different question and is reported in the separate `agentBoundary` field that
#3982 already emits (`lib/authority/agent-user-boundary.js`,
`lib/authority/authority-status.js`). The vocabulary is not merged: one field
per boundary keeps each gap visible on its own.

`agentBoundary` reports `os-user` only when **all three** checks pass, and
`same-user` otherwise, with a `reason` naming the first check that failed:

- **(a)** the agent-user marker written by `install-agent-user.ps1` is present
  and its live owner and DACL pass `install-trust` (implemented in #3982);
- **(b)** the protected store of §2 exists and its ACL matches §3;
- **(c)** the migration marker of §2 for the current workspace verifies.

Checks (b) and (c) are implemented with the store in #3998. Until then an
install can satisfy (a) alone, and the runtime must still report `same-user`.

### 2. Memory store: one protected root, one database per workspace

- Root: `C:\ProgramData\huqan\state`. Per-workspace database at
  `state\workspaces\<workspace-id>\memory.db` (and `memory.json`).
- `workspace-id` is the first 16 hex characters of the sha256 of the
  lowercased canonical realpath of the workspace root. Per-workspace databases
  keep the isolation the current cwd-relative layout already gives, without
  leaving the file in the agent's reach.
- Migration is an explicit, elevated command, `huqan store migrate`, never
  automatic. It copies, verifies (sha256 and row counts), writes
  `state\workspaces\<id>\migrated.json`, and leaves the profile original in
  place as a backup.
- `huqan store migrate --rollback` removes the marker and points resolution
  back to the profile store. The protected copy is kept until the operator
  deletes it.
- When the protected store is selected, resolution never falls back to the
  working directory.

Implemented in #3998.

### 3. MCP service accounts: one virtual account per server

- Each shared MCP server runs as its own virtual service account,
  `NT SERVICE\huqan-mcp-<name>` (no passwords, the same pattern as
  `NT SERVICE\huqan-authority`). Its state is ACL'd to SYSTEM, Administrators,
  the operator and its own service SID only. One server cannot read another
  server's state.
- When the HUQAN runtime runs as a service it gets
  `NT SERVICE\huqan-runtime`, which is the only additional identity with
  Modify on `state\workspaces`. MCP server accounts get no ACE on the memory
  store; they reach it through the runtime.
- The agent user gets no ACE on the state root.

Implemented in #3999, which depends on #3997 and #3998.

### 4. MCP client contract: a signed, single-use, short-lived envelope

Loopback reachability is not client identity (ADR-017 §4). Every request to a
protected MCP server carries an envelope:

- `client_id`, `workspace_id`, `op`, `args_sha256` (sha256 of the canonical
  JSON of the arguments), `nonce`, `issued_at`, `expires_at` (at most 60 s
  after `issued_at`), and an Ed25519 `signature` over the envelope with a
  per-agent key the operator enrolls.

Verification runs in this order and fails closed; any failure rejects the
request with no side effect:

1. known key, 2. signature, 3. freshness, 4. nonce replay,
5. `args_sha256` matches the actual arguments,
6. the existing MCP gate / admission policy, before any protected-state access.

The full specification (canonicalisation, key enrolment and rotation, nonce
store bounds, error codes) and its test vectors are #3997.

## Consequences

- The `os-user` value cannot be reached by a marker alone; a half-finished
  split keeps reporting `same-user`, which is the honest value.
- Existing installs keep working unchanged until the operator runs the
  migration, and the profile store stays as a backup.
- Converting the MCP servers is the largest piece and is ordered last, because
  it needs both the client contract and the protected store.

## Status of prior claims

ADR-017 moves to **Accepted** with this record, since its open questions are
answered here. Neither document authorises a runtime, installer or test change
by itself; #3997, #3998 and #3999 each carry their own evidence.
