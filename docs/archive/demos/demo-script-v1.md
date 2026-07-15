# Demo Script v1

## Opening

Models generate. Agents act. Memory stores. HUQAN judges.

## 5–7 Minute Flow

### 1. Problem

AI agents can produce claims, memory writes, and risky actions that look reasonable but are still unsupported, contradictory, or unsafe.

### 2. Why plain guardrails and RAG are not enough alone

Guardrails can block some outputs, and RAG can add context, but neither one is enough by itself to judge claims, protect memory writes, and gate risky actions with a clear receipt and provenance trail.

### 3. HUQAN as a local-first deterministic judgment layer

HUQAN sits as a deterministic layer over the agent workflow. It judges what is supported, unsupported, or contradictory, and it records why.

### 4. Claim verification example

Say:

> "Sigara kanser yapar."

Then show HUQAN classifying the claim and producing a judgment that is explainable through the verified graph state.

### 5. Memory admission example

Show a memory write that only becomes canonical after admission is satisfied. The point is simple: not every write becomes trusted memory just because an agent produced it.

### 6. Risky action gate example

Show an action that should be reviewed or blocked rather than silently executed. The action gate exists to stop unsafe or unapproved paths from becoming default behavior.

### 7. Trust Receipt and provenance explanation

Explain that a Trust Receipt tells the reviewer what was accepted, what was rejected, and what evidence supported the decision.

Mention that provenance and workspace boundaries are part of the contract, not decorative metadata.

### 8. Current readiness evidence

Say that the current repo already records the readiness state:

- release/readiness checkpoint completed
- release notes completed
- demo package completed
- readiness gate recorded `npm test -> 1510 pass / 0 fail / 16 skipped`
- no active release-blocking runtime risk found
- ING-1 is latent/future-risk, not release blocker today

### 9. Clear non-goals

State clearly that this is not:

- guaranteed truth
- hallucination-free behavior
- a full NLP engine
- autonomous production repair
- a complete Self-Healer runtime
- V4 / Workbench implemented
- a production release tag or package
- a promise that all future risks are eliminated

## Speaker Notes

Use this wording in a live demo:

1. "This is not a chatbot demo. It is a judgment layer demo."
2. "We are showing what gets accepted, what gets rejected, and why."
3. "Guardrails can filter output, but HUQAN gives us a deterministic receipt around claims, memory, and risky actions."
4. "The key point is not that the system knows everything. The key point is that it does not silently trust everything."
5. "The current state is ready for evaluation, but the roadmap still keeps latent risks visible instead of pretending they do not exist."

## Evaluator Phrases

- "This is a local-first verification layer."
- "This demo shows judgment, not magical certainty."
- "The repo records the current readiness state and the known non-blocking future risks."
- "Nothing here claims production autonomy."

## Scope

This is a docs-only demo script.

It does not add runtime code, tests, package files, or release metadata.
