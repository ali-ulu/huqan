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

The write in line 1 **did not happen**. It was held until line 2 approved it, and line 4 is the durable record of why. The quickstart uses a throwaway store and never touches your own memory.

No install: the same flow runs in the browser at [huqan.com](https://huqan.com) (a static simulation). What to run when: [product surfaces](./docs/product-surfaces.md).

## Install

```bash
npm install -g huqan     # Node.js 22.13.0 or newer
```

Three binaries: `huqan` (CLI), `huqan-mcp` (MCP server over stdio), `huqan-gate` (pre-execution guard for other agents). `huqan doctor` reports what is configured.

## How it works

```text
evidence + provenance + workspace scope
        → verification, contradiction, risk
                → policy and approval boundary
                        → outcome + Trust Receipt
```

The outcome is one of:

ALLOW / REVIEW / QUARANTINE / DRY-RUN ONLY / BLOCK / REJECT

A tool call returns `allow`, `review`, `dry_run_only` or `block`. A memory write can also be set aside (`quarantine`) or refused (`reject`).

**Escalation is a decision a person makes, not one the gate returns.** A reviewer can move a pending case to `escalated`, and nothing executes until the authority it was raised to answers. That needs a second approver, so it is absent in a single-user install. The decision types are `approve`, `reject`, `expire`, `cancel`, `escalate` and `override` — see [`lib/human-oversight-approval-runtime.js`](./lib/human-oversight-approval-runtime.js).

A passing verification is a result inside one configured boundary, not a certificate of truth. The receipt names the boundary.

## Connect your agent

**MCP** (Claude, Cursor, any MCP client):

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

`--package=huqan` is required because the binary name differs from the package name. The approval tools (`huqan.approve`, `huqan.approvals`, `huqan.agent_resume`) are hidden from the model and need `HUQAN_MCP_OPERATOR_TOKEN`: an agent cannot approve its own proposal.

**Other agents**: `huqan-gate` ships with Claude Code, Codex, OpenCode, Pi and Hermes projections. It enforces only when the client calls it before executing. [Details](./docs/external-action-guard.md).

## Use it directly

```js
const Kernel = require('huqan');   // KernelV2
const kernel = new Kernel();
```

As a server: `HUQAN_API_KEY=… npm run server` on port 3000 — read-only `/api`, guarded `/verify` and `/upload`, the UI at `/`, the receipt viewer at `/viewer`.

## Limits

- HUQAN does not eliminate hallucinations. It makes one **inspectable and blockable** before it becomes state.
- Only what is wired is governed. An agent that never calls HUQAN is not covered.
- Some shipped modules have no production caller yet; each is listed with its reason in [`lib/module-reachability.js`](./lib/module-reachability.js). A green unit test is not deployment evidence.
- The conformance suites are **self-run** in this repository. They are not third-party verification. See the [interoperability and attestation boundary](./docs/audits/third-party-interoperability-attestation-boundary-3069.md).
- The unexpected-egress gate is **fail-open by default** until `HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS` declares the expected destinations. `huqan doctor` shows its state.
- Scale is measured up to 10k graph nodes on one machine: [scale truth pack](./docs/scale-truth-pack.md).
- It complements IAM, infrastructure security and human governance. It replaces none of them.

## Compared with

| Reach for | When the problem is | HUQAN's job instead |
|---|---|---|
| [NeMo Guardrails](https://docs.nvidia.com/nemo/guardrails/home) | Filtering an LLM's inputs and outputs | Deciding whether an output earned the write, and recording why |
| [LangChain guardrails / HITL](https://docs.langchain.com/oss/python/langchain/guardrails) | Framework checks and pause-and-resume around tool calls | A durable receipt binding evidence, scope, policy and approval to one decision |
| [Docker MCP Gateway](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/) | MCP server lifecycle, credentials, isolation | The decision inside the call, not the isolation around it |
| [DeepEval](https://deepeval.com/docs/evaluation-introduction) | Scoring model quality offline, in CI | The single live action, judged before it lands |

Details, and when HUQAN is the wrong choice: [competitive positioning](./docs/competitive-positioning.md).

## More

```bash
npm ci && npm test                    # full suite
npm run conformance:external          # consumer conformance
```

[Roadmap](./docs/current-operating-roadmap.md) ·
[Agent Action Firewall](./docs/agent-action-firewall.md) ·
[A2A deployment](./docs/a2a-deployment.md) ·
[Threat model](./THREAT_MODEL.md) ·
[Security](./SECURITY.md) ·
[Contributing](./CONTRIBUTING.md) ·
[Changelog](./CHANGELOG.md) ·
[Discussions](https://github.com/ali-ulu/huqan/discussions)

When this page and the repository disagree, the repository wins.

## License

[AGPL-3.0-only](./LICENSE). A commercial license is being prepared; **those terms are not yet operative and this repository grants no commercial rights.** [`CLA.md`](./CLA.md) is a review draft, not an operative agreement.

---

**Confidence is not truth. Verify before you trust.**

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-aliulu-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/aliulu)
