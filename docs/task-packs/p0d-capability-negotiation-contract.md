# P0-D — capability negotiation

## Purpose

P0-C added an Agent Card, which advertises. This adds the step after it: a
caller states what it supports, and the receiver answers with what the two of
them actually have in common.

`docs/task-packs/p0a-a2a-production-transport-scope-freeze.md` remains binding.
Advertising and agreeing were kept as separate units there, and this document
records why that separation survived contact with the implementation.

## Source reality at the start of P0-D

- `POST /api/a2a/exchange` (P0-B) and `GET /.well-known/agent-card.json` (P0-C)
  existed, composed behind `lib/a2a/routes.js`.
- The card declared `capability-negotiation` in its `unsupported` list.
- No negotiation surface of any kind existed.

## What P0-D added

| Surface | Location |
|---|---|
| Negotiation decision core | `lib/a2a/capability-negotiation.js` |
| `POST /api/a2a/negotiate` | `lib/a2a/negotiate-route.js` |
| Card negotiation descriptor | `lib/a2a/agent-card.js` |
| Route auth rule `a2a-negotiate` | `lib/http/route-auth-policy.js` |
| Contract tests | `test/a2a-negotiate-route.test.js` |

## The governing property

A negotiator produces a statement the caller then relies on, so the design is
organised around the ways it could be turned into an escalation primitive:

1. **The receiver's offer is receiver-owned.** Descriptors in an agreement are
   the frozen `CAPABILITIES` objects from `lib/a2a/agent-card.js`. Nothing is
   echoed from the request, so a caller cannot negotiate itself a `path` or a
   `method`. There is a test that sends exactly that and gets the real
   descriptor back.
2. **Agreement is intersection, never union.** The result is produced by
   filtering the receiver's table, not by mapping the caller's list. Asking for
   more cannot widen it.
3. **Fail-closed.** No common protocol version, or no common capability, is a
   refusal. There is no "agree on nothing and continue" outcome, because a
   caller that treated an empty agreement as success would proceed believing it
   had negotiated something.
4. **Receiver preference decides the version.** A caller listing an unsupported
   version first cannot steer the agreement.

An empty `capabilities` list is a refusal rather than shorthand for "send
everything you have". The caller already has the names — it read them off the
Agent Card — and requiring it to ask keeps negotiation from becoming a
capability dump.

## Decision: one offer table, not two

`capability-negotiation.js` imports `CAPABILITIES` and
`SUPPORTED_PROTOCOL_VERSIONS` from `agent-card.js`, and `negotiate-route.js`
imports its own path from the card's `NEGOTIATION` descriptor.

The alternative — a negotiation table alongside the card's — would be deep-equal
on the day it was written and would diverge silently afterwards, letting
negotiation agree to something the card never advertised. The dependency runs
card → negotiation → route, so there is no cycle, and
`scripts/check-import-cycles.js` confirms it.

Negotiation is deliberately **not** listed in `CAPABILITIES`: it is the
mechanism for agreeing on capabilities, not one of the things that can be agreed
on. It appears in the card as its own `negotiation` descriptor.

## Decision: 409, not 403, for no agreement

Two well-formed capability sets with nothing in common is not an authorization
failure and should not read as one. The caller was allowed to ask; the honest
answer is that there is no overlap. A malformed request stays 400.

## The card's `unsupported` list did its job

P0-C asserted the card's `unsupported` list exactly, on the stated grounds that
shipping a deferred unit should require deleting its line. Shipping P0-D failed
that assertion until `capability-negotiation` was removed — the mechanism worked
as designed rather than leaving a quietly stale document.

`task-lifecycle`, `idempotency-keys`, `cancellation`, `streaming` and `json-rpc`
remain listed. They are P0-E through P0-G.

## Decision: enablement flags moved into one `authContext`

P0-C claimed that P0-D..P0-G could add routes without touching `server.js`. A
third named enablement flag would have broken that promise on the very first
route after it, so `lib/a2a/routes.js` now publishes one spreadable
`authContext` object and `server.js` spreads it. `server.js` stays at 1099
lines; the `scripts/check-file-size.js` ledger is not widened.

`test/a2a-exchange-route.test.js` asserted the old literal flag name as evidence
that enablement reaches the auth policy. The assertion follows the flag to its
new owner rather than being dropped.

## Also fixed on the P0-C branch

`package.json`'s `files` is an explicit allowlist, not a directory glob. The
P0-C modules were missing from it, which made the installed tarball's
`server.js` unloadable — the exact hazard `exchange-route.js` documents when it
defers its own `require` of `lib/v5`. Caught by
`test/kernel-facade-contract.test.js`; the P0-D modules are listed too.

## Validation

```bash
node --test test/a2a-negotiate-route.test.js                      13/13 pass
node --test test/a2a-agent-card-route.test.js \
            test/a2a-exchange-route.test.js \
            test/route-auth-policy.test.js \
            test/module-reachability.test.js                      67/67 pass
node --test test/kernel-facade-contract.test.js                   27/27 pass
npm run conformance:a2a                                           50/50, unchanged
node scripts/check-file-size.js                                   ledger not widened
node scripts/check-import-cycles.js                               no cycles
```

Full-suite failures on this branch are byte-identical to the set on `main` in
the same environment (152 either way, all environment-dependent). P0-D adds
none and fixes none of them.

## Non-claims

This document does not claim that a task lifecycle, idempotency keys,
cancellation, retry semantics or a framing layer exist; that any external agent
has negotiated with this repository; that an agreement is durable or remembered
across requests (it is not — that would be P0-E); or that any third party has
verified anything.
