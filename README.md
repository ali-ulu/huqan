# HUQAN

**The first local trust boundary that actually separates the agent from the operator.**

Most tools make agents stronger.  
HUQAN puts a real OS boundary between the agent and the power to approve.

Agents can now write code, delete files, spend money, and change memory.  
Without a proper trust layer, that power runs as the same user as you.

HUQAN moves approval authority into a separate Windows service protected by TOTP and cryptographic decision envelopes.  
The agent and the operator are no longer the same security principal.

Every decision is recorded as a Trust Receipt.

No model. No cloud. No API key required for the core gate.

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

The write in line 1 **did not happen**. It was held until line 2 approved it. The quickstart uses a throwaway store.

No install needed: the same flow runs in the browser at [huqan.com](https://huqan.com).

## One-line integrations

**MCP (Claude, Cursor, any MCP client):**

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

**Gate (pre-execution guard for other agents):**

```bash
npx huqan-gate --before-tool-call
```

or

```bash
huqan-gate --agent claude-code --policy strict
```

Operator tools (`huqan.approve`, etc.) are hidden from the model and require `HUQAN_MCP_OPERATOR_TOKEN` — an agent cannot approve its own proposal.

## Install

```bash
npm install -g huqan     # Node.js 22.13.0 or newer
```

Main binaries: `huqan` (CLI), `huqan-mcp` (MCP server), `huqan-gate` (pre-execution guard), `huqan-authority`.  
Run `huqan doctor` to see what is configured.

## How it works

```text
evidence + provenance + workspace scope
        → verification, contradiction, risk
                → policy and approval boundary
                        → outcome + Trust Receipt
```

Outcomes: `ALLOW` / `REVIEW` / `QUARANTINE` / `DRY-RUN ONLY` / `BLOCK` / `REJECT`

A passing verification is a result inside one configured boundary, not a certificate of truth. The receipt names the boundary.

When the Approval Authority is installed, the decision itself moves behind an OS boundary (Windows service + TOTP + cryptographic envelopes). See [ADR-016](./docs/adr/ADR-016-approval-authority-os-boundary.md).

## Limits (honest)

- HUQAN does **not** eliminate hallucinations. It makes one claim **inspectable and blockable** before it becomes state.
- Only what is wired is governed. An agent that never calls HUQAN is not covered.
- Complements IAM, infrastructure security and human governance — it replaces none of them.
- Scale measured up to 10k graph nodes on one machine.

Full details and edge cases: [docs](./docs).

## License

**Open Source:** AGPL-3.0-only  
Free for open-source use, personal projects, research, and non-commercial evaluation.

**Commercial License**  
Required for:
- Closed-source / proprietary products
- Production use inside companies
- Redistribution as part of a commercial offering
- Multi-user / team deployments with support

Commercial licenses include dual-licensing rights (use HUQAN without AGPL obligations), priority support, and optional future commercial features.

→ Request commercial license: [aliulu@ai-ulu.com](mailto:aliulu@ai-ulu.com)

Until a commercial agreement is signed, this repository grants **no commercial rights**.

---

**Confidence is not truth. Verify before you trust.**

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-aliulu-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/aliulu)
