# HUQAN

**Add one line. Your agent can no longer write memory or call tools without evidence + optional human approval. Everything is recorded as a Trust Receipt.**

HUQAN is a local-first gate between an AI agent's output and the state it would change — a memory entry, a repository, or a tool call.  
No model, no cloud, no API key required.

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

## Limits (honest)

- HUQAN does **not** eliminate hallucinations. It makes one claim **inspectable and blockable** before it becomes state.
- Only what is wired is governed. An agent that never calls HUQAN is not covered.
- Complements IAM, infrastructure security and human governance — it replaces none of them.
- Scale measured up to 10k graph nodes on one machine.

Full details and edge cases: [docs](./docs).

## License

**Open Source:** AGPL-3.0-only  
Free for open-source use, personal projects, and non-commercial research.

**Commercial License:** Available  
For companies, closed-source products, or production use.

→ Request commercial license: [aliulu@ai-ulu.com](mailto:aliulu@ai-ulu.com)

A commercial license is being finalized. Until then this repository grants **no commercial rights**.

---

**Confidence is not truth. Verify before you trust.**

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-aliulu-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/aliulu)
