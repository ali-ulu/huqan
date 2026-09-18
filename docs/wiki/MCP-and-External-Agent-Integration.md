# MCP & External Agent Integration

HUQAN exposes two related but distinct integration patterns:

1. **MCP server integration** through `huqan-mcp`.
2. **Brand-independent pre-execution guarding** through `huqan-gate`.

## MCP server

A minimal configuration:

```json
{
  "mcpServers": {
    "huqan": {
      "command": "npx",
      "args": ["-y", "--package=huqan", "huqan-mcp"]
    }
  }
}
```

The server speaks MCP over stdio.

### Operator separation

Operator-only capabilities are intentionally not exposed through the normal model-visible tool catalog. They require `HUQAN_MCP_OPERATOR_TOKEN`.

This preserves the distinction between proposing a mutation and authorizing it.

## External action guard

`huqan-gate` is designed for tools or agents that are not HUQAN's own internal agent runtime.

A client adapter translates its native hook/event into a common action envelope containing fields such as:

```text
agent identity
session / turn identity
tool name
action kind
arguments
current working directory
workspace root
workspace id
```

The policy core is intended to remain agent-brand independent.

## Enforcement boundary

The guard only enforces pre-execution policy if the calling environment actually invokes it **before** performing the action.

A client with no usable pre-execution hook requires an external wrapper, gateway, or sandbox/execution boundary. HUQAN does not claim to govern an agent it is not connected to.

## Identity cards

The documented external-action flow supports `huqan.agent-identity-card.v1` capability cards.

Identity enforcement can validate properties such as:

- agent identity
- workspace
- capability
- delegation chain
- validity period

The card can be supplied through the envelope or operator-controlled CLI inputs. Operator-supplied identity material overrides agent-supplied identity material so an agent cannot simply grant itself more authority.

## Signed identity

The external-action implementation includes detached Ed25519 signature support over canonicalized identity-card data.

A valid structure (`attested: true`) is not identical to a cryptographically verified identity. The receipt records signature-verification state separately.

## Graduated autonomy

Verified receipt history can feed bounded autonomy tiers. These tiers are only ceilings: they never weaken independent AB1–AB11 gate decisions.

## A2A

HUQAN also includes a separate deployment-gated A2A surface with bounded exchange, capability negotiation, receiver agent-card publication and task-status lookup.

That transport has repository conformance and deployment-smoke evidence, but the project explicitly does **not** claim third-party interoperability yet.

## Canonical references

- [MCP Ecosystem Entry](https://github.com/ali-ulu/huqan/blob/main/docs/mcp-ecosystem-entry.md)
- [External Action Guard](https://github.com/ali-ulu/huqan/blob/main/docs/external-action-guard.md)
- [A2A Deployment](https://github.com/ali-ulu/huqan/blob/main/docs/a2a-deployment.md)
