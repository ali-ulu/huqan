# How HUQAN Works

HUQAN sits between a proposed AI action and the state that action would change.

It is not an LLM safety classifier and it does not claim to know universal truth. It is a local trust and governance layer that evaluates a bounded action before that action lands.

## Core flow

```text
proposal
  + evidence
  + provenance
  + workspace scope
        |
        v
verification + contradiction + risk
        |
        v
policy + approval boundary
        |
        v
ALLOW / REVIEW / QUARANTINE / DRY-RUN ONLY / BLOCK / REJECT
        |
        v
Trust Receipt
```

Different gates expose different outcome sets. For example, a tool call and a memory mutation are not identical problems: a memory write can be quarantined for inspection, while a tool invocation may instead be forced into review or dry-run.

## Verification is bounded

A passing verification means the configured checks passed inside the configured boundary.

It does **not** mean:

- the claim is universally true;
- the model cannot hallucinate;
- every downstream system is safe;
- every HUQAN module participated in the decision.

That distinction is deliberate. The receipt exists partly so a later reviewer can see which checks actually ran.

## Review is not execution

When policy returns `review`, the action has not happened yet.

A separate operator decision may approve, reject, expire, cancel, escalate, or override depending on the governed path. Escalation is an operator decision, not a gate outcome returned automatically by the model-facing decision path.

## Fail-closed behavior

Security-sensitive HUQAN paths are designed to avoid silently weakening themselves when critical authority is missing or invalid.

Examples in the current repository include:

- unknown external tools are not automatically allowed;
- malformed or missing required agent identity can block under configured identity enforcement;
- A2A routes remain absent (`404`) when their trust-root deployment configuration is incomplete;
- malformed A2A authority configuration removes the surface rather than partially enabling it;
- operator-only MCP tools are withheld from the normal model-visible tool catalog.

## Local-first decisions

Important trust decisions are intentionally possible using local evidence and local authority. For example, the documented A2A path performs validation, hashing, signature checks, aggregation, replay reservation, and task recording from request bytes plus receiver-owned local authority state.

That does not mean HUQAN replaces IAM, infrastructure security, sandboxing, or human governance. It is one layer among them.

## Canonical references

- [README](https://github.com/ali-ulu/huqan/blob/main/README.md)
- [External Action Guard](https://github.com/ali-ulu/huqan/blob/main/docs/external-action-guard.md)
- [A2A Deployment](https://github.com/ali-ulu/huqan/blob/main/docs/a2a-deployment.md)
- [Current Operating Roadmap](https://github.com/ali-ulu/huqan/blob/main/docs/current-operating-roadmap.md)
