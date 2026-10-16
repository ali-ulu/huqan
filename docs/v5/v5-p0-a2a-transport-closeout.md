# V5 P0 — A2A production transport closeout

**Status:** `closeout`

**Canonical base:** `main @ 49f5ba043aeccabc79424eea183bd40766e51c71` — the P0-F
merge (PR #854), the head at which P0's delivered surface was measured. Docs-only:
it records what was shipped and what was deliberately not, and starts nothing.

## Verdict

```text
P0_A2A_PRODUCTION_TRANSPORT: SHIPPED_WITH_ONE_UNIT_DEFERRED
```

P0-B through P0-F are on `main`. **P0-G is deferred on the authority of
`docs/task-packs/p0a-a2a-production-transport-scope-freeze.md` itself**, not
skipped — see the criterion below.

This is a bounded phase claim. It is not a claim that the transport is
externally interoperable, that any third party has spoken to it, or that any
deployment has enabled it.

## Delivered chain

| Unit | Surface | PR |
|---|---|---|
| P0-B | `POST /api/a2a/exchange` | prior |
| P0-C | `GET /.well-known/agent-card.json` | `#850` |
| P0-D | `POST /api/a2a/negotiate` | `#852` |
| P0-E | `GET /api/a2a/tasks/{taskId}`, task ids on admission | `#853` |
| P0-F | `safeToRetry` on every refusal, enforced request deadline | `#854` |

Every route is authenticated, and every one answers 404 rather than 401 when
unconfigured, so a missing configuration does not advertise the surface. All
mount through `lib/a2a/routes.js`, which publishes one spreadable `authContext`;
`server.js` has not changed since P0-D and remains at 1099 lines.

## The invariant the phase was organised around

`lib/a2a/bounded-exchange.js` reserves the replay key **before** running the
effect and leaves the marker standing if the effect throws
(`effect_failure_keeps_replay_marker`). An exchange whose outcome is unknown is
never retried and never guessed at.

Three units in a row had to reason about this, and each was shaped by it rather
than around it:

- **P0-E** built task records as *accounting*, not retry. A replay is still
  refused; the caller can now ask what happened instead of resending.
- **P0-E** refused caller-supplied idempotency keys, because returning a stored
  success for a retried request requires knowing the first attempt succeeded —
  and the one case where that is unknowable is the case the marker exists for.
- **P0-F** named its flag `safeToRetry` — "resending cannot double an effect" —
  rather than a flag that promises a retry might work, and defaulted an
  unrecognised reason to unsafe.

`npm run conformance:a2a` has stayed at 50/50 across all four units. That is the
evidence the invariant survived, not a formality: the replay and effect-failure
cases would break there first.

## Deliberate non-deliveries

Recorded as decisions with reasons in source, not as gaps. All three remain in
the Agent Card's `unsupported` list, which is asserted exactly by
`test/a2a-agent-card-route.test.js` so that shipping one requires deleting its
line.

| Surface | Why not |
|---|---|
| `idempotency-keys` | Would convert at-most-once into at-least-once. See `lib/a2a/task-store.js`. |
| `cancellation` | The exchange is synchronous, so there is no in-flight state, and a reserved exchange cannot be withdrawn. An endpoint whose only answer is "too late" would be theatre. |
| `streaming`, `json-rpc` | P0-G; see below. |

## P0-G's opening criterion

The scope freeze is explicit:

> A framing layer is YAGNI until a second surface needs it; choosing JSON-RPC or
> SSE before there is a caller is a decision made without evidence.

P0-G therefore opens when there is **a named consumer whose requirement selects
the framing** — not on a schedule. Building it earlier would pick a wire format
to satisfy a prediction, and would additionally reopen cancellation and the
at-most-once question on the same speculative basis.

Recording the criterion is the point: a later reader should be able to tell that
P0-G was reasoned about and left closed, rather than forgotten.

## Validation at the canonical base

```bash
npm run conformance:a2a                          # 50/50
node --test test/a2a-retry-classification.test.js
node --test test/a2a-task-lifecycle.test.js
node --test test/a2a-agent-card-route.test.js
node --test test/a2a-negotiate-route.test.js
node --test test/a2a-exchange-route.test.js
node --test test/module-reachability.test.js
node --test test/kernel-facade-contract.test.js
node scripts/check-file-size.js
node scripts/check-import-cycles.js
```

## Reachability

P0 graduated four modules off `lib/module-reachability.js::NOT_YET_WIRED` — the
cryptographic profile contract, the verification adapter, the public trust
receipt importer and the trusted-key resolver — and that happened in P0-B as a
consequence of giving the evaluator a production caller, not as a goal.

P0-C through P0-F graduated none. They reach nothing P0-B did not already reach,
and no entry was removed to shorten the list.

## Non-claims

This record does not claim that P0-G is started or scheduled; that cancellation,
idempotency keys, streaming or a framing layer exist; that the A2A surface is
enabled in any deployment; that an external agent has exchanged, negotiated or
polled anything here; or that any third party has verified anything.
