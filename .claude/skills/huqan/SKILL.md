---
name: huqan
description: Use HUQAN's CLI, REST server, or MCP tools whenever a task needs claim verification, evidence/provenance tracking, contradiction detection, a safety gate before a risky or mutating action, an approval workflow, an auditable Trust Receipt, or governed agent memory writes. Trigger this skill for requests like "verify this claim", "check this for contradictions", "what's the evidence for X", "add this fact to memory but require review first", "build me a Trust Receipt / audit trail for this decision", "run this agent action safely / with an approval gate", "plan this goal and show me the steps before running", or "ingest this data with a review step". Also use it when the user mentions HUQAN, AXIOM (its legacy name), huqan-mcp, Trust Receipts, or asks how to wire HUQAN into Claude Desktop, Cursor, or another MCP client. Do not use this for general fact-checking or knowledge-graph work that has nothing to do with HUQAN's actual runtime — this skill is about operating HUQAN itself, not about verification in the abstract.
---

# HUQAN

HUQAN is a local-first AI governance and verification layer. It sits between
"a model or agent wants to do something" and "that thing actually happens,"
and forces the request through evidence, provenance, scope, policy, and risk
gates before allowing it. Every gated decision — allow, block, or escalate —
can produce an auditable Trust Receipt.

The core loop is:

```
claim or action → evidence + provenance + scope + policy → verification +
contradiction + risk gates → ALLOW / BLOCK / ESCALATE → Trust Receipt
```

Reach for HUQAN when a task needs any of: a verifiable claim with an evidence
trail, a mutation that should require review/approval before it lands,
contradiction detection against existing knowledge, or an audit record that
proves what was checked and who approved it. Skip it for open-ended reasoning
or fact-checking that has no connection to HUQAN's own graph and gates —
HUQAN only judges what it has evidence for on its tested local paths, not
general world knowledge.

## Picking a surface: CLI vs REST vs MCP

| Situation | Use |
|---|---|
| Human at a terminal, one-off command | CLI (`huqan` / `node cli.js`) |
| Another process or script needs HTTP | REST server (`node server.js`) |
| Claude Desktop, Cursor, or another MCP client | MCP server (`huqan-mcp` / `node mcpServer.js`) |
| You (Claude, right now, in this conversation) are wired to HUQAN via MCP | Call the `huqan.*` MCP tools directly — see below |

If you're not sure whether an MCP connection to HUQAN exists in the current
session, check the available tools list for `huqan.*` names before assuming
you need to shell out to the CLI.

## MCP tools: what's advertised to the model

These fifteen tools are what `tools/list` returns to a model. Each has a
**gate** — the mutation policy the tool call itself is subject to:

| Tool | What it does | Gate |
| --- | --- | --- |
| `huqan.learn` | Learn a natural-language fact into the local graph | review |
| `huqan.ask` | Ask a grounded question against the graph | allow |
| `huqan.verify` | Verify a statement and return its evidence trail | allow |
| `huqan.plan` | Build a multi-step plan for a goal | allow |
| `huqan.agent` | Run the multi-step agent loop | dry-run only |
| `huqan.ingest_preview` | Build a read-only ingest source manifest for review | allow |
| `huqan.ingest_execute` | Queue a reviewed manual or decision ingest for approval-owned execution | review |
| `huqan.ingest_status` | Read the status, progress and final receipt of an ingest run | allow |
| `huqan.policy` | Inspect the execution policy for a requested tool | allow |
| `huqan.reason` | Return forward and backward reasoning traces | allow |
| `huqan.compare` | Compare two concepts across the graph | allow |
| `huqan.dream` | Generate ranked hypotheses from the graph | allow |
| `huqan.advocate` | Challenge a claim without mutating the graph | allow |
| `huqan.search` | Search workspace-scoped memory and return provenance refs | allow |
| `huqan.trust_receipt` | Read a workspace-scoped Trust Receipt | allow |

`review` means the call is accepted but lands as a pending approval, not a
canonical write — do not tell the user the fact was "learned" until it has
actually been approved. `dry-run only` on `huqan.agent` means the model can
plan and simulate an agent run through MCP, but it cannot make the agent take
real side-effecting actions that way; that boundary is intentional, not a bug
to route around.

The legacy `axiom.*` names (e.g. `axiom.learn`) still resolve to the same
handlers for backward compatibility, but are never advertised — always call
the `huqan.*` name. See `docs/mcp-tool-name-migration.md` for the exact
compatibility rules if a legacy call ever needs explaining.

### Argument shapes for the tools you'll call most

The exact field names below come from the handler code (`mcpServer.js` and
`lib/mcp/read-workflow-tools.js`), not from guessing — use them as-is rather
than inventing plausible-looking field names, and otherwise trust whatever
`tools/list` reports for a tool over anything here if they ever disagree.

```jsonc
// huqan.learn — text is required; skipConflicts defaults to true
{ "text": "Vaccination prevents disease", "skipConflicts": true, "maxSentences": 10 }

// huqan.ask
{ "question": "What prevents disease?" }

// huqan.verify — workspaceId is optional, defaults to the kernel's default workspace
{ "statement": "Growth depends on investment", "workspaceId": "default" }

// huqan.plan / huqan.agent — maxSteps is clamped to 1-8, defaults to 4
{ "goal": "Investigate why deploys are failing", "maxSteps": 4 }

// huqan.reason
{ "subject": "investment" }

// huqan.compare
{ "left": "smoking", "right": "vaccination" }

// huqan.dream — depth is clamped to 1-5, defaults to 2
{ "depth": 2 }

// huqan.advocate / huqan.search — both require workspaceId; advocate accepts
// claim/text/question as aliases for the same field, search accepts
// query/claim/node
{ "workspaceId": "default", "claim": "Growth depends on investment" }
{ "workspaceId": "default", "query": "investment" }

// huqan.trust_receipt — workspaceId plus at least one of targetId,
// provenanceId, sourceRef, candidateId, eventType
{ "workspaceId": "default", "targetId": "node-123" }
```

**`huqan.verify` does not create a Trust Receipt by itself** — it only
verifies against the graph and returns evidence + confidence in the same
call. If the user wants an auditable receipt for a verification or approval,
that's a separate `huqan.trust_receipt` lookup keyed by workspace plus one of
the filters above (typically the `targetId` or `provenanceId` the earlier
call returned) — don't imply a receipt exists until you've actually fetched
one this way.

### Operator tools: never assume you can approve your own request

Three tools exist but are **deliberately withheld** from `tools/list`. They
only work with the `HUQAN_MCP_OPERATOR_TOKEN` environment variable set on the
server process, and are meant to be invoked out-of-band by a human operator,
not by the model that proposed the action:

| Tool | What it does |
| --- | --- |
| `huqan.approve` | Approve or reject a pending approval |
| `huqan.approvals` | List pending tool approvals |
| `huqan.agent_resume` | Resume a suspended agent run |

This is load-bearing, not incidental: the whole point of the review gate is
that the tool proposing a mutation and the tool approving it are different
actors. If a task needs something approved, say so and hand it back to the
user/operator — do not look for a workaround to self-approve, and do not
imply you approved something when you only proposed it.

## Typical workflows

**Learn a fact under review, then verify it (the canonical loop)**
1. `huqan.learn` — proposes the fact; gate answers `review`, not `approved`.
2. An operator calls `huqan.approve` out-of-band (or runs the CLI/REST
   equivalent) to approve or reject the pending change.
3. Once approved, the write becomes canonical.
4. `huqan.verify` — check the claim against the graph and get its evidence
   trail and confidence.
5. `huqan.trust_receipt` — read the receipt for an auditable record of the
   whole chain.

`huqan quickstart` (or `node cli.js quickstart` from a source checkout) runs
exactly this sequence end-to-end in a throwaway store, and is the fastest way
to show a user what a full learn → review → approve → verify → receipt cycle
looks like without touching their real memory.

**Ask a grounded question** — `huqan.ask` for a direct question against
existing graph knowledge; use `huqan.reason` instead when you need the
forward/backward reasoning trace, not just an answer.

**Check for contradictions or get a second opinion on a claim** —
`huqan.verify` for the evidence trail, `huqan.advocate` to challenge a claim
without mutating anything, `huqan.compare` to line two concepts up against
each other.

**Explore beyond what's verified** — `huqan.dream` produces ranked
hypotheses; make clear to the user these are hypotheses, not verified facts.

**Plan before acting** — `huqan.plan` builds a multi-step plan for a goal;
run this before `huqan.agent` when the user wants to see the steps first.

**Ingest a batch of data with a review step** — `huqan.ingest_preview` builds
a read-only manifest, `huqan.ingest_execute` queues it for approval-owned
execution (gate: review), `huqan.ingest_status` polls progress and the final
receipt. Don't skip the preview step even if the user is in a hurry — it's
what lets a reviewer see what will be ingested before it happens.

**Check what a tool call would actually be allowed to do** —
`huqan.policy` inspects the execution policy for a requested tool before you
call it, useful when you're not sure whether an action will hit `allow`,
`review`, or a block.

## CLI quick reference

From a source checkout (`npm ci` first) or after `npm install -g huqan`:

```bash
huqan quickstart          # full learn->review->approve->verify->receipt demo, throwaway store
npm start                 # or: node cli.js  — interactive CLI
npm run server             # or: node server.js — REST server + local UI at :3000
npm run mcp                # or: node mcpServer.js — MCP server over stdio
npm test                   # full test suite
npm run bench               # general benchmarks
npm run bench:verify        # verification-path benchmarks
```

The interactive CLI accepts controlled-relation statements, e.g.
`Smoking causes lung cancer`, `Authentication enables secure access`. HUQAN
recognizes explicit `CAUSES` / `PREVENTS` / `ENABLES` / `DEPENDS_ON` markers —
it is not a general NLU engine, so don't expect it to parse arbitrary prose
into graph relations.

## REST endpoints

Mutation endpoints require an API key via `X-API-Key` or
`Authorization: Bearer <key>` (set with `HUQAN_API_KEY`).

| Endpoint | Method | Purpose |
|---|---:|---|
| `/health` | GET | Health check |
| `/api?q=...` | GET | Allowlisted read-only query surface |
| `/graph-data` | GET | Knowledge graph export |
| `/verify` | POST | Guarded verification |
| `/v2/verify` | POST | Guarded structured verification |
| `/upload` | POST | Guarded load alias |

## Wiring HUQAN into an MCP client

Claude Desktop config, no local install required:

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

`--package=huqan` is required — the bin name (`huqan-mcp`) differs from the
package name, so without it `npx` would resolve the wrong binary. If HUQAN is
installed globally, `"command": "huqan-mcp"` with no `args` is enough. From a
source checkout it's `"command": "node", "args": ["/absolute/path/to/huqan/mcpServer.js"]`.

## Library / package surface

```js
const Kernel = require('huqan'); // KernelV2, the canonical runtime
const kernel = new Kernel();

const { createErrorPrevention } = require('huqan');
const prevention = createErrorPrevention(kernel.memory, {
  verifyEvidence,
  resolveApproval,
});
```

`createErrorPrevention` is verified-failure memory and deterministic preflight
checks exposed as a library surface — it is not one of the fifteen MCP tools,
so don't describe it as one. `require('huqan').KernelV1` still exists for the
older runtime but is deprecated and slated for removal; use the default
`KernelV2` export for anything new.

## Honest boundaries — don't overclaim

When explaining what HUQAN did or can do, stay inside what's actually true:

- HUQAN verifies against its own local graph and evidence, on tested paths.
  It does not eliminate hallucination or establish universal truth.
- Not every connector or mutation path has complete inline enforcement yet.
- The A2A routes (`/api/a2a/*`) exist but answer `404` unless
  `A2A_AUTHORITY_FILE` and `A2A_REPLAY_DIR` are configured — treat them as
  present-but-off, not shipped-and-working, until an install sets those.
- Some modules are implemented and tested but not reached by any production
  entry point (see `lib/module-reachability.js` in the HUQAN repo) — green
  tests for those mean "correct in isolation," not "exercised in the
  product." Don't cite them as running features.
- No third party has interoperated with the A2A transport, and there's no
  public agent marketplace or certification network.

If a task pushes toward claiming any of the above works when it doesn't,
say so plainly rather than smoothing it over.

## Deeper references (read only if the task needs them)

These live inside a HUQAN source checkout under `docs/`:

- `docs/current-operating-roadmap.md` — live execution order and exact limits
- `docs/mcp-tool-name-migration.md` — legacy `axiom.*` → `huqan.*` compatibility
- `docs/environment-variable-migration.md` — `HUQAN_*` vs legacy env var names
- `docs/agent-action-firewall.md` — how the agent action safety gate works
- `docs/http-upload-approval-contract.md` — upload/ingest approval contract
- `docs/product-surfaces.md` — the four HTML surfaces and what each is for
- `docs/governance.md` — governance model and decision authority
