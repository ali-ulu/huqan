# HUQAN

An agent proposes something. HUQAN decides whether it lands.

HUQAN is a local gate between an AI agent's output and the state it would change — a memory entry, a repository, a tool call. Every decision leaves a Trust Receipt: the evidence, the policy, the approver. No model, no cloud, no API key.

[![npm](https://img.shields.io/npm/v/huqan?logo=npm&color=cb3837)](https://www.npmjs.com/package/huqan)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-AGPL--3.0-22c55e.svg)](./LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/ali-ulu/huqan/badge)](https://scorecard.dev/viewer/?uri=github.com/ali-ulu/huqan)

## Try it in 30 seconds

```console
$ npx -y huqan quickstart
HUQAN quickstart — learn -> review -> approve -> verify -> Trust Receipt
  1. OK   propose: huqan.learn -> review (mutating_requires_review), approval approval-…
  2. OK   approve: huqan.approve -> approved (actor cli-quickstart)
  3. OK   verify: verified (confidence 0.90)
  4. OK   receipt: receiptId … (status canonical)
```

Read line 1 again: the write **did not happen**. It was held, then allowed at line 3 once something approved it, and line 4 is the durable record of why. That gap is the whole product.

The quickstart runs against a throwaway store in your temp directory. It never touches your own memory and never relaxes a gate.

Prefer no install? The same flow runs in the browser at [huqan.com](https://huqan.com) — a static simulation, no backend. For a bigger map of what to run when, see [product surfaces](./docs/product-surfaces.md).

## Install

Node.js 22.13.0 or newer.

```bash
npm install -g huqan
```

Three binaries: `huqan` (CLI), `huqan-mcp` (MCP server over stdio), `huqan-gate` (pre-execution guard for external agents). PDF ingest and PDF receipt export are optional dependencies — `--omit=optional` drops both, and JSON export is unaffected.

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

Which outcomes are reachable depends on the gate. A tool call returns `allow`, `review`, `dry_run_only` or `block`. A memory write adds `quarantine` and `reject`, because a write can be set aside for inspection rather than refused outright.

**Escalation is a decision a person makes, not one the gate returns.** A reviewer can move a pending case to `escalated` instead of deciding it, and nothing executes until the authority it was raised to answers. That needs a second approver, so it is absent in a single-user install. The decision types are `approve`, `reject`, `expire`, `cancel`, `escalate` and `override` — see [`lib/human-oversight-approval-runtime.js`](./lib/human-oversight-approval-runtime.js).

A passing verification is not a certificate of truth. It is a result produced inside one configured boundary, and the receipt names which one.

## Connect your agent

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

Three operator tools — `huqan.approve`, `huqan.approvals`, `huqan.agent_resume` — are withheld from `tools/list` and need `HUQAN_MCP_OPERATOR_TOKEN`. A model that proposes a mutation cannot approve it through the catalog it can see. Operator capabilities are single-use, and the record of a spent one survives restarts and workers; if it cannot be written, verification fails closed.

**Any other agent** — `huqan-gate` takes a brand-independent envelope and ships with Claude Code, Codex, OpenCode, Pi and Hermes projections. It enforces only when the client calls it *before* executing; a hookless client needs a wrapper, gateway or sandbox. [Details](./docs/external-action-guard.md).

## Use it directly

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
- The conformance suites are **self-run**. `npm run conformance:external` and `npm run conformance:a2a` execute in this repository against this repository's own artifacts, so a green run is repository-owned evidence � not third-party verification, and not proof that anyone outside has interoperated. No external organization has independently verified a bundle, and no third-party attestation is bound into a Trust Receipt bundle yet. Both are recorded as blocked, each with its reopen condition, in the [interoperability and attestation boundary record](./docs/audits/third-party-interoperability-attestation-boundary-3069.md).
- The unexpected-egress gate (AB13) is **fail-open by default**. It stays inert until `HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS` (or an `expectedEgress` policy) declares the destinations a deployment talks to, so an install that never configures it has no egress visibility — an undeclared outbound host passes with no verdict. This is deliberate (an invented allowlist would either block every integration or mean nothing), and [`huqan doctor`](./README.md#use-it-directly) reports the resolved state so "no egress gate" is observable rather than silent.
- It complements IAM, application and infrastructure security, and human governance. It replaces none of them.

## Neighbours, not substitutes

Four tools get compared to HUQAN. Each owns a different boundary, and one system can reasonably run all of them:

| Reach for | When the problem is | HUQAN's job instead |
|---|---|---|
| [NeMo Guardrails](https://docs.nvidia.com/nemo/guardrails/home) | Filtering an LLM's inputs and outputs — safety, topic, PII, jailbreak controls | Deciding whether an output earned the write, and recording why |
| [LangChain guardrails and HITL middleware](https://docs.langchain.com/oss/python/langchain/guardrails) | Framework-native checks and a pause-and-resume step around selected tool calls | A durable receipt binding evidence, scope, policy and approval to one decision |
| [Docker MCP Gateway](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/) | MCP server lifecycle, credentials, routing, container isolation | The decision inside the call, not the isolation around it |
| [DeepEval](https://deepeval.com/docs/evaluation-introduction) | Scoring model quality against datasets, in CI | The single live action, judged before it lands |

This is a comparison of focus, not a claim that any of them lacks features outside its primary documentation. Evals score a model offline, tracing says what happened last night, IAM says who may call the API. HUQAN answers what none of them ask: *should this specific output be trusted, right now, before it lands?* Full reasoning, sources, and the cases where HUQAN is the **wrong** choice: [competitive positioning](./docs/competitive-positioning.md).

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

## Support

If HUQAN saves you from a bad write, consider supporting the project:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-aliulu-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/aliulu)
