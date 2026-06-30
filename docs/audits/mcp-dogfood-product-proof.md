# HUQAN / AXIOM — MCP Dogfood Product Proof

## 1. Executive verdict

`MCP_DOGFOOD_PROOF_PARTIAL`

Dogfood kanıtı gerçek MCP stdio client yolu üzerinden toplandı. `axiom.ask`, `axiom.verify`, `axiom.agent` ve unknown tool fail-closed davranışı beklendiği gibi çalıştı. Ancak `axiom.learn` review kuyruğuna düşse de gerçek stdio dogfood yolunda approval kaydı persistent queue içinde görünmedi:

* `approval.persisted = false`
* `axiom.approvals` → `pendingCount: 0`

Bu nedenle proof yeşil değil; V4 / public-release / enterprise claim kapısı hâlâ bloklu.

## 2. Environment

* Branch: `audit/mcp-dogfood-product-proof`
* HEAD: `89391581873aaef76fc0ea7046a9ac9b8bfc79a5`
* Worktree status at start: clean
* OS / shell: Windows / PowerShell
* Node: `v24.14.1`
* npm: `11.11.0`
* Canonical branch/base: `claude/practical-knuth-0ecsze @ 89391581873aaef76fc0ea7046a9ac9b8bfc79a5`

Command sequence used:

```txt
git worktree add -b audit/mcp-dogfood-product-proof C:\tmp\huqan-mcp-dogfood-proof 89391581873aaef76fc0ea7046a9ac9b8bfc79a5
git branch --show-current
git rev-parse HEAD
git status --short
node -v
npm -v
node - (inline stdio MCP dogfood harness with AXIOM_MEMORY_PATH / AXIOM_DB_PATH under C:\tmp\huqan-mcp-proof-runtime)
node - (inline raw learn/approvals inspection with AXIOM_MEMORY_PATH / AXIOM_DB_PATH under C:\tmp\huqan-mcp-proof-runtime-raw)
git status --short
```

## 3. MCP startup proof

Exact startup path:

```txt
node mcpServer.js
```

Client path:

```txt
node child_process.spawn(process.execPath, ['mcpServer.js'], { stdio: ['pipe', 'pipe', 'pipe'] })
```

Startup result:

* PASS
* `initialize` returned:
  * `serverInfo.name = "axiom"`
  * `serverInfo.version = "0.9.1"`
  * `protocolVersion = "2025-06-18"`

## 4. Tool behavior matrix

### `axiom.ask`

* Command/request used:

```json
{"method":"tools/call","params":{"name":"axiom.ask","arguments":{"question":"kedi nedir?"}}}
```

* Expected behavior: allow / responds
* Actual behavior:
  * response returned
  * `ok = true`
  * answer string returned: `"Bilmiyorum"`
* Pass/fail: PASS
* Notes:
  * Gate metadata was not echoed in the allow response payload.
  * Read-only response path still worked through MCP.

### `axiom.verify`

* Command/request used:

```json
{"method":"tools/call","params":{"name":"axiom.verify","arguments":{"statement":"kedi hayvandir"}}}
```

* Expected behavior: allow / responds
* Actual behavior:
  * response returned
  * `ok = true`
  * `status = "bilinmiyor"`
* Pass/fail: PASS
* Notes:
  * Read-only verify path worked through MCP.

### `axiom.learn`

* Command/request used:

```json
{"method":"tools/call","params":{"name":"axiom.learn","arguments":{"text":"dogfood proof sentinel fact 2026-07-01"}}}
```

* Expected behavior: review / admission-gated behavior
* Actual behavior:
  * `isError = true`
  * `ok = false`
  * `gate.decision = "review"`
  * `gate.allowed = false`
  * `gate.canExecute = false`
  * `gate.requiredReview = true`
  * approval object returned
* Pass/fail: PARTIAL
* Notes:
  * Review gating itself is correct.
  * Returned approval object reported `persisted = false`.
  * `axiom.approvals` did not show a pending item after the learn request.

### `axiom.agent`

* Command/request used:

```json
{"method":"tools/call","params":{"name":"axiom.agent","arguments":{"goal":"run an autonomous loop"}}}
```

* Expected behavior: `dry_run_only` or blocked from unsafe execution
* Actual behavior:
  * `ok = true`
  * `dryRun = true`
  * `gate.decision = "dry_run_only"`
  * `gate.allowed = false`
  * `gate.canExecute = false`
  * `gate.canDryRun = true`
* Pass/fail: PASS
* Notes:
  * Unsafe autonomous execution did not run live.

### unknown tool

* Command/request used:

```json
{"method":"tools/call","params":{"name":"axiom.unknown_tool","arguments":{}}}
```

* Expected behavior: block / fail-closed
* Actual behavior:
  * `isError = true`
  * `ok = false`
  * `gate.decision = "block"`
  * `gate.allowed = false`
  * `gate.canExecute = false`
  * `gate.reason = "unknown_tool_blocked"`
* Pass/fail: PASS
* Notes:
  * Unknown tool path is fail-closed in the tested MCP client route.

## 5. Mutation / admission proof

Checked mutation path:

```txt
axiom.learn → review
```

Observed behavior:

* `axiom.learn` did not execute directly.
* `gate.allowed = false`
* `gate.canExecute = false`
* `requiredReview = true`

Canonical-write check:

* After `axiom.learn`, the same fact was verified via `axiom.verify`.
* Result: `status = "bilinmiyor"`
* Conclusion: silent canonical write was **not observed**.

Admission/mutation verdict:

```txt
axiom.learn -> review
silent canonical write -> not observed
```

## 6. Fail-closed proof

Unknown tool behavior:

```txt
unknown tool -> block / fail-closed
```

Proof details:

* `gate.decision = "block"`
* `allowed = false`
* `canExecute = false`
* `reason = "unknown_tool_blocked"`

## 7. Approval persistence / shared-state note

This is the partial-proof blocker.

Observed in the real stdio dogfood path:

* `axiom.learn` returned an approval object
* same payload reported:

```txt
approval.persisted = false
```

* `axiom.approvals` before learn:

```txt
pendingCount = 0
approvals = []
```

* `axiom.approvals` after learn:

```txt
pendingCount = 0
approvals = []
```

* restart check:
  * server restarted cleanly
  * `axiom.approvals` still showed `pendingCount = 0`

Interpretation:

* review gating exists
* but approval persistence was **not proven** in the tested real stdio dogfood path
* therefore MCP Dogfood Product Proof is not yet complete

## 8. Artifact hygiene

Confirmed:

* no runtime artifact staged
* no `agent.memory.json` staged
* no `memory.json` staged
* no `memory.db` staged
* no logs/temp files staged
* no screenshots staged

Notes:

* MCP runtime created `C:\tmp\huqan-mcp-proof-runtime\memory.agent.json` outside the repo
* no runtime artifact appeared in repo `git status --short`

## 9. Product claim impact

`MCP_DOGFOOD_PROOF_PARTIAL` means:

```txt
MCP Dogfood Product Proof is not complete.
V4 / public release / enterprise control plane claims remain blocked.
```

Non-claims:

```txt
This proof does not mean HUQAN is a full production-ready enterprise platform.
This proof does not mean every connector/client path is covered.
This proof does not start V4 Workbench.
```

## 10. Final recommendation

`FIX_MCP_DOGFOOD_BLOCKERS_FIRST`

Blocking gap to fix before claiming green:

* real stdio MCP dogfood path must show review item persistence consistently
* `axiom.learn` review result should materialize in `axiom.approvals` for the same configured persistence path

Next canonical handling:

* investigate why real MCP stdio dogfood path returns `approval.persisted = false`
* do not proceed to V4 on the current evidence

VERDICT: MCP_DOGFOOD_PROOF_PARTIAL
