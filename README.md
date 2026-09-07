# HUQAN

An agent proposes something. HUQAN decides whether it lands.

It is a local gate between what an AI agent produces and the state that output would change — a memory entry, a repository, a tool call. Every decision leaves a Trust Receipt: what the evidence was, which policy applied, who approved it. No model, no cloud, no API key.

[![npm](https://img.shields.io/npm/v/huqan?logo=npm&color=cb3837)](https://www.npmjs.com/package/huqan)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-AGPL--3.0-22c55e.svg)](./LICENSE)

## Sixty seconds

```console
$ npx -y huqan quickstart
HUQAN quickstart — learn -> review -> approve -> verify -> Trust Receipt
  1. OK   propose: huqan.learn -> review (mutating_requires_review), approval approval-…
  2. OK   approve: huqan.approve -> approved (actor cli-quickstart)
  3. OK   verify: verified (confidence 0.90)
  4. OK   receipt: receiptId … (status canonical)
```

Read line 1 again: the write **did not happen**. It was held. It happened at line 3, after something approved it, and line 4 is the durable record of why. That gap is the entire product.

The quickstart runs against a throwaway store in your temp directory. It does not touch your own memory and does not relax a gate.

## Install

Node.js 22.13.0 or newer.

```bash
npm install -g huqan
```

Three binaries: `huqan` (CLI), `huqan-mcp` (MCP server over stdio), `huqan-gate` (pre-execution guard for external agents). PDF ingest and PDF receipt export are optional dependencies — `--omit=optional` drops both, JSON export is unaffected.

## The decision

Everything routes through one pipeline:

```text
evidence + provenance + workspace scope
        → verification, contradiction, risk
                → policy and approval boundary
                        → outcome + Trust Receipt
```

The outcome is one of:

ALLOW / REVIEW / QUARANTINE / DRY-RUN ONLY / BLOCK / REJECT

Which of them are reachable depends on the gate. A tool call can come back `allow`, `review`, `dry_run_only` or `block`. A memory write adds `quarantine` and `reject`, because a write can be set aside for inspection rather than refused outright.

**Escalation is a decision a person makes, not one the gate returns.** A reviewer can move a pending case to `escalated` instead of deciding it, and nothing executes until the authority it was raised to answers. That requires a second approver, so it is simply absent in a single-user install. The decision types are `approve`, `reject`, `expire`, `cancel`, `escalate` and `override` — see [`lib/human-oversight-approval-runtime.js`](./lib/human-oversight-approval-runtime.js).

A passing verification is not a certificate of truth. It is a result produced inside one configured boundary, and the receipt names which one.

## Wiring it in

**MCP** — for Claude, Cursor, or anything else speaking the protocol:

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

`--package=huqan` is required: the binary name differs from the package name.

Three operator tools — `huqan.approve`, `huqan.approvals`, `huqan.agent_resume` — are withheld from `tools/list` and need `HUQAN_MCP_OPERATOR_TOKEN`. **A model that proposes a mutation cannot approve it through the catalog it can see.** Operator capabilities are single-use and the record of a spent one survives restarts and workers; if it cannot be written, verification fails closed.

**Any other agent** — `huqan-gate` takes a brand-independent envelope and ships with Claude Code, Codex, OpenCode, Pi and Hermes projections. It is enforcement only when the client calls it *before* executing; a hookless client needs a wrapper, gateway or sandbox. [Details](./docs/external-action-guard.md).

**As a library:**

```js
const Kernel = require('huqan');   // KernelV2, the canonical runtime
const kernel = new Kernel();
```

**As a local server** — `HUQAN_API_KEY=… npm run server` serves port 3000: read-only `/api` and `/graph-data`, guarded `/verify` and `/upload`, the UI at `/`, and a read-only receipt viewer at `/viewer`. Mutations authenticate with `X-API-Key` or a bearer token.

## Limits

A verification tool that oversells itself has refuted its own thesis, so:

- HUQAN does not eliminate hallucinations. It makes one **inspectable and blockable** before it becomes state.
- Coverage is whatever is actually wired. An unconnected agent is not governed, and HUQAN does not pretend otherwise.
- Some modules pass unit tests without being reachable from the production entry-point graph in [`lib/module-reachability.js`](./lib/module-reachability.js) — currently bounded V5, Self-Healer and connector entries. An isolated green test is not deployment evidence.
- The A2A routes are deployment-gated. Unconfigured, they answer `404` rather than `401`, so an install never advertises a surface it cannot serve.
- It complements IAM, application and infrastructure security, and human governance. It replaces none of them.

## Neighbours, not substitutes

Four tools get compared to HUQAN. Each owns a different boundary, and one system can reasonably run all of them:

| Reach for | When the problem is | HUQAN's job instead |
|---|---|---|
| [NeMo Guardrails](https://docs.nvidia.com/nemo/guardrails/home) | Filtering an LLM's inputs and outputs — safety, topic, PII, jailbreak controls | Deciding whether an output earned the write, and recording why |
| [LangChain guardrails and HITL middleware](https://docs.langchain.com/oss/python/langchain/guardrails) | Framework-native checks and a pause-and-resume step around selected tool calls | A durable receipt binding evidence, scope, policy and approval to one decision |
| [Docker MCP Gateway](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/) | MCP server lifecycle, credentials, routing, container isolation | The decision inside the call, not the isolation around it |
| [DeepEval](https://deepeval.com/docs/evaluation-introduction) | Scoring model quality against datasets, in CI | The single live action, judged before it lands |

This is a comparison of focus, not a claim that any of them lacks features outside its primary documentation. Evals score a model offline. Tracing says what happened last night. IAM says who may call the API. HUQAN answers the question none of them ask: *should this specific output be trusted, right now, before it lands?*

Full reasoning, sources, and the cases where HUQAN is the **wrong** choice: [competitive positioning](./docs/competitive-positioning.md).

## More

```bash
npm ci && npm test                    # full suite
npm run conformance:external          # consumer conformance
npm run pilot:trust-receipt           # bounded receipt pilot
```

[Operating roadmap](./docs/current-operating-roadmap.md) ·
[Agent Action Firewall](./docs/agent-action-firewall.md) ·
[A2A deployment](./docs/a2a-deployment.md) ·
[NLP boundary](./docs/nlp-boundary.md) ·
[Threat model](./THREAT_MODEL.md) ·
[Security](./SECURITY.md) ·
[Contributing](./CONTRIBUTING.md) ·
[Discussions](https://github.com/ali-ulu/huqan/discussions)

When a summary and the repository disagree, the repository wins: [product surfaces](./docs/product-surfaces.md), [module reachability](./lib/module-reachability.js), [`package.json`](./package.json).

## License

[AGPL-3.0-only](./LICENSE). A commercial license is being prepared; **those terms are not yet operative and this repository grants no commercial rights.** [`CLA.md`](./CLA.md) is a review draft, not an operative agreement.

---

**Confidence is not truth. Verify before you trust.**
