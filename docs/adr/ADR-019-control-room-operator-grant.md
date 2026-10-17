# ADR-019: Control Room operator grant — ask by default, automatic only on loopback

- **Status:** Accepted
- **Date:** 2026-10-18
- **Deciders:** repository owner
- **Supersedes:** none
- **Cross-references:** #3926, [ADR-016 approval authority behind an OS boundary](ADR-016-approval-authority-os-boundary.md), [ADR-017 agents run as a separate OS user](ADR-017-agent-user-boundary.md), `docs/control-room-design.md`
- **Scope:** `lib/http/operator-grant-routes.js`, the Control Room approval dialog

## Context

Since #3926 a learn decision on `POST /api/v2/approvals/{id}/decision` needs a
short-lived, scope-bound operator capability in `x-huqan-operator-capability`
on top of the API key, so that whoever proposes with the key cannot approve
with it. The capability is an HMAC over the exact decision, minted with the
operator token. The browser never holds that token, so the Control Room's
Approve button could only answer `403 OPERATOR_AUTH_REQUIRED`.

The owner's decision for the Control Room:

1. By default every decision **asks**: pressing Approve or Reject asks for
   operator authority at that moment, in a dialog. No key field sits on the
   main screen.
2. The operator may switch to **automatic** approval: on a local session the
   server grants the authority itself and stops asking. The switch lives in
   Customize and a visible indicator shows while it is on.
3. Automatic approval is never granted to a remote connection, and the grant
   is narrowly scoped.

## Decision

A deployment-gated route mints decision capabilities:

- `GET|PUT /api/v2/operator/grant` reads and changes the mode (`ask`|`auto`).
- `POST /api/v2/operator/capabilities?workspaceId=` mints one capability.

It exists only when `HUQAN_MCP_OPERATOR_TOKEN` is configured (otherwise a
404, like the memory-approval and emergency-stop routes) and requires the API
key like every other authenticated route.

**Scope of a grant.** Tool `huqan.approve`, one approval id, one workspace,
one verdict, one reason; TTL 60 s; single use, because the decision route
consumes the nonce in the shared durable nonce store. Only a pending approval
in the named workspace gets a grant. Nothing wider is ever minted: no other
tool, no list capability, no emergency-stop capability.

**Ask.** The dialog sends the operator token once with the decision request.
It is compared in constant time, never stored, logged or echoed. Five wrong
keys throttle wrong guesses for five minutes; a request carrying no key is
not counted as a guess. The throttle never refuses the operator's own key:
an accepted key ends the lockout and clears the guess counter, so an agent
that holds only the transport API key cannot keep a person out of Control
Room decisions by spamming wrong guesses (the #3926 threat model).

**Auto.** Honoured only when all hold:

- the TCP peer is loopback;
- no `X-Forwarded-For`, `Forwarded` or `X-Real-IP` header is present (a local
  reverse proxy makes remote callers look local, so any proxy header counts
  as remote);
- the `Host` header names a loopback host (DNS rebinding);
- `Sec-Fetch-Site`, when present, is `same-origin` or `none`, and `Origin`,
  when present, is this server's own host and port (another web page posting
  to localhost);
- the approval authority mode is `legacy` (ADR-016). With an authority
  installed or required, decisions belong to the OS-separated service and
  automatic grants are refused even if the preference was stored earlier.

Switching auto **on** requires the operator token once and a direct loopback
request. Switching it **off** needs nothing: narrowing is always allowed. The
preference is a file beside the memory store and is re-checked against the
conditions above on every request.

## Why not a safe local default for the observability policy

The same pass removed the red `OBSERVABILITY_AUTHORIZATION_UNAVAILABLE`
errors on default installs. The runtime is not given an implicit policy: the
observability authorizer (#1444) is a deliberate allow-list that binds a
subject to a workspace and role, and an implicit grant would widen every
existing deployment that relies on its absence meaning "no observability
reads". The Control Room instead reads the existing public readiness bit
(`/v2-status` → `observability.configured`, #1825), skips those reads, and
shows "Activity counts are off" as a setup step.

## Consequences

- Approve and Reject work end to end from the Control Room.
- **Residual risk (stated, not hidden):** with auto on, any process running as
  the same OS user can reach loopback and obtain a grant. That process can
  already read the operator token from the same user's environment, which is
  why ADR-016 reports legacy mode as `boundary: same-user`. Auto removes a
  prompt, not a boundary that existed. Where the boundary matters, install the
  authority (ADR-016) — auto then switches off by construction — or run agents
  as a separate OS user (ADR-017).
- **Residual risk (attempt limiter, stated, not hidden):** the wrong-guess
  limiter is process-wide, so wrong guesses from any holder of the transport
  API key share one counter and one lockout: guessing by one agent can
  throttle wrong guesses made from the Control Room for up to five minutes.
  Only wrong guesses are throttled, never the operator's own key, so the limiter
  stays a brute-force guard and not an anti-oversight lever.
- Tests: `test/control-room-operator-grant.test.js` pins the scope, the
  single use, the lockout, each loopback refusal and the authority override.
