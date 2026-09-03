# What HUQAN learns, what it does not, and why

HUQAN is a deterministic admission engine that adapts. Both halves of that
sentence are load-bearing, and the reasoning for each part currently lives in
the header of whichever module implements it — four files, four explanations,
no single place that says what the system as a whole is allowed to change about
itself.

This is that place.

## The short answer

**HUQAN has no trainable parameters.** There is no neural network, no gradient,
no backpropagation, no tensors, no weights file, no model artifact. There is no
training phase. `npm run train` runs `scripts/knowledge-graph-demo.js --demo`
and is a demo, not training.

**HUQAN does learn**, in three separate and bounded senses. Only the third one
changes how the engine decides anything:

| | what changes | driven by | changes a decision? |
|---|---|---|---|
| Fact accumulation | the graph's contents | admitted `huqan.learn` writes | no |
| Derived representation | node embeddings and weights | recomputation over the graph | no |
| Parameter adaptation | three hypothesis thresholds | human accept/reject decisions | **yes** |

The sharpest way to put it: **the part of HUQAN that learns is the policy, not a
model — and its teacher is not data, it is a person's accept/reject decision.**

## 1. Fact accumulation — not learning

`huqan.learn` writes nodes and edges into the graph, through the admission
boundary, with a receipt. The graph gets larger and answers change because it
knows more.

Nothing about the engine's behaviour changes. The same policy, the same gates,
the same thresholds evaluate the same way before and after. Calling this
"learning" would make the word mean "storing", and would obscure the one place
where behaviour genuinely does drift.

## 2. Derived representation — recomputed, not trained

Two things look like learned parameters and are not.

**Embeddings.** `dream.js` assigns each node a vector computed deterministically
from co-occurrence counts and a node signature, then L2-normalises it
(`dream.js:108-123`). `lib/graph-node-similarity.js` runs cosine similarity over
those vectors. No optimiser, no objective function, no fitting: the same graph
produces the same vectors every time. Change the graph and they change, the way
a `SUM()` changes.

**Node weights.** `lib/graph-node-weight.js` is `weight * exp(-λ * elapsed)`,
clamped to `[0, 1]`. A decay formula, not a learned value.

Both are derived state. They can be thrown away and rebuilt, which is the test
that separates them from anything trained.

## 3. Parameter adaptation — the only loop that changes a decision

Four modules, deliberately separated so that each stage can only do one thing.
This is the whole of it:

```
lib/hypothesis-feedback.js     which rules people keep rejecting   read-only
        │
        ▼
lib/hypothesis-tuning.js       a concrete threshold proposal       advice only
        │
        ▼
lib/fractal-learn-autotune.js  applies the signal, one direction   returns, never writes
        │
        ▼
lib/hypothesis-thresholds.js   makes it stick                      only on `--apply`
```

**The surface is three numbers.** `generateHypotheses` accepts exactly three
tunable options (`lib/graph-hypotheses.js`): `confidenceFloor`,
`criticalInDegree`, `smallComponentSize`. Every proposal names one of them and
stays inside the bounds that function already enforces, so a suggestion applied
verbatim cannot be silently clamped back to the default. Nothing else in the
system is adaptable — not a gate, not a risk classification, not a policy rule.

### Three constraints, each deliberate

**Tightening only.** A rule people keep rejecting is firing too often, and the
proposal moves its threshold so it fires less. The opposite move is never made
automatically: acceptance says the findings were *right*, not that more findings
are waiting, and inferring the second from the first is not supported by the
evidence. `fractal-learn-autotune.js` states it as a rule — tightening signal
raises `minScore` and lowers `entropyFloor`; no signal, or malformed advice,
changes nothing.

**Advice, never application.** `hypothesis-tuning.js` writes no threshold, no
config file, nothing. Making the engine change its own thresholds is a
materially different thing to build, with its own admission and approval story,
and it is deliberately not built.

**Refuse rather than repair.** A threshold store that will not parse, or that
holds a value `generateHypotheses` would reject, fails closed. Silently
resetting it would discard a decision somebody made; silently clamping it would
run the engine on a threshold nobody chose. Both are worse than stopping.

### The cost this imposes, and what watches it

One-directional tightening has a failure mode: the gate gets stricter over time
and nothing gets looser, so usability decays in a direction no test looks at. A
guard that blocks 3% of legitimate work and one that blocks 30% both report
green.

`npm run check:benign-false-block-rate` is the counterweight (#1822). It runs
ordinary developer actions through the real decision path and ratchets the share
that needs a human. At the recorded baseline that share is **7 of 18 (38.9%)**,
and every one of those costs is spelled `review` — the guard blocks no benign
action at all, so a metric counting only `block` would have reported it as free.

If automatic tightening ever pushes that number up, the ratchet fails. That is
the guardrail that makes the adaptation loop safe to have at all.

## What HUQAN deliberately does not do

The neuro-symbolic literature describes four ways a deterministic engine can be
learned rather than written. Measured against them:

**Automaton inference from data (Q-learning over a DFA).** Not present, and not
a fit. HUQAN's deterministic layer is not an automaton with states and
transitions to infer; it is an admission policy. There is no transition table
that data could fill in.

**Auto-formalisation with compiler feedback.** Half present. The diagnostic half
exists — `lib/self-healer/` classifies findings and decides what to do about
them. The applying half is absent on purpose:
`lib/self-healer/safety-decision.js` can return "record it", "ask a human", or
"refuse", and there is deliberately **no `apply` or `auto_fix` decision level**.
Unplaceable findings default to `require_review`, never to `propose`.

**Neuro-symbolic policy learning with a projection operator.** Present, and
inverted. In the literature the projection operator maps an unsafe proposed
action onto the nearest safe one, automatically, during training. HUQAN has the
shape but refuses the automatic half: the deterministic layer never relaxes to
accommodate a proposal, and a proposal that a threshold change would admit waits
for a person.

**Inductive logic programming.** Not present. Hypotheses are generated
(`lib/graph-hypotheses.js`, the dream loop), but over *facts in the graph*, not
as rule synthesis. No rule the engine enforces was derived from examples.

## Why the constraint, and not just caution

A receipt says *policy X decided this*. That statement is only worth what the
stability of X is worth. An engine that rewrites its own policy from data
produces receipts whose meaning drifts underneath them — the record still says
"policy X", and X is no longer the thing the reader thinks it is.

This is the same distinction `metadata.effectVerification` draws one layer down
(#1819): a receipt records what was *reported*, and says so, rather than
implying it was *observed*. Applied to policy, the equivalent honesty is that a
threshold changed because a named person applied it on a date, not because the
system drifted there.

That is not an argument against ever learning more. It is the reason the current
loop stops where it does, and the bar any extension has to clear: a learned rule
has to be as attestable as a written one, or the receipt stops meaning what it
says.

## Verifying the claims here

```
grep -rlE "gradient|backprop|neural|tensor" --include=*.js lib/ *.js   # no matches
node -p "require('./package.json').scripts.train"                      # a demo
node --test test/hypothesis-tuning.test.js
node --test test/fractal-learn-autotune.test.js
npm run check:benign-false-block-rate
```
