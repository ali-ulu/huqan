# Demo: MCP Agent Brake Layer

> How Huqan blocks an AI agent from writing to disk through 6 safety gates.

## What you're about to see

An LLM (Claude, Cursor, etc.) connects to Huqan via MCP. It tries to teach Huqan something ("cats are plants"). Huqan's Agent Brake Layer evaluates the request through 6 cascading safety gates and blocks it.

No hallucination. No data corruption. The agent never reaches the filesystem.

---

## Prerequisites

- Node.js >= 18
- Claude Desktop or Cursor (or any MCP-compatible client)

---

## Setup (2 minutes)

### 1. Install & load knowledge base

```bash
git clone https://github.com/agiulucom42-del/axiom.git
cd axiom
npm install
node egitim.js   # loads initial knowledge base (~5 seconds)
```

### 2. Configure MCP client

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "axiom": {
      "command": "node",
      "args": ["/path/to/axiom/mcpServer.js"]
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "axiom": {
      "command": "node",
      "args": ["/path/to/axiom/mcpServer.js"]
    }
  }
}
```

### 3. Restart the MCP client

Claude Desktop or Cursor will detect the new MCP server on restart.

---

## Demo walkthrough

### Safe query — allowed ✅

Ask the LLM: *"What is a cat?"*

Behind the scenes:
1. LLM calls `axiom.ask` via MCP
2. Gate AB1 classifies: `read-only` → `allow`
3. Huqan returns the answer from its knowledge graph
4. LLM presents the answer to you

**No gates blocked anything. Read-only tools pass through instantly.**

### Mutating query — requires review ⚠️

Ask the LLM: *"Teach Huqan that cats are plants"*

Behind the scenes:
1. LLM calls `axiom.learn` via MCP
2. Gate AB1 classifies: `write` → `review`
3. Gate AB2 checks tool call policy → `review`
4. Gate AB4 checks memory mutation rules → `review`
5. Huqan returns: **"This tool requires human approval."**
6. The agent never writes to disk

**The write is blocked. The LLM cannot silently modify Huqan's knowledge.**

### Unknown tool — blocked 🚫

Ask the LLM: *"Delete the database"* (if it tries any tool outside Huqan's surface)

Behind the scenes:
1. Gate AB1 classifies: `unknown` → `block`
2. Huqan returns: **"Unknown tool blocked."**
3. The agent cannot execute anything outside the approved tool surface

---

## Gate applicability

Typed MCP dispatch applies the gates listed for each tool. AB6 applies only if a future MCP operation executes untrusted code; no current MCP tool has that capability.

| Gate | Module | What it checks |
|------|--------|----------------|
| AB1 | `action-risk-classifier.js` | Risk classification of the action |
| AB2 | `tool-call-gate.js` | Tool-level authorization policy |
| AB3 | `code-change-gate.js` | Code change verification (if applicable) |
| AB4 | `memory-mutation-gate.js` | Memory/knowledge write authorization |
| AB5 | `automation-safety-gate.js` | Automation safety review (if applicable) |
| AB6 | `sandbox-isolation.js` | Sandbox isolation policy for future code execution |

If an applicable gate returns `block` or `review`, the action stops immediately.

---

## Tool surface (10 tools)

| Tool | Mutating | Alpha Decision | Gates |
|------|----------|---------------|-------|
| `axiom.ask` | No | allow | AB1 |
| `axiom.verify` | No | allow | AB1 |
| `axiom.plan` | No | allow | AB1 |
| `axiom.policy` | No | allow | AB1 |
| `axiom.approvals` | No | allow | AB1 |
| `axiom.reason` | No | allow | AB1 |
| `axiom.compare` | No | allow | AB1 |
| `axiom.dream` | No | allow | AB1 |
| `axiom.learn` | Yes | review | AB1, AB2, AB4 |
| `axiom.agent` | No | dry_run_only | AB1, AB2 |

Unknown tools → **blocked** by default.

---

## What this proves

1. **An LLM cannot write to Huqan's knowledge graph without human approval** — even if it tries.
2. **Unknown tools are blocked by default** — the agent can't execute arbitrary actions.
3. **Every gate decision is deterministic and auditable** — no probability, no black box.
4. **The safety layer is local** — no data leaves your machine.

---

## Troubleshooting

**"Server not found" in Claude Desktop:**
- Check the path in `claude_desktop_config.json` is absolute
- Run `node /path/to/axiom/mcpServer.js` manually to verify it starts

**Tests fail after pulling:**
```bash
node --test test/*.test.js
```
`mcpServer.test.js` has been updated for V2.6 gate behavior (PR #16). The expected private-alpha behavior is: `axiom.learn` returns `review-required` and `axiom.agent` returns `dry_run_only`.
