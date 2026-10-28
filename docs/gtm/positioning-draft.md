# GTM draft — "stops the risky action before it runs"

> **Status: draft for review.** This is a positioning draft, not a published
> claim. It does not change the README, the site or any living document. Two
> items are deliberately left to others: publishing the commercial licence
> (needs legal sign-off) and any price figure. Do not lift a sentence from here
> into a public surface without the review this file is asking for.

## The one line

**HUQAN stops a risky agent action before it runs, and records why it did.**

That is the whole pitch. Everything below is support for it, and everything in
the product that does not support it is out of scope for this message.

## Why this line, and not "AI safety" or "agent observability"

- *Agent observability* describes what already happened. A log of a deleted
  production database is a fine log and a bad outcome.
- *AI safety* is a research field, not a purchase order.
- **"Stops the risky action before it runs"** is a decision an operator can
  check: either the deploy ran or it did not.

The product's own vocabulary already says this. The pre-execution guard
(`huqan-gate`) returns allow / review / block *before* the tool call executes,
and the emergency stop stops an agent mid-loop. The message should name the
same moment the product does: **before**.

## The two packages

Both packages are the same gate. They differ in who is accountable when a
person is not there.

### Solo — the individual brake

For one developer with one agent on one machine.

- The agent's mutating calls are **held** for review until the person approves
  them.
- `huqan.emergency_stop` stops one agent, or a whole workspace, in one call.
- Every decision leaves a **Trust Receipt** — a local record verifiable from the
  receipt itself.
- Runs locally. No cloud, no API key, no account.
- The break-glass window is the documented way to clear a **review-eligible**
  step on a red-CI evening without turning the gate off: it can relax a held
  `review` into an `allow`, but a `block` stays blocked. Time-boxed, scoped,
  reason required, every use recorded (`docs/break-glass-runbook.md`).

The solo buyer's sentence: *"I want my agent to be useful, and I want it to
stop when I would have stopped it."*

### Institution — the record the operator does not write

For a team or an enterprise where the question is "who approved this, and can
we prove it".

- Where the Approval Authority (an OS service, ADR-016) is installed and
  answering, it takes the approval decision off the agent's own user account.
  The agent cannot approve its own actions only when it also runs as a separate
  OS user (ADR-017). With no installed authority, the runtime runs in legacy
  mode and same-user agents can approve their own actions.
- A Trust Receipt is produced by the gate that made the decision and held
  locally; the record of an action is not the agent's own account of it.
- The same guard covers deploys, force-pushes, destructive deletes and secret
  writes, and refuses them where a human has not decided.
- Evidence ships where the operator wants it: signed receipt batches to a
  collector, or a SIEM sink.

The institution buyer's sentence: *"I need a record of what the agent tried to
do that the agent cannot rewrite, and a gate that refuses the rest."*

## What we do not claim

The credibility of the line depends on the honesty of this list.

- **Not "the agent cannot do harm".** A block is a block, but the guard is
  software on the same machine; the honest claim is "the risky action did not
  run and the record says why", not "nothing can go wrong".
- **Not "zero false alarms".** The measured baseline (see
  `docs/audits/false-alarm-rate-ip1-20261027.md`) is published, not hidden: the
  default bundled policy stopped 113 of 703 safe calls (16.07%), and the
  `team-ci` allowlist template lowers that to 30 of 703 (4.27%). The İP-1 work is
  about lowering that share — not about pretending it is zero.
- **Not "a model decides".** Nothing here calls a model to decide. The decision
  is rules and a recorded policy, which is why it is reproducible.
- **Not "unbounded override".** A break-glass window is bounded in time, scope,
  reason and uses, and it cannot turn a block into an allow.
- **Not a price or a licence.** Those are out of scope for this draft.

## The demo script (90 seconds)

The message is only as good as the moment it names, so the demo should be that
moment and nothing else.

1. Ask the agent to run a mutating command the gate holds for review, such as
   `npm run migrate`.
2. Show it **held** (a `review`), with the receipt naming the rule that held it.
3. Approve it (or do not) and show the receipt of the decision.
4. Ask the agent to run a destructive delete; show it **blocked**, not held.
5. Open a break-glass window for a hotfix; show `npm test` run and a deploy
   (e.g. `npm publish`) still **blocked**.

Step 5 is the one that separates this from a plain allowlist, and it is the one
to keep if the demo must be cut to 30 seconds.

## Open questions for review

- Which package does the landing page lead with? The solo brake is the sharper
  story; the institution record is the larger contract.
- Does "before it runs" hold for every surface, or only the pre-execution guard?
  The MCP dispatch and the step executor also stop actions, so the claim should
  name the guard family rather than one binary.
- Where does the commercial licence fit? Not answered here.
