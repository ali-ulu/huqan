# AXIOM Product Positioning

## One-line Promise

AXIOM tells you what breaks before you ship a decision.

## Product Category

AXIOM is a local-first reasoning and verification layer for LLM-assisted builders, agents, tools, and graph memory.

It is not another model. It sits around models and memory, then classifies what is known, unknown, contradicted, or risky.

## Primary Audience

- solo founders
- technical founders
- AI product builders
- small-team CTOs
- open-source maintainers
- developers building LLM agents or tool systems

## Primary Use Case

Founder and builder decision simulation:

```text
What breaks if I do this?
```

The current reference demo is:

```text
What breaks if autoLearn defaults to true?
```

Expected judgment:

```text
Risk level: critical
Recommendation: Change is not recommended.
```

## Public Positioning

Use the language in [docs/competitive-positioning.md](./competitive-positioning.md) and [docs/pitch-v0.md](./pitch-v0.md) for outward-facing copy.

For demo framing, follow [docs/demo-positioning.md](./demo-positioning.md) so the static demo does not overclaim live capabilities.

## Core Differentiation

AXIOM does not just answer.

It judges:

- whether a claim is graph-backed
- whether an answer is only LLM-assisted
- whether the graph does not know
- whether a claim contradicts memory
- which causal chain explains risk
- which next question would reduce uncertainty

## Product Language

Use these phrases:

- `What breaks if you do this?`
- `Unsupported knowledge does not become trusted memory.`
- `AXIOM judges claims, memory, and decisions.`
- `Local-first symbolic reasoning for LLM-assisted builders.`

Avoid overstating:

- full world model
- autonomous research scientist
- enterprise governance suite
- probabilistic prediction engine

## Near-term Direction

v0.8 shifts AXIOM from causal reasoning to accountable reasoning:

- Trust Kernel
- AXIOM Trust Protocol (`ATP`) and AXIOM Verify Protocol (`AVP`)
- source binding and provenance-aware claims
- audit trail and conflict routing
- lightweight workspace scoping

Use this product language:

- `Every serious answer should come with a receipt.`
- `A claim should not be a loose sentence. It should have a passport.`

Keep the direction disciplined:

- do not call ATP `v1`
- do not present v0.8 as a full world model
- do not market v0.8 as a full enterprise governance suite
- keep runtime claims behind actual implementation, not docs-only intent
