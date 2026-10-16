# HUQAN Copilot Instructions

GitHub Copilot must treat the repository's existing agent governance as authoritative.

Before making or proposing a non-trivial code change:

1. Read `AGENTS.md`.
2. Read `docs/agent-canon.md`.
3. Read `docs/current-agent-checkpoint.json` when the task depends on mutable project state.
4. Prefer live source, tests, current CI evidence, and exact Git state over summaries or stale documentation.
5. Preserve fail-closed security behavior unless an explicitly approved contract changes it.
6. Do not add domain or business logic directly to `kernel.js`, `graph.js`, `lib/memory-store.js`, `server.js`, `mcpServer.js`, or `cli.js`; keep those as orchestration/boundary surfaces.
7. Keep one pull request to one purpose. Do not widen scope into adjacent cleanup.
8. Never bypass tests, security gates, approval boundaries, receipt/provenance integrity, workspace boundaries, or release authority checks.
9. When a recommendation conflicts with `AGENTS.md` or `docs/agent-canon.md`, follow those repository rules instead of this file.
10. Report uncertainty explicitly. A passing targeted test is not evidence that the full suite is green.

Preferred validation command for a completed implementation:

```bash
npm run verify
```

Use narrower tests during iteration when appropriate, then run the relevant repository gate before claiming completion.
