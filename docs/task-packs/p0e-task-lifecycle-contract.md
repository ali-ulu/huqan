# P0-E — task lifecycle and task ids

## Purpose

Give a bounded A2A exchange a durable, readable record: a task id, a state, and
a route to look it up.

`docs/task-packs/p0a-a2a-production-transport-scope-freeze.md` remains binding.
This document records the implementation and, above all, the one thing P0-E
refused to do.

## Source reality at the start of P0-E

Read from live source.

- `lib/a2a/replay-store.js` reserves a `sha256` replay key by exclusive-create
  (`wx`). A second reserve returns `{reserved:false}`.
- `lib/a2a/bounded-exchange.js` computes that key from the *entire* signed
  request plus `authority.authorityId`, reserves it **before** running the
  effect, and returns `replay_detected` if the reservation fails.
- If the effect throws, the reservation is deliberately left standing. The
  conformance case `effect_failure_keeps_replay_marker` pins this.
- No task id, task record, task state or read route existed anywhere.

## The property P0-E had to not break

The three points above are one decision: **at-most-once**. When an effect's
outcome is unknown, this system refuses to retry and refuses to guess. That is a
security and correctness property, not an implementation detail.

The usual reading of "idempotency keys" would undo it. Returning a stored
success for a retried request requires knowing the first attempt succeeded — and
the single case where that is unknowable is exactly the case the marker exists
for. A key that resolved that case by assuming success would convert
at-most-once into at-least-once silently.

So P0-E ships **task lifecycle and task ids, and deliberately not
caller-supplied idempotency keys**. `idempotency-keys` remains in the Agent
Card's `unsupported` list with that reason recorded in source.

What was actually missing was not retry — it was *accounting*. A caller that lost
its response had only one move, resending, and only one answer,
`replay_detected`. Now resending is still refused and asking is answered.

## What P0-E added

| Surface | Location |
|---|---|
| Durable task records | `lib/a2a/task-store.js` |
| `GET /api/a2a/tasks/{taskId}` | `lib/a2a/task-route.js` |
| Task id in the admitted effect | `lib/a2a/exchange-route.js` |
| Card `tasks` descriptor | `lib/a2a/agent-card.js` |
| Route auth rule `a2a-task-read` | `lib/http/route-auth-policy.js` |
| Contract tests | `test/a2a-task-lifecycle.test.js` |

## Design decisions

**Completion is a second file, not a rewritten reservation.** The reservation's
`wx` create *is* the replay guarantee. Appending an outcome to it would put that
guarantee behind a second, non-atomic write. A `.completed` file leaves the
reservation's bytes and semantics untouched, and a deployment that upgrades
mid-flight simply has reservations with no completion — which reads as
`unknown`, the correct answer for a task it cannot account for.

**The task id is not the replay key.** They are one-to-one, but a task id is
handed out and a replay key is security-relevant state. The id is a
domain-separated hash of the key, so an id cannot be replayed back as a
reservation probe.

**The replay key is captured, not recomputed.** `evaluateBoundedExchange` calls
`effect()` with no arguments, so the route wraps `replayReserve` to capture the
key on its way into the reservation. Recomputing it would mean a second copy of
`replayKeyMaterial`, and a task id derived from a drifted key would point at
nothing. **`lib/a2a/bounded-exchange.js` is not modified.**

**The completion is written inside the effect.** If the record cannot be
written, the exchange is not accounted for, and an unaccounted exchange must
read as unknown rather than as a success. A throw there leaves the reservation
standing — the existing `effect_failure_keeps_replay_marker` behaviour, reused
rather than reimplemented.

**`unknown` is served with 200.** The lookup succeeded; the honest state is
unknown. A 5xx would invite exactly the retry this design refuses.

**`not_found` stays distinct from `unknown`.** "Never happened" and "happened,
outcome unknown" lead an operator to different decisions, so they never collapse
into one answer.

**There is no `working` state.** The exchange is evaluated synchronously. An
intermediate state would describe a concurrency this route does not have.

**The read route is authenticated.** Task ids are unguessable, but
unguessability is not an authorization decision and must not be used as one.

## Validation

```bash
node --test test/a2a-task-lifecycle.test.js                        10/10 pass
node --test test/a2a-agent-card-route.test.js \
            test/a2a-negotiate-route.test.js \
            test/a2a-exchange-route.test.js \
            test/route-auth-policy.test.js \
            test/module-reachability.test.js                       78/78 pass
node --test test/kernel-facade-contract.test.js                    27/27 pass
npm run conformance:a2a                                            50/50, unchanged
node scripts/check-file-size.js                                    ledger not widened
node scripts/check-import-cycles.js                                no cycles
```

`npm run conformance:a2a` staying at 50/50 is the load-bearing result here, not a
formality: `effect_failure_keeps_replay_marker` and
`replay_survives_receiver_clock_advance` are the cases that would break first if
task records had weakened the replay guarantee.

Full-suite failures in this environment are 151 against `main`'s 152; the
difference is `live Git validation reports an older checkpoint ancestor without
self-blocking`, which depends on checkout state rather than on this change. No
new failure is introduced.

## Non-claims

This document does not claim that caller-supplied idempotency keys, cancellation,
retry semantics or a framing layer exist; that a task record makes a replayed
exchange succeed (it does not); that an `unknown` task can later resolve to
`completed` (it cannot); or that any third party has verified anything.
