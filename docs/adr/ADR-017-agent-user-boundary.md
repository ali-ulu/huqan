# ADR-017: Agents run as a separate OS user and session

- **Status:** Accepted
- **Date:** 2026-10-16
- **Deciders:** repository owner
- **Supersedes:** —
- **Cross-references:** #3948 (this decision), #3860 (epic), [ADR-016 approval authority behind an OS boundary](ADR-016-approval-authority-os-boundary.md), [ADR-008 trust-root boundaries](ADR-008-trust-root-boundaries.md), [ADR-0007 MCP security boundary](0007-mcp-security-boundary.md)
- **Scope:** agent execution identity, workspace sharing, the memory store location, shared MCP servers. No runtime code changes are authorised by this document.

## Context

[ADR-016](ADR-016-approval-authority-os-boundary.md) moved the approval
authority behind a Windows service boundary (`NT SERVICE\huqan-authority`,
TOTP, signed decision envelopes, a hash-chained ledger anchored in Rekor).
Its residual risks 1–4 all reduce to one fact: **agents still run as the same
OS user as the operator.**

1. An agent that edits runtime code or `memory.db` still produces effects.
   The ledger makes this detectable after the fact, not impossible
   (`lib/authority/decision-guard.js` re-reads the row; a same-user write
   between the guard and the executor is exactly this gap).
2. TOTP proves the operator is present, not what they intended. Same-user
   code can spoof or inject into a non-elevated operator window.
3. UAC is not a security boundary (Microsoft's own position). A UAC bypass
   defeats the authority. ADR-016 item 3 says this plainly: running agents as
   a separate standard user would be a real boundary.
4. Same-user screen capture can read the enrollment QR code.

The runtime already assumes one thing repeatedly: a medium-integrity standard
user token cannot read or write state owned by SYSTEM or Administrators.
`lib/authority/install-trust.js` refuses a pin whose owner or DACL is not
SYSTEM/Administrators; `lib/authority/state-store.js` keeps TOTP and signing
secrets in a directory ACL'd to SYSTEM and the service SID only. This ADR
extends that same assumption to the agent process, the memory store and the
shared MCP servers.

## Decision

### 1. Agent identity: a separate local standard user, in its own session

Agents (Claude Code, Codex, MCP clients, the HUQAN runtime when it runs
agent-authored actions) run as a **separate local standard Windows user** that
logs on in its **own interactive session** (fast user switching / a dedicated
session), not in the operator's Session 1.

- **Not an AppContainer.** Node tooling spawns child processes for git,
  package managers and language servers. AppContainer is built for
  UWP/store packages, gate its filesystem and child processes on capability
  SIDs, and would break the toolchain far more than it protects. It is the
  wrong primitive for a CLI that shells out.
- **Not Windows Sandbox or a Hyper-V VM by default.** Windows Sandbox is
  Pro/Enterprise only and **ephemeral** — it discards state on close, which is
  fatal for an agent that writes code across a session. A Hyper-V VM costs
  gigabytes of RAM, a second OS, and SMB workspace sharing, and contradicts
  the local-first, no-Docker, ~50 MB posture. ADR-016 residual risk 3 names
  the threat as *same-user code*, not a hostile kernel; a VM is
  disproportionate and unshippable for that threat.
- **Standard user is the right primitive.** It is the same assumption
  ADR-016 already relies on, so the two boundaries compose instead of adding a
  second trust model.

The session split is load-bearing, not cosmetic. A second user in the *same*
interactive session can share the window station, desktop and clipboard, so
screen capture survives. Risk 4 and the display half of risk 2 only close
with a **separate session** (the agent's Session N versus the operator's
Session 1). The operator window (the Start menu shortcut that opens it
elevated, per ADR-016 item 9) lives in the operator's session and is out of
reach.

**Escalation tier (optional, per task):** an operator running genuinely
untrusted third-party agent code MAY sandbox that *specific task* in Windows
Sandbox or a disposable VM. That is an escalation for one job, never the
default agent boundary.

### 2. Workspace sharing: git worktree plus an explicit ACL — no sync daemon

- The agent **never writes the operator's live checkout.** It gets its own
  worktree (`C:\huqan-workspaces\<project>`), owned by the agent user, read
  and write. This matches the repository's existing rule that every change
  set uses its own worktree.
- Hand-off is **git branch and PR**, which the repository already requires.
  The operator reviews and merges. This removes the "both sides write the same
  files" problem with the workflow that exists rather than with file ACLs.
- Shared, non-git assets (knowledge base, fixtures, MCP configuration) live
  in **one shared folder with an explicit ACL**: operator Full, agent Read,
  with Write only inside a per-agent scratch subfolder.
- **No sync daemon.** A syncing process is itself an attack surface and
  produces a silently divergent copy. It is not used.
- The operator's own state root (`%LOCALAPPDATA%\huqan`, see
  `resolveStateRoot` in `persistencePaths.js`) stays operator-private.

### 3. `memory.db` and the runtime install: agent process ≠ runtime process

The separating principle is that the **agent process is not the runtime
process**.

- **Runtime install** (`C:\Program Files\huqan`): same pattern as the
  authority install — owned by SYSTEM/Administrators, **Users limited to Read
  and Execute**, with the reparse-point and DACL re-check that
  `lib/authority/install-trust.js` already performs. The agent can *read* the
  code (it needs to reason about it) but cannot *edit* it.
- **`memory.db` / `memory.json`**: no longer resolved in the per-workspace
  cwd. The canonical store moves to a protected state root
  (`C:\ProgramData\huqan\state`), ACL'd to the operator, SYSTEM and — when the
  runtime runs as a service rather than as the operator — the explicitly named
  runtime service identity that write access requires, **outside the agent
  user's token** and the same ACL class as the authority's `state-store.js`.
- The **runtime process** writes `memory.db`. It runs either under the
  operator identity or under an explicitly named service identity that is
  granted the state-root access above; the ADR names that identity and its ACL
  grant when the service variant is chosen, rather than leaving the writer
  implicit. The agent reaches the store **only through the MCP/HTTP
  interface**, never by opening the file. This closes ADR-016 residual risk 1
  at the memory layer: the "agent writes `memory.db` directly" path now fails
  at the filesystem ACL, not merely at the audit.

### 4. Shared MCP servers leave the agent's process tree

Today a shared MCP server such as LEVH, when it is a **stdio child process the
agent spawns, inherits the agent's token** — which makes the user split
meaningless for that server.

- Shared MCP servers run as their **own small local service under a
  low-privilege service account** (for example `NT SERVICE\huqan-mcp-levh`),
  with their state ACL'd away from the agent, listening on `127.0.0.1:<port>`
  and using a signed-envelope protocol that **authenticates the agent client**;
  loopback reachability is not client identity. Each request must bind the
  authenticated client and workspace to the requested MCP operation and its
  arguments, pass through the existing MCP gate/admission policy before any
  protected-state access or side effect, and fail closed on a request that does
  not verify or is not authorized. The envelope fields and verification rules
  that provide this are a separate contract to be specified; ADR-016 items 5
  and 6 sign authority responses and seal operator decision requests, and do
  **not** define this MCP client contract.
- The agent's MCP client configuration points at `127.0.0.1`, not at a
  spawned child. The server then lives on the operator's trusted side and the
  separation holds.
- Per-session stdio helpers that must remain children are treated as part of
  the **untrusted agent boundary**: they cannot touch operator state and reach
  a protected server only as a proxy.

## Consequences

- The four residual risks of ADR-016 are closed to the extent a same-kernel
  boundary closes them: risks 2 and 4 close because the operator window and
  the enrollment display live in a different session; risk 1 closes where the
  agent now cannot reach `memory.db` or the runtime install; risk 3 (UAC) is
  answered because the agent no longer holds the operator's token at all.
- The `boundary` reporting introduced by ADR-016 gains a new value. Legacy
  mode still reports `same-user`; an install with the agent split present
  reports `os-user` (proposed name) so the gap stays visible, exactly as
  `same-user` does today.
- Integration cost: the operator must create the agent user once (elevated),
  the runtime must move its memory store to the protected root (a
  `persistencePaths.js` default change plus an ACL step in the installer), and
  each shared MCP server must be converted from a spawned child to a local
  service. This is multi-phase work, not one PR.

## Residual risks (kept honest)

1. **Shared kernel.** The agent and the operator share the kernel. A kernel
   exploit, or a bug in a shared protected service, crosses the boundary. Only
   a VM closes this; a standard user does not. This is what the optional
   escalation tier exists for, and it is the reason that tier is not the
   default.
2. **Non-Windows parity.** This ADR is scoped to Windows because ADR-016 is.
   The equivalent boundary on macOS and Linux (a dedicated system user plus
   systemd hardening, or `su`/`runuser` with a distinct session) is unaddressed
   here and tracked separately.
   Tracked in [ADR-020 POSIX parity for the approval authority](ADR-020-posix-authority-parity.md) (#4082).
3. **Migration of existing installs.** An install that predates this decision
   keeps its memory store in the user profile. Moving it is a data migration
   with its own rollback story; until it runs, `boundary` must keep reporting
   the weaker value rather than the stronger one.
4. **Operator convenience.** Fast user switching between sessions is a real
   ergonomic cost. The decision accepts it because the alternative is that
   risks 2 and 4 stay open.

## Open questions (owner decision)

Answered in [ADR-018](ADR-018-agent-boundary-decisions.md) (#3978): a separate
`agentBoundary` field that reports `os-user` only on verified evidence, one
protected database per workspace with an explicit migration, and one virtual
service account per MCP server.

## Status of prior claims

This ADR records a decision and a design only. It authorises **no runtime
change, no installer change and no test change.** Every mechanism above that
does not already exist (`os-user` reporting, the protected memory root, the
MCP service conversion) still has to be built and gated in its own scoped
change with its own evidence.
