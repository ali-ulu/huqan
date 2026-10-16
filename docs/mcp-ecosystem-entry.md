# MCP ecosystem entry (P0-2a)

MCP is the fastest proven path for `unconnected agent is not governed`:
any MCP-capable agent maps its tool call to `huqan.external-event.v1`
before execution, then lets `huqan-gate --profile generic` decide.

## Flow

```text
MCP tool call
  -> examples/mcp-observation-client.js (envelope, content-free)
  -> huqan-gate --profile generic (allow/review/block + receipt)
  -> executor runs only on allow
```

## Rules

- Raw args never leave the host: only `input_hash` (SHA-256) travels.
- Operator tools (`huqan.approve`, `huqan.approvals`, `huqan.agent_resume`)
  stay behind `HUQAN_MCP_OPERATOR_TOKEN`; the proposing model cannot approve.
- Review/blocked calls never reach the executor; the receipt is the proof.
