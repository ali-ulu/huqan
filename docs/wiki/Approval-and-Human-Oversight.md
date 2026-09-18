# Approval & Human Oversight

HUQAN separates **proposing** a mutation from **approving** it.

That separation is one of the project's central trust boundaries.

## The basic rule

A model may propose a governed mutation. That does not mean the model may approve the same mutation through the same capability surface.

In the MCP server, operator-only tools such as:

- `huqan.approve`
- `huqan.approvals`
- `huqan.agent_resume`

are deliberately withheld from the normal `tools/list` result and require `HUQAN_MCP_OPERATOR_TOKEN`.

This prevents the proposing model from simply discovering and invoking its own approval mechanism through the ordinary model-facing tool catalog.

## Review means the action has not landed

A decision of `review` is not execution.

The governed action remains pending until an operator-side decision is made through the appropriate authority boundary.

Depending on the path, human oversight may record decisions such as:

- approve
- reject
- expire
- cancel
- escalate
- override

Escalation itself is an operator decision. It is not a gate outcome returned automatically to make a difficult case disappear.

## External-agent identity and sponsorship

The external action guard supports agent identity cards and optional/required identity enforcement. Current implementation also includes stronger production rules around signed identity and human sponsorship for documented paths.

Important distinctions:

- identity attribution is not automatically cryptographic identity;
- a syntactically valid card is not the same as a verified signature;
- production policy may require a trusted human sponsor for supported paths;
- sponsor evidence does not bypass the ordinary admission/approval gates.

## Graduated autonomy

HUQAN can derive bounded autonomy tiers from verified action history. The documented tiers are ceilings, not overrides:

- `T1` — read-only and sandbox simulation
- `T2` — bounded filesystem/memory write in addition to T1
- `T3` — broader action classes

Promotion requires evidence and, for the first promotion, human activation. New violations can demote quickly.

A tier can never turn an independent `review` or `block` from stricter action gates into `allow`.

## Why this matters

The trust model is designed so that "the same model asked and approved" is not silently treated as meaningful human oversight.

The useful question is not merely *was approval recorded?* It is *who had authority to approve, through which boundary, and is that fact bound into the resulting evidence?*

## Canonical references

- [README](https://github.com/ali-ulu/huqan/blob/main/README.md)
- [MCP Ecosystem Entry](https://github.com/ali-ulu/huqan/blob/main/docs/mcp-ecosystem-entry.md)
- [External Action Guard](https://github.com/ali-ulu/huqan/blob/main/docs/external-action-guard.md)
