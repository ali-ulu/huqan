# Trust signals: heuristics inform, the kernel decides

Status: implementation (observation-only). No gate reads these signals yet.

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

## Explicitly not claimed

- **No calibrated scores yet.** F0-A measured zero (declaration,
  outcome) pairs in the repository (43 receipts, none carrying
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
