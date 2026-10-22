# ADR-014 - Admission Boundary: Egress Exceptions and Open Process Gaps

## Status

**Accepted.** Supersedes the per-file "unguarded" reasons that used to carry
this decision implicitly in `scripts/enforcement-coverage-classification.js`.

This ADR answers one question and refuses to answer more than one:

> **Which call sites that leave the admission boundary are deliberate,
> operator-gated exceptions, and which remain an open gap?**

It is the decision the enforcement-coverage inventory (#3357) asked for: the
manifest already recorded a "why" per file, but a per-file reason is not a
decision. Two of the four `unguarded` files are egress on a separately
deployed process a human operator turns on by configuration; the other two are
process launches this ADR leaves open.

**Nothing is routed here and no runtime behaviour changes.** Accepting this
ADR reclassifies two files to `egress_operator_gated` and records the two
process gaps as open work rather than as a labelled exception.

## Context

`check:enforcement-coverage` enumerates every call site that can execute a
process, write to disk, or leave the machine, and requires a recorded role for
each. Four production files carried the `unguarded` role:

| File | Site | Capability |
|---|---|---|
| `lib/pr-guardian/github-client.js` | `:28` | egress (`fetch` to the GitHub API) |
| `lib/pr-guardian/ocr-review-check.js` | `:288` | process (`spawnSync('ocr', …)`) |
| `lib/runtime-watchdog.js` | `:22`, `:86` | egress (`fetch(healthUrl)`), process (`spawnProcess(process.execPath, [serverPath])`) |
| `rustGraph.js` | `:99` | process (`spawn(RUST_BIN, [])`) |

The product's claim is that a risky action passes one admission boundary.
`unguarded` said "outside that boundary", but it did not say whether that was
a decision or an oversight, so the count of unguarded sites could not be read
as a measure of the real gap.

## Decision

### Deliberate exceptions: egress on an operator-gated deployment

Two of the four are egress that no agent action reaches:

- `lib/pr-guardian/github-client.js` — outbound GitHub API calls on the PR
  Guardian path. PR Guardian runs as its own deployment, is enabled by
  operator configuration, and acts on a webhook/PR event rather than on an
  agent tool call.
- `lib/pr-guardian/ocr-review-check.js` — spawns `ocr review` over the PR
  base-to-head range with argv fixed in source; the change is sent to the
  operator-configured LLM endpoint and the result is an observed signal that
  never blocks a decision.

Both are classified `egress_operator_gated`. The exception is bounded and
written here rather than left to a per-file reason:

1. **No agent action reaches them.** They are not reachable from an agent tool
   call, so there is no admission decision to make; gating them would add a
   gate that no agent could ever trip.
2. **Operator-enabled.** Each runs only when the operator configures and
   deploys it; a default install performs neither.
3. **Argv is fixed in source.** Where a process is involved, no agent-supplied
   value enters the command line.
4. **Re-open condition.** If either site ever becomes reachable from an agent
   action, or its argv or target becomes agent-supplied, this exception is void
   and the site must be routed through admission.

The role carries a generic reason in `ROLES`; this ADR is the specific
justification the reason points at.

### Open gaps: process launches still outside the boundary

The other two are not exceptions and are not reclassified:

- `rustGraph.js:99` spawns `RUST_BIN` with no arguments. `RUST_BIN` is
  env-configurable (`HUQAN_RUST_BIN`, legacy `AXIOM_RUST_BIN` via
  `lib/environment-compat.js`), so the spawn target is redirectable without a
  gate decision. The process launch itself is also uncovered.
- `lib/runtime-watchdog.js:86` spawns the server it supervises. The health
  fetch at `:22` is covered by the bounded exception above (the watchdog is an
  operator-run supervisor), but the server spawn is a process launch no
  admission decision covers.

They remain `unguarded` on purpose: the count of unguarded sites should show
the real gap, and moving them to a documented role would hide it. The
follow-up is to resolve `RUST_BIN` through a trusted/allowed-path check and to
route the process launches through the command-execution gate. Until then they
stay counted as unguarded.

## Consequences

- `unguarded` drops from four files to two, and the two that remain are the
  two the ADR calls open. The published manifest's unguarded list now measures
  the real gap rather than a mix of gap and exception.
- `egress_operator_gated` is a new role in `ROLES`; the enforcement-coverage
  test already requires every recorded role to be declared and every reason to
  be substantive, so the new role is held to the same shape.
- The `unguarded` surface is still non-empty, which the manifest test asserts;
  this ADR does not empty it and must not be read as claiming coverage.
- No code is routed here. The open work is listed above, not scheduled.

## Addendum (#4093 PR-B4): SIEM push transports

The SIEM export (`huqan-gate-hook siem-export`) can push events to the
deployment's own SIEM. Two new egress sites:

- `lib/siem/siem-syslog-sink.js`: a TLS connection (`tls.connect`) to a
  `syslog+tls://` collector. Classified `egress_operator_gated`.
- `lib/siem/siem-http-sink.js`: an HTTPS `POST` to a Splunk HEC or Elastic
  `_bulk` endpoint. It calls an injected `fetch`, which the scan does not see
  yet (#4196), so it has no manifest site and no role today. It is the same
  exception as the syslog sink and has to be classified the same way when
  #4196 lands.

They fit the exception above for the same reasons:

1. **No agent action reaches them.** The export runs as its own command after
   the guard has decided and written the receipt; it reads the receipt trail,
   never the agent's input. A sink that fails cannot change a decision.
2. **Operator-enabled.** The default transport is the local file and opens no
   network. A push happens only when the operator names `--sink syslog` or
   `--sink http` and a URL.
3. **The destination is judged first.** Each push sink's factory runs the
   guard's own AB12 data residency and AB13 expected-egress gates on the host
   (`lib/siem/siem-push-policy.js`) before it returns, so no caller can hold a
   sink that skipped them. `block` refuses; AB13 `review` refuses too unless
   the operator passes `--allow-unreviewed-host`, because an unattended export
   has no human to review; a `--policy` file that does not exist refuses
   instead of reading as "no residency". HTTP redirects are refused, so the
   events cannot move to a host nobody judged.
4. **Bounded payload.** Only the allowlisted, AB9-scrubbed
   `huqan.siem-event.v1` leaves, over TLS with certificate verification on:
   syslog sets it explicitly, and the HTTP sink refuses to start when
   `NODE_TLS_REJECT_UNAUTHORIZED=0` would switch it off for `fetch`. The HTTP
   token comes from `HUQAN_SIEM_HTTP_TOKEN` and is never logged.

The re-open condition above applies: if a push sink's URL or payload ever
becomes agent-supplied, the exception is void.

`check:enforcement-coverage` also did not count `node:tls` as egress. This PR
adds it to the scanned egress modules; no production file used `tls` before,
so the change adds the syslog sink's site and nothing else.
