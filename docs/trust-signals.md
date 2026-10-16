# Trust signals: heuristics inform, the kernel decides

Status: shipped signals, including the live own-weight semantic model (R51/R55,
default shadow). No gate reads these signals; model output is candidate-only,
with an optional review-priority hint in on mode.

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

`HUQAN_SEMANTIC_MODEL=off|shadow|on` selects the mode. The default is
`shadow`; an unknown value fails closed to `off`. `HUQAN_SEMANTIC_MODEL_FAMILY`
selects the model family (default `SSM`). The R55 holdout decision is
**STAY_SHADOW**: neither default changed; see
[`semantic-model-result-r55.md`](task-packs/semantic-model-result-r55.md).

The Application-side provider loads local own-weight artifacts and is installed
by `agentRuntime.js` for server, MCP and CLI paths. Core calls the provider
through `lib/semantic-model-port.js`; it never requires the Application model.
The output carries `authority: CANDIDATE_ONLY` and sits beside the rule
`summary` as `semanticModel`, never inside the rule `signals`. In every mode,
rule signals, `status` and `confidence` stay unchanged. No gate consumes it.

- `off`: no model field; outputs remain exactly rules-only.
- `shadow`: compute and report the signal; `reviewPriority` stays zero.
- `on`: only a calibrated prediction with `band: CONFIDENT` and
  `label: CONTRADICTION` produces a nonzero `reviewPriority` (the calibrated
  contradiction probability). This is a review-ordering hint; it never rejects,
  blocks or overrides the rules.

Missing, corrupt or unsupported artifacts, unsupported inputs, prediction
errors and calibration failures yield `band: ABSTAIN` with a `reason` instead
of breaking verification. Missing or insufficient calibration also abstains;
the default packaged SSM reports `calibration_insufficient`.

Live verify compares at most 16 stored-edge/claim pairs and attaches the
strongest model signal separately at `meta.semanticTrust.semanticModel`.
`meta.trustReceiptPreview.semanticModel` exposes `artifactDigest`, `family`,
`mode`, `band`, `p`, `reviewPriority` and `reason` so an audit can identify the
weights that answered. The field is absent in `off` mode, with no stored edge
to compare, or when no provider is installed; an artifact-load failure may
leave `artifactDigest` null.

Source: [`semantic-model-port.js`](../lib/semantic-model-port.js),
[`semantic-model-provider.js`](../lib/semantic-model-provider.js),
[`semantic-signals.js`](../lib/semantic-signals.js),
[`verify-native.js`](../lib/verify-native.js),
[`verify-result.js`](../lib/verify-result.js) and
[`agentRuntime.js`](../agentRuntime.js). The contract is pinned by
`test/semantic-model-port.test.js`, `test/semantic-model-live-wiring.test.js`
and `test/semantic-model-calibration-wiring.test.js`.

## Explicitly not claimed

- **No calibrated declared-confidence scores yet.** F0-A measured zero (declaration,
  outcome) pairs in the repository (43 receipts, none carrying
  confidence). Isotonic/Platt fitting starts only after declarations
  accumulate against outcomes in production.
- **No gate policy thresholds for these signals yet.** Numbers like 0.75/0.40 are undecided;
  shipping thresholds without the decision logic that consumes them
  would be dead configuration. They land together, in a later step.
- **No quantum anything.** Earlier drafts used quantum-inspired
  language for these signals; it was rejected: a security layer owes
  auditors statistics, not metaphors.

## Graduating declared confidence to a decision (future work)

1. Accumulate (declaredConfidence, outcome) pairs from production traffic.
2. Fit per-agent calibration; report ECE before/after.
3. Propose thresholds with measured false-block rates; review.
4. Only then let a gate read a signal — behind a policy flag, default off.
