# HUQAN

A local trust layer for AI agents. It checks evidence, provenance, and policy before a claim, memory write, or action is trusted — and asks a human when needed.

Every decision is recorded as a verifiable Trust Receipt.

**No model. No cloud. No API key.**

## Why

Agents can write code, delete files, spend money, and change memory — usually running as *your* user. HUQAN sits between the agent and that power:

- Mutating calls are **held** until a person approves them.
- With the Approval Authority (a Windows service guarded by TOTP and cryptographic envelopes), the agent cannot approve its own actions.
- Every decision produces a **Trust Receipt** — a local record you can verify from the receipt itself.

## Try it

```bash
npx -y huqan quickstart
```

A 30-second tour: propose → approve → verify → Trust Receipt. No global install is required; the run uses a throwaway store.

## Install

```bash
npm install -g huqan    # Node.js 22.13.0 or newer
```

Binaries: `huqan` (CLI), `huqan-mcp` (MCP server), `huqan-gate` (pre-execution guard), `huqan-authority` (approval authority).

## Connect your agent

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
npx -y --package=huqan huqan-gate install --profile claude-code
```

Profiles: `claude-code`, `codex`, `openhands`, `opencode`, `pi`, `hermes`.

Operator tools (`huqan.approve`, `huqan.approvals`, `huqan.emergency_stop`, …) are hidden from the model and require `HUQAN_MCP_OPERATOR_TOKEN` — an agent cannot approve its own proposal.

The gate only governs actions when the client calls it before execution.

## How it works

```text
evidence + provenance + workspace scope
        → verification, contradiction, risk
                → policy + human approval
                        → outcome + Trust Receipt
```

Outcome: `ALLOW / REVIEW / QUARANTINE / DRY-RUN ONLY / BLOCK / REJECT`

Escalation and overrides are human decisions, recorded in the receipt.

## Honest limits

- HUQAN does not eliminate hallucinations — it makes a claim inspectable and blockable before it becomes state.
- Only what calls HUQAN is governed.
- The OS boundary needs the Approval Authority (a Windows service today). Code running as your user can still edit local files; the authority's ledger makes that detectable, not impossible.
- A receipt proves origin and integrity, not operator honesty. True independence requires a counter-seal held by a party the operator does not control.
- HUQAN complements IAM and human governance — it replaces neither.

## License

AGPL-3.0-only. No commercial license is offered today — see [`docs/legal/dual-licensing-status.md`](./docs/legal/dual-licensing-status.md).

---

**Confidence is not truth. Verify before you trust.**
