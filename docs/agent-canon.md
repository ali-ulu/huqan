# HUQAN Agent Canon

This file contains stable working rules. Keep volatile repository state out of
this file so the prompt prefix remains small and cache-friendly.

## Source Authority

`SRC-001`

Use this precedence:

1. live source, tests, exact Git SHA, and current CI evidence;
2. canonical runtime behavior;
3. `docs/current-operating-roadmap.md`;
4. current architecture and contract documents;
5. historical roadmaps, task-packs, experiments, and dashboards.

When sources conflict, report the conflict. Do not silently choose the more
convenient claim.

## Change Discipline

`CHG-001`

- Obey the active write lock and exact approved scope.
- One change set has one purpose.
- Do not widen a task to fix adjacent debt.
- Do not claim success without scope, test, Git, and worktree evidence.
- Preserve fail-closed behavior unless a separately approved contract changes it.

## Minimum Implementation

`YAGNI-001`

Apply this order:

1. Does this need to exist? If no, skip it.
2. Is it already in this codebase? Reuse it; do not rewrite it.
3. Does the standard library do it? Use it.
4. Is it a native platform feature? Use it.
5. Is there an installed dependency that does it? Use it.
6. Is one line sufficient? Use one line.
7. Only then add the minimum implementation that works.

## Thin Orchestrator Rule

`ARCH-001`

Do not add new domain or business logic directly to `kernel.js`, `graph.js`,
`lib/memory-store.js`, `server.js`, `mcpServer.js`, or `cli.js`.

When a feature touches legacy logic in one of these files:

1. lock the observable behavior with tests;
2. extract the coherent responsibility without duplicating it;
3. combine the extracted legacy behavior and approved new behavior in a
   single-responsibility module;
4. leave the original file responsible only for validation boundaries,
   dependency wiring, ordering, delegation, and its existing public facade.

Preserve public API, verdict, receipt, envelope, persistence, and fail-closed
semantics unless an explicit product contract authorizes a change.

Refactor only when it is required to preserve behavior, protect the application
flow, or obey this rule. A necessary narrow refactor is part of the approved
change; an adjacent cleanup or rewrite is scope expansion.

## Evidence Language

`EVID-001`

Label conclusions as observed, derived, or unverified. A passing targeted test
is not evidence that the full suite is green. A document is not evidence that
its claim exists in the current artifact.

## Multi-Agent Delivery Contract

`DELIVERY-001`

- `docs/fikirden-urune-protocol.md` is a binding stable working contract and is
  included in the generated context capsule.
- Before implementation, verify repository identity, source version, exact Git
  base, approved scope, and applicable write lock from live evidence.
- Inter-agent instructions and reports use the complete `[BAĞLAM]`, `[GÖREV]`,
  `[KABUL]`, `[YASAK]`, and `[SÜRÜM]` envelope.
- Claims use `GÖZLENDİ`, `TÜRETİLDİ`, or `VARSAYILDI`; untested items are listed
  under `DOĞRULANMADI`.
- Lead review attempts to falsify the result, implementation reports only
  performed work and evidence, and independent audit starts from a fresh test
  before reading the implementer's report.
- A delivery is not complete without acceptance-command evidence, artifact or
  Git identity, scope evidence, a two-minute user eye test, and the next-agent
  envelope required by the protocol.

## Context and Cache Discipline

`CTX-001`

- This bootstrap governs agents working from a Git clone. It is not part of
  HUQAN's npm runtime or published package contract.
- Stable rules belong in this file.
- Mutable execution state belongs in `docs/current-agent-checkpoint.json`.
- Detailed history stays in Git and audit records, not in every prompt.
- Generate the compact task prefix with `node scripts/agent-context.js`.
- Treat worktree status as reported task state, not an automatic conflict.
- Start a fresh task when conversation history becomes an archive rather than
  necessary execution context.
- Prompt caching reduces repeated-input cost and latency; it does not replace
  rule validation or source-reality checks.

## Graphify Knowledge Graph

`GRAPHIFY-001`

- Before answering architecture or codebase questions, read
  `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw
  files.
- After modifying code files, run `graphify update .` to keep the AST-only
  graph current without API cost.
- If the graph output is absent or stale, say so and use live source plus the
  codebase-memory graph as the fallback evidence path.
