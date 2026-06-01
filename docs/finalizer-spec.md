# AXIOM Finalizer Spec

## Summary

AXIOM core already knows how to:
- ask for known facts
- verify claims
- return `bilinmiyor` instead of hallucinating
- reason and dream when evidence is partial

The missing piece is the final synthesis layer: a deterministic report generator that turns tool outputs into an answer a human can read.

This spec defines that layer.

## Goal

Convert tool results into a structured summary that clearly separates:
- known facts
- unknowns
- evidence
- conclusion
- next questions

The finalizer should not invent new reasoning.
It should only summarize what the agent already learned.

## Problem Statement

Current agent behavior can finish a task but still end with:
- a weak summary
- no synthesis
- incomplete compare/reason output

That is acceptable for the core engine but not for a product user.

The finalizer layer must fix that gap.

## Output Contract

Finalizer output should be deterministic and testable:

```json
{
  "mode": "graph-backed | llm-assisted | insufficient-data | contradicted",
  "knownFacts": [],
  "unknowns": [],
  "evidence": [],
  "conclusion": "",
  "nextQuestions": []
}
```

Optional companion fields:
- `confidence`
- `sourceSummary`
- `selectedTools`
- `warnings`

## Requirements

### 1. Deterministic synthesis

The finalizer must summarize the run without changing the underlying verdict.

### Acceptance Criteria
1. Completed runs always get a structured final summary.
2. Unknown or unsupported claims stay marked as unknown.
3. Contradicted claims stay contradicted.
4. LLM assistance does not override graph evidence.

### 2. Known facts extraction

The finalizer must extract facts that the agent actually established.

### Acceptance Criteria
1. Facts come from verified tool outputs or graph-backed evidence.
2. Facts are deduplicated.
3. Facts are written in short, human-readable form.

### 3. Unknowns extraction

The finalizer must list what the agent could not prove.

### Acceptance Criteria
1. Missing evidence is explicit.
2. Unknowns are not hidden inside generic prose.
3. Unknowns are phrased as follow-up questions when possible.

### 4. Evidence summary

The finalizer must preserve the evidence trail.

### Acceptance Criteria
1. The summary includes the strongest supporting evidence.
2. Evidence order is stable enough for tests.
3. Evidence is not rewritten into fiction.

### 5. Mode labeling

The finalizer must label the answer mode clearly.

### Acceptance Criteria
1. `graph-backed` means graph evidence was sufficient.
2. `llm-assisted` means the graph helped but the LLM contributed.
3. `insufficient-data` means there was not enough evidence.
4. `contradicted` means the graph or rule system rejected the claim.

## Design

### Runtime shape

```
workflow-agent
  -> tool results
  -> finalizer
  -> structured summary
```

### Behavior

- If the agent has enough graph evidence, the finalizer should prefer graph-backed wording.
- If evidence is partial, the finalizer should say so directly.
- If the result is contradicted, the finalizer should explain the contradiction briefly.
- The finalizer should not mask uncertainty with fluent language.

## Suggested Examples

### Example 1 - Sufficient evidence

```txt
Known facts:
- covid19 yüksek ateş yapar
- covid19 kuru öksürük yapar

Conclusion:
covid19 ile uyumlu semptomlar var.

Next questions:
- hasta_ahmet kuru öksürük gösteriyor mu?
```

### Example 2 - Insufficient data

```txt
Known facts:
- covid19 yüksek ateş yapar

Unknowns:
- grip için yeterli veri yok

Conclusion:
Mevcut bilgi yetersiz.
```

### Example 3 - Contradiction

```txt
Known facts:
- kiraci alt kiralayamaz

Conclusion:
Bu ifade graf ile çelişiyor.
```

## Scope

This layer should be small and local-first:
- no new symbolic core
- no new LLM dependency
- no discovery redesign
- no UI rewrite

## Acceptance Criteria

1. A completed workflow always returns a structured final summary.
2. The summary clearly separates known facts from unknowns.
3. The summary preserves contradiction and uncertainty.
4. The summary is deterministic enough to test.
5. The finalizer improves the user experience without changing the core verdict logic.

