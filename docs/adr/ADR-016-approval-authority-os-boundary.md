# ADR-016: Approval authority behind an OS boundary

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** repository owner
- **Supersedes:** none
- **Cross-references:** #3860 (epic), #3560, [ADR-005 approval runtime and memory admission](ADR-005-v3-approval-runtime-and-memory-admission.md), [ADR-008 trust-root boundaries](ADR-008-trust-root-boundaries.md)
- **Scope:** `lib/authority/`, the approval decision path, the Windows installer

## Context

An operator decision (`onayla`/`approve`, `terfi`, `huqan.approve`, the HTTP
memory-approval route) is authorized today by state the interactive OS user
owns:

- the operator secret is minted inside the runtime process (`cli.js`) or read
  from the user's environment (`MCP_OPERATOR_TOKEN`), and the same process
  both mints and verifies the HMAC capability;
- the approval store is the kernel's SQLite file in the user's profile;
- operator presence (#3560) is an interactive-terminal check.

`lib/cli-operator-presence.js` already records the consequence: code running
as the same OS user can drive a pty, load the CLI in-process, or edit HUQAN's
files, and none of the checks above separates it from the operator. An agent
on the operator's machine runs as that user. Only an OS boundary separates
them.

## Decision

The authority over operator decisions moves into a separate service.

1. **Identity.** On Windows the service runs as the virtual account
   `NT SERVICE\huqan-authority`. Its state directory is ACL'd to SYSTEM and
   that service SID only. The interactive user's medium-integrity token
   (UAC filters the Administrators group out of it) can neither read nor
   write it. Installation is a one-time elevated step by the owner.
2. **Code location.** The service never runs user-writable code. The
   installer copies a closed file set (`lib/authority/bundle-manifest.js`,
   node: builtins only, enforced by `test/authority-bundle-closure.test.js`)
   and a signature-checked `node.exe` into `C:\Program Files\huqan-authority`.
3. **Operator authentication.** The operator authenticates with TOTP
   (RFC 6238, `lib/authority/totp.js`). The secret lives only in the
   service's state and in the operator's authenticator app. Each code is
   accepted once: the service persists the last accepted step, so a code is
   never reusable and there is at most one decision per 30 s step.
4. **Signed decisions.** The service holds the only Ed25519 key
   (`lib/authority/decision-envelope.js`). A decision envelope binds one
   decision to one action (approval id, workspace, tool, canonical action
   hash), for a bounded time, and names the ledger entry that recorded it.
   The service recomputes the action hash from the arguments it was shown,
   so the operator approves exactly what the runtime will execute.
5. **Signed responses.** Every HTTP response is signed over the client's
   random challenge and the request it answers (method, path, body digest),
   under a distinct domain prefix. This refuses a naive impostor on the port
   and a replayed or re-routed answer. It does **not** stop an impostor that
   relays a whole exchange to the real service; item 6 closes that where it
   matters.
6. **Sealed decision requests.** The operator client never sends a TOTP code
   in clear. It seals the code with the approval id, action hash and decision
   to the service's X25519 key (ephemeral ECDH, HKDF-SHA256, AES-256-GCM with
   the approval id as associated data; `lib/authority/sealed-request.js`).
   Only the service can open it, and what it opens names the one action the
   operator chose. A relaying impostor can drop or replay a sealed request,
   never spend the code on another approval. The pin carries both public
   keys.
7. **Failure limits.** The service's decide route (P2) locks out after
   repeated TOTP failures and backs off between attempts. Three candidate
   steps give a guess about 3 in a million per try, which is only safe with a
   lockout.
8. **Ledger.** The service appends every registration, decision, consumption
   and outcome to a hash-chained JSONL ledger (`lib/hash-chain.js`). The
   ledger is the source of truth `huqan audit --authority` checks local
   approvals and receipts against.
9. **Mode.** The runtime is in service mode when the installer's pin file
   (`C:\ProgramData\huqan-authority\public\authority.json`, admin-writable
   only) exists. An environment override can require the service but never
   downgrade from it. With no pin, behaviour is unchanged (legacy mode), and
   every decision reports `boundary: same-user` so the gap stays visible.
   The pin path is fixed, never derived from the environment. A junction or
   symlink anywhere on it, or a pin that cannot be read or parsed, fails
   closed. An override pin (`HUQAN_AUTHORITY_PIN_PATH`, honoured only where
   none is installed) is reported as `boundary: env-override`, not as an OS
   boundary. The installer (P5) must therefore refuse a pre-existing install
   directory it did not create, give it a SYSTEM owner with Users limited to
   read and execute, and re-check owner, ACL and reparse points after
   writing the pin. The runtime re-checks the live owner and DACL of the
   install directory, the public directory and the pin file before trusting a
   parsed pin (`lib/authority/install-trust.js`): a planted directory parses
   too, so anything not owned by SYSTEM/Administrators, anything granting
   write-like rights to a broad identity, or a check that cannot run, resolves
   to `required_unavailable` with reason `install_path_untrusted`, never to
   legacy.
10. **Withdrawal.** An approved decision stays usable until `validUntil`, so
    an operator who changes their mind, or learns the agent is compromised,
    needs a way to stop it (#3877). `withdraw` takes the same sealed operator
    code as a decision, with decision `withdrawn`, and is allowed only while the
    approval is `approved` and not consumed. It appends `approval.withdrawn`
    (approval id, action hash, reason, operator, time) and the approval's status
    becomes `withdrawn`. Consumption is the runtime's only way to execute, so
    `consume` then answers `409 WITHDRAWN`, and the decision route returns the
    withdrawal beside the decision so the runtime can say why. A consumed
    approval answers `409 ALREADY_CONSUMED`: withdrawal cannot reach an action
    already running (that is a separate case). The sealed `withdrawn` request
    cannot be used as a decision, and the reverse. The operator window offers
    withdrawal; `huqan-authority withdraw` only points to it, like `decide`.

## Phases

See #3860. P1 (this ADR) ships the pure primitives: TOTP, the decision and
response envelopes, sealed decision requests, and the bundle manifest.
P2 adds the service, P3 the runtime client and mode, P4 the decision path,
P5 the installer and operator CLI, P6 detection and the remaining consumers.

## The decision path (P4)

`lib/authority/decision-guard.js` runs in `handleMcpApprovalDecision`, after
the row is loaded and before anything is rejected, claimed or executed. Every
decision that goes through the handler meets it: CLI `onayla`/`approve`, MCP
`huqan.approve`, the HTTP learn and memory-approval routes, and MCP ingest
approvals. In service mode it accepts only:

- the authority's decision envelope for exactly this approval, workspace,
  tool and verdict, and for the action hash it recomputes from the row's
  stored arguments. Rejections need one too, so an agent cannot discard what
  the operator has not seen;
- for an approval, also the authority's signed consumption envelope
  (`lib/authority/consumption-envelope.js`) for the same action. Nothing runs
  without an `approval.consumed` entry in the ledger first.

Both reach the handler only through the in-process runtime.
`huqan-authority apply <approvalId>`:

1. fetches the decision;
2. checks it against the local row before spending anything;
3. consumes it, or reuses a consumption already recorded after a crash;
4. runs the decision;
5. records the outcome.

A second `apply` finds the row final and changes nothing.
`huqan-authority sync` registers pending local approvals with the authority.

Two decision surfaces do not go through the handler, and they cannot carry
an envelope: the HTTP ingest approval route (`POST /api/ingest/approvals/:id`)
and PR Guardian's decide route. Where an authority is installed, both refuse
with `AUTHORITY_DECISION_REQUIRED`.

Executors re-read the row after the guard. A same-user write to the store
between the two is residual risk 1.

A consequence by design: on a machine where the authority is installed, any
in-process approval -- the test suite's included -- is refused. If a test
could approve in-process there, so could an agent. Run the suite where the
authority is not installed.

## Operational approvals (P6b, #3892)

Four operator decisions have no row in the approval store:

- `huqan.agent_resume`;
- lifting an emergency stop;
- `terfi`;
- the gate hook's `--autonomy-activation`.

They take the same path as P4. Only the first step differs:

1. `huqan-authority request <tool> --workspace <id> --args <json>` registers
   an operational approval (`ops-<random>`) with the arguments to bind.
2. The operator decides it in the HUQAN Authority window.
3. `huqan-authority apply <ops-id>` reads the tool and arguments back from
   the authority's signed answer, checks the decision against them, consumes
   it, runs the surface in-process with both envelopes, and records the
   outcome. A recorded outcome makes a second `apply` change nothing.

Each surface verifies the envelopes itself, against the arguments it is about
to act on, with the P4 decision guard (`lib/authority/operational-guard.js`).
A surface called without them refuses with `AUTHORITY_DECISION_REQUIRED` and
prints the exact `request` command. A guard that throws refuses.

- **Emergency stop.** The guard sits in `lift()` in `lib/emergency-stop.js`.
  The CLI, HTTP and MCP surfaces all lift through it, so none of them can
  bypass it. **Stopping is not guarded:** it only removes authority, and a
  missing or broken authority must never hold the brake.
- **terfi.** The decision binds the flags and the sha256 of each of the four
  input files as read. It replaces the terminal presence check, because the
  operator's TOTP is the stronger proof. A changed file is refused.
- **Agent resume.** The decision binds the tool arguments, including
  `resumeToken`. The token is stored in the authority's ledger, which only
  the service account can write. The agent supplying it already held it.
- **Autonomy activation.** The consumption is the activation, so the `apply`
  executor does nothing else. The hook reads the decision back on every call
  through the verifier `bin/huqan-gate-hook.js` wires in. It checks the
  decision as of its consumption, since the authority refused to consume an
  expired decision. The activation lasts until the registration's
  `expiresAt`, which the operator saw when deciding; then it must be
  requested again. Without a verifier, or on any refusal, the hook exits 2.

The guard is a code-level check, like P4's re-read of the row. Same-user code
that already holds a consumed envelope can call the guarded function again,
just as it can delete a stop record directly (residual risk 1). The authority
does not prevent that. It makes it detectable: each lift, promotion or resume
should match exactly one `approval.consumed` entry.

`apply` reports when the authority did not record the outcome
(`outcomeRecorded: false`). The action has already run at that point, so a
blind second `apply` would run it again.

Not yet done: recording a *stop* in the authority's ledger. That needs a new
service route, which means changing the protected bundle and reinstalling it.
`huqan receipts verify` is a separate change.

## Residual risks

1. **Runtime bypass.** An agent that edits runtime code or writes
   `memory.db` directly can still produce effects without a decision. The
   service cannot prevent effects in the user's own context. The ledger
   makes the bypass detectable after the fact, not impossible.
2. **Trusted display.** TOTP proves the operator is present, not what they
   intended. Same-user code can spoof, read or inject into a non-elevated
   operator window, so what the operator reads may not be what is pending.
   Sealing (item 6) keeps a code from being re-pointed, not from being
   typed into a window that shows the wrong action.
3. **UAC is not a security boundary** (Microsoft's own position). An agent
   with a UAC bypass defeats this design. Running agents as a separate
   standard user would be a real boundary.
4. **Enrollment.** Same-user screen capture can read the enrollment QR code
   or seed. Enroll with agents stopped.
5. **Availability.** An agent can flood registrations (bounded per minute,
   per day and by pending count, with a minimum lifetime), squat the port
   during a restart, or send junk sealed requests to trip the global TOTP
   lockout every fifteen minutes. The lockout is global on purpose: a
   per-approval one would let an attacker multiply guesses by registering
   approvals. All of this denies service and is visible in the ledger
   (`totp.failed`, `totp.lockout`); none of it yields a decision.
6. **Untrusted summary.** An approval's `summary` is the registering
   runtime's text and is not covered by the action hash. The operator client
   (P5) shows the arguments, which are, and labels the summary as untrusted.
7. **Rollback.** The ledger has no external anchor, so an elevated rollback
   is undetectable. TOTP also trusts the system clock, which only an
   elevated process can change.
