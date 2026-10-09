# Trust signals: heuristics inform, the kernel decides

Status: implementation (observation and review-priority hints; own-weight
semantic model shipped, default `shadow`). No gate reads these signals yet.

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

The live contradiction/verify path reports a local, own-weight model through
the Core port in `lib/semantic-model-port.js`. Core never requires the
Application model directly: `agentRuntime.js` installs the provider for
server/MCP/CLI, and `index.js` installs it for package-root library consumers.
`lib/semantic-model-provider.js` loads the packaged weights lazily for local
inference, without a network call.

- `HUQAN_SEMANTIC_MODEL=off|shadow|on` selects the mode. Unset or empty means
  `shadow`; an unknown value fails closed to `off`. `off` omits the model
  field and preserves the rules-only output; `shadow` computes and reports
  the signal without changing decisions or review priority.
- `HUQAN_SEMANTIC_MODEL_FAMILY` selects the family (default `SSM`). R55's
  `LOGISTIC_V2` is opt-in and routes English/Turkish pairs to their respective
  packaged artifacts and calibrators. The
  [R55 holdout result](task-packs/semantic-model-result-r55.md) is
  `STAY_SHADOW`: the default mode remains `shadow` and the default family
  remains `SSM`.
- The signal has `authority: CANDIDATE_ONLY`. `lib/semantic-signals.js`
  attaches it as `semanticModel` beside the rule `summary`, never in the
  rule `signals` or their confidence. `lib/verify-native.js` evaluates at
  most 16 stored-edge/incoming-statement pairs per verify and attaches the
  strongest result separately; rule-derived `status`, `confidence`, and
  `signals` remain unchanged in every mode. No gate consumes the model.
- Only `on` with a calibrated `CONFIDENT` band and a `CONTRADICTION` label
  produces a nonzero `reviewPriority` hint. Every other case has priority
  zero. The hint can inform review ordering; it never rejects, blocks, or
  overrides the rules.
- Once a provider is registered, missing, corrupt, or unsupported artifacts,
  unsupported input, and prediction/calibration errors report `ABSTAIN`
  with a `reason`. Missing or insufficient calibration also leaves the
  band at `ABSTAIN`; a raw prediction is not a calibrated decision.
- `lib/verify-result.js` adds the receipt projection to
  `meta.trustReceiptPreview.semanticModel`: `artifactDigest`, `family`,
  `mode`, `band`, `p`, `reviewPriority`, and `reason`. The digest identifies
  the weights when available; load failures may leave it null. The field
  is absent in `off`, or when there is no registered provider or no edge
  pair to evaluate.

## Explicitly not claimed

- **No per-agent declared-confidence calibration yet.** F0-A measured zero
  (declaration, outcome) pairs in the repository (43 receipts, none carrying
  confidence). Isotonic/Platt fitting starts only after declarations
  accumulate against outcomes in production.
- **No policy thresholds yet.** Numbers like 0.75/0.40 are undecided;
  shipping thresholds without the decision logic that consumes them
  would be dead configuration. They land together, in a later step.
- **No quantum anything.** Earlier drafts used quantum-inspired
  language for these signals; it was rejected: a security layer owes
  auditors statistics, not metaphors.

## Graduating a signal to a decision (future work)

1. Accumulate (declaredConfidence, outcome) pairs from production traffic.
2. Fit per-agent calibration; report ECE before/after.
3. Propose thresholds with measured false-block rates; review.
4. Only then let a gate read a signal — behind a policy flag, default off.
