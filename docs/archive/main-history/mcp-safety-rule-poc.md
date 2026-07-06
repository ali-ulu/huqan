# HUQAN MCP Safety-Rule PoC

## What this document covers

This document records the raw evidence and exact commands used to demonstrate
HUQAN's MCP server in an **autonomous-driving-like deterministic safety-rule PoC**.

> **Scope clarification:**
> This is NOT an autonomous-driving integration.
> This is a deterministic safety-rule proof-of-concept that simulates the kind of
> rule-based reasoning that would be required in safety-critical domains such as
> autonomous vehicles.

---

## Commit

```
fb68c27f16fd7ab302e95b28e4e7598441ae7cb0
```

## Repo

```
C:\Users\sonfi\Desktop\huqan\axiom-main-clean
```

## Run ID

```
run_1782645875208
```

---

## MCP Server

```
node mcpServer.js
```

Started as a child process over stdio. Communicates via JSON-RPC 2.0.

---

## Exact Command

```
node demos/mcp_persistent_togg_safety_demo.js
```

---

## What was proven

### 1. MCP server starts

Verified via `initialize` handshake with:

```json
{ "protocolVersion": "2025-06-18", "clientInfo": { "name": "persistent-evidence-client" } }
```

### 2. tools/list returns expected tools

Raw file:

```
evidence/togg-mcp/run_1782645875208/01_tools_list.raw.json
```

Tools confirmed present:

| Tool | Present |
|---|---|
| axiom.learn | ✅ |
| axiom.ask | ✅ |
| axiom.verify | ✅ |
| axiom.plan | ✅ |
| axiom.agent | ✅ |
| axiom.policy | ✅ |
| axiom.approvals | ✅ |
| axiom.reason | ✅ |
| axiom.compare | ✅ |
| axiom.dream | ✅ |

### 3. Safety rules written to DB

Five deterministic safety rules were loaded into `memory.db` before the MCP session:

```
buzlu yol tehlikelidir
tehlikeli durumda azami hiz ellidir
mevcut hiz yetmistir
hiz yetmis ise azami hiz asilmisir
azami hiz asilmasi guvenlik ihlalidir
```

DB before/after:

```
evidence/togg-mcp/run_1782645875208/00_db_before.json
evidence/togg-mcp/run_1782645875208/05_db_after.json
```

Note: Rules were written via `DIRECT_DB_FALLBACK` (kernel.learn called programmatically
before MCP server spawn) because `axiom.learn` over MCP is review-gated.
See `docs/mcp-write-policy-audit.md` for full explanation.

### 4. axiom.plan called via MCP

Raw file:

```
evidence/togg-mcp/run_1782645875208/03_axiom_plan.raw.json
```

Goal passed:

```
Huqan ve StackMemory entegrasyonu için bir yol haritası hazırla.
```

Result: plan returned with selected tools `["ask", "verify", "reason", "dream"]`.

### 5. axiom.verify called via MCP — contradiction detected

Raw file:

```
evidence/togg-mcp/run_1782645875208/04_axiom_verify_togg.raw.json
```

Statement tested:

```
azami hiz asilmasi guvenlik ihlali degildir
```

Result:

```json
{
  "status": "celiski",
  "confidence": 0.9,
  "backend": "sqlite"
}
```

Contradiction evidence:

```
azami --[tür]--> hiz asilmasi guvenlik ihlali
stored: "azami tur hiz asilmasi guvenlik ihlali"
incoming: "azami hiz asilmasi guvenlik ihlali degildir"
```

Risk flags fired:

```
NEGATION_CONFLICT
SEMANTIC_OPPOSITION
PREDICATE_DRIFT
RELATION_DRIFT
WEAK_PARTIAL_MATCH
HIGH_RISK_DOMAIN
```

### 6. JSON-RPC transcript saved

```
evidence/togg-mcp/run_1782645875208/transcript.ndjson
```

Contains: initialize, tools/list, tools/call (learn x5), tools/call (plan), tools/call (verify), shutdown.

---

## Test result

Command:

```
npm test
```

Result:

```
tests 1517
pass  1501
fail  0
```

The PoC test file:

```
tests/mcp_togg_safety_persistence.test.js
```

passed as part of the full suite.

---

## What is NOT claimed

- This is not a complete autonomous driving system.
- This is not a production integration with TOGG vehicles.
- MCP persistence (learn/write to DB) is not fully proven via MCP; see write-policy audit.

---

## Final Verdict

```
MCP_VERIFY_ONLY_PROVEN
```

`axiom.verify` and `axiom.plan` are fully operational over MCP.
`axiom.learn` is present but write-gated; see `docs/mcp-write-policy-audit.md`.

---

## Evidence files

| File | Description |
|---|---|
| `evidence/togg-mcp/run_1782645875208/00_db_before.json` | DB state before session |
| `evidence/togg-mcp/run_1782645875208/01_tools_list.raw.json` | Raw tools/list JSON-RPC response |
| `evidence/togg-mcp/run_1782645875208/02_store_rules.raw.json` | Raw axiom.learn MCP responses |
| `evidence/togg-mcp/run_1782645875208/03_axiom_plan.raw.json` | Raw axiom.plan MCP response |
| `evidence/togg-mcp/run_1782645875208/04_axiom_verify_togg.raw.json` | Raw axiom.verify MCP response |
| `evidence/togg-mcp/run_1782645875208/05_db_after.json` | DB state after session |
| `evidence/togg-mcp/run_1782645875208/transcript.ndjson` | Full JSON-RPC transcript |
| `evidence/togg-mcp/run_1782645875208/run_manifest.json` | Run manifest and verdict |
| `demos/mcp_persistent_togg_safety_demo.js` | Demo client script |
| `tests/mcp_togg_safety_persistence.test.js` | Automated test |
