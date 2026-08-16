# P0-F — retry classification and timeouts

## Purpose

Tell a caller, on every refusal, whether resending is safe; enforce and
advertise a request deadline; and record why cancellation is not shipped.

`docs/task-packs/p0a-a2a-production-transport-scope-freeze.md` remains binding.
P0-A named this unit "cancellation, timeout and retry semantics". Two of those
three shipped. The third is a deliberate non-delivery, argued below rather than
quietly dropped.

## The question retry actually answers

Not "should you retry" but **"is it safe to retry"**. Conflating them is how an
at-most-once system becomes at-least-once.

`lib/a2a/bounded-exchange.js` verifies first, reserves the replay key second,
runs the effect third. A refusal is safe to resend exactly when it happened
*before* the reservation: nothing was recorded and no effect ran. Once the
reservation exists the exchange is accounted for whether or not the caller ever
saw the answer, and resending is not a recovery strategy — looking the task up
is, which is what P0-E built.

`safeToRetry: true` therefore means "resending cannot double an effect", not
"resending might work". Most safe refusals are deterministic verification
failures that will fail identically forever. The asymmetry matters: a caller
that treats an unsafe refusal as retryable causes duplicates; one that treats a
safe refusal as unretryable merely gives up early. Only the first is a
correctness bug, which is why the flag is named for safety rather than for
usefulness.

## The classification, and why it fails closed

Two reason codes can be returned at or after the reservation:

| Reason | Why it is unsafe |
|---|---|
| `replay_detected` | The reservation already existed. |
| `verification_failed` | The evaluator's catch-all. A throwing effect is one of the ways it is reached, so the reservation may be standing with no completion. |

Everything else in the evaluator's vocabulary is decided before the reserve
call. Rather than enumerate ~40 verification codes — and risk a future one
defaulting to safe by being absent from a list — the denylist is these two and
an *unrecognised shape* is treated as unsafe. A missing, empty or non-string
reason classifies as possibly-reserved.

Route-level refusals (wrong method, unreadable body, non-canonical workspace)
are safe by structure, not by reason string: they return before the evaluator is
called at all. `classifyTransportRefusal()` takes no argument on purpose, and a
test asserts its arity to keep that honest.

When a refusal is unsafe, the response also carries `taskId`. A caller correctly
told not to retry and given nothing else to do would be worse off than before
P0-E existed. The id is derived only from a replay key that was actually
captured, so an exchange refused before the reserve call has no pointer rather
than an invented one.

An admitted exchange carries no `safeToRetry` at all. Success is not a retry
question, and emitting the flag there would invite resending something that
already succeeded.

## Timeouts

`requestTimeoutMs` (30s) is applied to the socket at the top of the handler,
before the body read begins. It is **enforced, not merely advertised**, and a
test asserts the ordering rather than waiting thirty seconds.

It is applied to the socket rather than through `readJsonBody`, which has no
timeout option: adding one there would change a helper every other route in the
process shares, for the sake of this one route.

The value lives in `lib/a2a/agent-card.js` and the route imports it, following
the precedent `negotiate-route.js` set by importing its path from the card. A
document advertising one deadline while the route enforced another would be
worse than a document advertising nothing.

A timed-out request is dropped before the evaluator is reached, so it provably
never reserved and is safe to resend — the timeout and the retry contract agree
by construction.

## Decision: cancellation is not shipped

There is nothing here to cancel.

The exchange is synchronous — P0-B's deliberate choice — so there is no in-flight
state between submission and answer. And once the replay key is reserved, the
exchange is accounted for and cannot be withdrawn; that is the same at-most-once
decision that blocks caller-supplied idempotency keys. A cancel endpoint whose
only possible answer is "too late" would be theatre, and shipping it would let a
consumer believe in a capability that does not exist.

Cancellation acquires a referent when there is an asynchronous or streaming
surface to cancel. That is P0-G. `cancellation` therefore stays in the Agent
Card's `unsupported` list, with the reason recorded in source.

## Validation

```bash
node --test test/a2a-retry-classification.test.js                  12/12 pass
node --test test/a2a-task-lifecycle.test.js \
            test/a2a-agent-card-route.test.js \
            test/a2a-negotiate-route.test.js \
            test/a2a-exchange-route.test.js \
            test/route-auth-policy.test.js \
            test/module-reachability.test.js                       90/90 pass
node --test test/kernel-facade-contract.test.js                    27/27 pass
npm run conformance:a2a                                            50/50, unchanged
node scripts/check-file-size.js                                    ledger not widened
node scripts/check-import-cycles.js                                no cycles
```

`conformance:a2a` at 50/50 again carries weight: P0-F adds a field to every
refusal, and a change that had altered a reason code or a decision would show up
there first.

## Non-claims

This document does not claim that cancellation, caller-supplied idempotency
keys, streaming or a framing layer exist; that `safeToRetry: true` means a retry
will succeed (it means only that a retry cannot double an effect); that the
evaluation itself is interruptible (it is not); or that any third party has
verified anything.
