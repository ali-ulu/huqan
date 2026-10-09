# Trust signals: heuristics inform, the kernel decides

Status: implementation. Declared confidence and the robustness probe are
observation-only; the own-weight semantic model is shipped, default `shadow`,
with an optional review-priority hint in `on`. No gate reads these signals yet.

## Rule

Heuristic and statistical signals may **inform** a decision; they never
**make** one. The deterministic kernel (`kernel.js` →
`lib/memory-admission-gate.js` → `lib/verdict/action-verdict.js` →
`lib/receipt/canonical-receipt.js`) remains the only authority for
allow/review/block/quarantine. Every signal below is recorded alongside
the decision, never inside it.

## Signal 1 — declared confidence (F1a, shipped)

The caller's own confidence claim ("I am 94% sure"), recorded verbatim as
`declaredConfidence` on edge provenance and admission-receipt metadata,
with `declaredConfidenceSource: explicit | absent`.

Why a separate field: the gate reads `confidence` (the policy/system
value, possibly capped — e.g. 0.2 on an invalid sourceType). A capped
value destroys the (declaration, outcome) pairing that calibration needs,
so the raw claim is kept apart. Recording a declaration changes no
decision today; that is pinned by
`test/provenance-declared-confidence.test.js`.

## Signal 2 — robustness probe (F2/F3, shipped, opt-in)

`lib/trust-signals/robustness.js` stress-tests a claim through `verify()`
with deterministic perturbations (negation, numeric value-swap, entity
swap via `OPPOSITION_PAIRS`) and scores the **status flip, not the
confidence number**. F0-B measured why: verify confidence is
verdict-certainty, so a correctly-flipping claim keeps high confidence
under contradiction — a naive confidence-decay metric scores it the same
as a claim that never flips.

Wiring (F3): `kernel.verify(stmt, { robustness: true })` attaches the
report to envelope `meta.robustness`. Default calls are byte-identical;
the probe takes a verify function and cannot write to any graph. No gate
consumes the score yet.

## Signal 3 — own-weight semantic model (R51/R55, shipped, default shadow)

The local model runs alongside the live contradiction/verify rules. Core asks
[`lib/semantic-model-port.js`](../lib/semantic-model-port.js) for a typed signal;
it never requires the Application-side model. The provider is installed by
[`agentRuntime.js`](../agentRuntime.js) for server/MCP/CLI and by
[`index.js`](../index.js) for package-root library consumers.

- `HUQAN_SEMANTIC_MODEL=off|shadow|on` selects the mode. The default is
  `shadow`; an unknown value falls back to `off`. `off` omits `semanticModel`
  and leaves the rules-only output byte-identical. `shadow` computes and
  reports the signal without changing decisions or review priority.
- The signal carries `authority: CANDIDATE_ONLY`. In every mode, rule-derived
  `status`, `confidence`, `signals` and `summary` stay unchanged: the model
  appears beside them, never as a rule signal or input to a gate.
- Only `on` plus a calibrated `CONFIDENT` band and a `CONTRADICTION` label
  yields nonzero `reviewPriority` (the contradiction probability). This is a
  review-ordering hint; it never rejects, blocks or overrides the kernel.
- Missing, corrupt or unsupported model artifacts, unsupported inputs, and
  prediction/calibration errors produce `ABSTAIN` with a `reason`. Missing or
  insufficient calibration keeps the prediction in the `ABSTAIN` band with
  `uncalibrated` or `calibration_insufficient`, and priority stays zero.
- [`lib/semantic-model-provider.js`](../lib/semantic-model-provider.js) reads
  `HUQAN_SEMANTIC_MODEL_FAMILY` at provider creation; the default is `SSM`.
  `LOGISTIC_V2` is opt-in and routes Turkish/English pairs to their own
  artifacts and calibrators; unsupported languages abstain.

[`lib/semantic-signals.js`](../lib/semantic-signals.js) adds `semanticModel`
beside the rule `summary`. [`lib/verify-native.js`](../lib/verify-native.js)
evaluates at most 16 stored-edge/incoming-statement pairs and adds the strongest
model signal separately to semantic trust. With a pair to compare,
[`lib/verify-result.js`](../lib/verify-result.js) exposes its receipt projection
as `meta.trustReceiptPreview.semanticModel`: `artifactDigest`, `family`, `mode`,
`band`, `p`, `reviewPriority` and `reason`. The field is absent in `off`.

The [R55 holdout result](task-packs/semantic-model-result-r55.md) is
**STAY_SHADOW**: default mode remains `shadow` and default family remains `SSM`.
Shipping the signal does not claim a measured gain or authorize gate use.

## Explicitly not claimed

- **No calibrated declared-confidence scores yet.** F0-A measured zero
  (declaration, outcome) pairs in the repository (43 receipts, none carrying
  confidence). Isotonic/Platt fitting starts only after declarations
  accumulate against outcomes in production.
- **No signal-consuming gate policy thresholds yet.** Numbers like 0.75/0.40
  are undecided; shipping thresholds without the decision logic that consumes them
  would be dead configuration. They land together, in a later step.
- **No quantum anything.** Earlier drafts used quantum-inspired
  language for these signals; it was rejected: a security layer owes
  auditors statistics, not metaphors.

## Graduating a signal to a decision (future work)

This gate-policy track remains future work; the semantic model's `on` mode
only enables the review-priority hint above.

1. Accumulate (declaredConfidence, outcome) pairs from production traffic.
2. Fit per-agent calibration; report ECE before/after.
3. Propose thresholds with measured false-block rates; review.
4. Only then let a gate read a signal — behind a policy flag, default off.
