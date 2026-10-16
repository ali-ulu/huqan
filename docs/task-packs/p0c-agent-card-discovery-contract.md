# P0-C — Agent Card and its discovery route

## Purpose

P0-A froze the A2A transport scope and deferred five units. This is the first of
them: an Agent Card document and the route that serves it.

`docs/task-packs/p0a-a2a-production-transport-scope-freeze.md` remains binding.
This document records what P0-C implemented and, more importantly, the two
decisions in it that would otherwise read as oversights.

## Source reality at the start of P0-C

Verified from live source, not from roadmap prose.

- `POST /api/a2a/exchange` existed (`lib/a2a/exchange-route.js`), wired through
  `server.js` and gated by `lib/http/route-auth-policy.js`.
- No Agent Card document and no `.well-known` route of any kind existed.
- `authority.expectedTarget` (`agentId`, `identityRef`, `identityHash`,
  `workspaceId`) and `authority.authorityId` already described the receiver, and
  `lib/a2a/bounded-exchange.js` already bound incoming exchanges against them.

## What P0-C added

| Surface | Location |
|---|---|
| Agent Card document builder | `lib/a2a/agent-card.js` |
| `GET /.well-known/agent-card.json` | `lib/a2a/agent-card-route.js` |
| Composed A2A mount point | `lib/a2a/routes.js` |
| Route auth rule `a2a-agent-card` | `lib/http/route-auth-policy.js` |
| Route-boundary contract tests | `test/a2a-agent-card-route.test.js` |

## The governing property

A card is a claim about a deployment. The failure mode that matters is a card
that claims more than the deployment does, so the design removes the ways that
could happen:

1. **Identity is not invented.** The card is built from
   `authority.expectedTarget`, the same record the evaluator binds an exchange
   against. A card and a rejection cannot disagree about who this agent is.
2. **Capability cannot outrun wiring.** The card is served only when the same
   configuration the exchange route needs is present — authority *and* replay
   directory. A deployment where `/api/a2a/exchange` answers 404 has no card to
   advertise it with.
3. **Absence is stated, not omitted.** `unsupported` names
   `capability-negotiation`, `task-lifecycle`, `idempotency-keys`,
   `cancellation`, `streaming` and `json-rpc`. A consumer learns what is missing
   by reading, not by failing a request. Shipping one of those units requires
   removing its line, which makes the card's growth reviewable.

## Decision: the card is authenticated

A `.well-known` path conventionally implies a public one. This one is not.

Invariant 6 of the P0 scope freeze says no A2A route is public, and the card
names an agent, its workspace and the exact identity hash an exchange binds
against. Serving that to an unauthenticated caller is a disclosure decision with
its own threat model. It is therefore left to be made explicitly rather than
inherited from a URL convention.

An unconfigured deployment answers **404, not 401**, matching the exchange
route: a 401 on an unserved path would confirm the surface exists.

A publicly readable card remains possible as a later, separately authorized
decision. P0-C does not make it.

## Decision: the A2A surface is composed behind one mount point

The obvious shape — a second constant, a second enablement flag and a second
dispatch line in `server.js` — grew `server.js` from 1099 to 1103 lines and
failed `scripts/check-file-size.js`, whose ledger P0-A invariant 9 forbids
widening.

`lib/a2a/routes.js` composes the boundaries instead, so `server.js` carries
exactly one A2A require, one construction, one enablement pair and one dispatch
line. P0-D through P0-G can add routes without touching `server.js` again.

This inserted a hop into the production call chain that
`test/a2a-exchange-route.test.js` asserts. The hop is now asserted rather than
assumed: a composite that stopped requiring the exchange route would leave the
V5 modules unreached with every other assertion in that test still passing.

## What P0-C did not do

- It did not add capability negotiation. Advertising is not negotiation; P0-D
  owns that.
- It did not publish trusted keys or any trust-root material. A key set is a
  disclosure decision and belongs with P3's registry work.
- It did not change any evaluation rule, reason code or wire format.
- It did not introduce non-default workspace authority.
- It did not graduate any module off `lib/module-reachability.js::NOT_YET_WIRED`.
  P0-C reaches nothing that P0-B did not already reach.

## Validation

```bash
node --test test/a2a-agent-card-route.test.js   # 11 pass
node --test test/a2a-exchange-route.test.js test/route-auth-policy.test.js test/module-reachability.test.js
npm run conformance:a2a                         # 50/50, unchanged
node scripts/check-file-size.js                 # ledger not widened
node scripts/check-import-cycles.js
```

`server.test.js` has 7 pre-existing failures on this branch's base. They are
unchanged by P0-C — the same 7 fail with these changes stashed — and are not
claimed as fixed here.

## Non-claims

This document does not claim that capability negotiation, a task lifecycle,
idempotency keys, cancellation, retry semantics or a framing layer exist; that
the card has been consumed by any external agent; that any third party has
verified anything; or that a public discovery surface has been authorized.
