# Production Connector and Client Call-Chain Inventory

## Plan Check

- Task: `TB-A1`
- Repository: `ali-ulu/huqan`
- Source base: `main @ e683dbc2e40d255fb9f9db4916938403705cca24`
- Mode: source inventory only
- Runtime changes: none
- Classification: production-reachable, library-only, test-only, or documentation-only

This inventory records the connector and client boundaries reachable from the
current production entry points. A packaged module is not called
production-reachable unless a non-test caller reaches it on this source base.
Network access, graph admission, audit, receipt, and durable mutation are kept
as separate properties.

## Mutation Legend

| Marker | Meaning |
| --- | --- |
| `graph` | Creates or changes Graph nodes or edges. |
| `memory` | Learns into Kernel memory or changes memory-backed state. |
| `plugin` | Invokes a plugin capability that may own further effects. |
| `persistence` | Writes approval, Graph, JSON, SQLite, backup, or restore state. |
| `session-only` | Changes ephemeral process-local session state only. |
| `none` | No state mutation is performed by the described path. |

## Production Entry-Point Matrix

| Boundary | Production entry point | Main call chain | Mutation markers | Trust-boundary note |
| --- | --- | --- | --- | --- |
| CLI executable | `package.json` `bin.huqan` -> `cli.js:926-937` `main()` -> `cli.js:863-924` `runCliArgv()` -> `cli.js:308-683` `CLI.execute()` | Direct learn: `cli.js:316-319` -> `kernel.learn()`. Document load: `cli.js:448-455` -> `kernel.learnDocument()`. Connector ingest: `cli.js:457-526` -> `kernel.runCapability()` -> `plugin.js:260-273` -> plugin `run()`. Save/restore/maintenance paths are at `cli.js:553-623`. | `graph`, `memory`, `plugin`, `persistence` | The CLI is the widest production client surface. Command gating occurs before `execute()`, but each mutation must still be evaluated by its owned runtime boundary. |
| HTTP server | `package.json` `scripts.server` -> `server.js:1386-1394` `startServer()` -> `server.js:721-1381` request dispatcher | Upload: `server.js:953-993` -> `kernel.learnDocument()`. Approval queue: `server.js:1261-1292` -> persisted approval. Approved execution: `server.js:1149-1258` -> `lib/ingest.js:108-147` `handleIngest()` -> capability. Audit: `server.js:83-97` -> `Graph.appendAuditEvent()`. | `graph`, `memory`, `plugin`, `persistence` | `/api/ingest` accepts only immutable `manual` and `decision` snapshots. `lib/ingest.js:149-167` rejects GitHub and markdown queue snapshots with `INGEST_SNAPSHOT_REQUIRED`. |
| Viewer HTTP gateway | `server.js:17-18` import -> `server.js:323-326` gateway construction -> `server.js:721-733` `/viewer/**` dispatch -> `lib/viewer/viewer-gateway.js:145-255` | Session login/logout changes the bounded in-process session store. Authenticated receipt lookup delegates to the configured receipt reader and does not mutate Graph, memory, plugins, or persistence. | `session-only` for sessions; `none` for receipt reads | The HTTP gateway is production-reachable on this base even though the browser shell assets are not yet present on canonical `main`. |
| MCP stdio server | `package.json` `scripts.mcp` -> `mcpServer.js:1207-1243` `runStdio()` -> `createServer().handleRequest()` -> `mcpServer.js:1071-1190` `callTool()` | `axiom.learn` passes the MCP tool gate and calls `kernel.learn()` at `mcpServer.js:1134-1139`. Review decisions are persisted before execution; approved learn executes through the same Kernel path in `handleMcpApprovalDecision()`. | `graph`, `memory`, `persistence` | There is no canonical `repoMemory` or GitHub connector MCP tool on this base. MCP is a production client boundary, not a GitHub connector boundary. |
| Programmatic SDK | `lib/sdk.js:243-250` exports -> `createAxiomClient()` -> `lib/sdk.js:103-153` `runAxiomSdkCommand()` | Verify and reason call Kernel read methods. Shield with caller-provided `autoLearn: true` reaches `lib/shield.js:90-119` -> `kernel.learnFromLLM()` -> `graph.save()` when facts are learned. Other supported commands use `lib/sdk.js:70-77` `invokeCapability()` -> `kernel.runCapability()`. | `graph`, `memory`, `persistence`, and `plugin` conditionally | This is a library client, not an HTTP transport. Effects depend on the selected command and caller options. |
| Package Kernel API | `package.json` `main` -> `kernel.js` exported constructor | Consumers may call the public Kernel learn, lifecycle, maintenance, and capability methods directly. Approval persistence and execution are owned by the HTTP and MCP transports, not by a public Kernel approval method. The constructor loads persisted state by default unless configured otherwise. | `graph`, `memory`, `plugin`, `persistence` | This is the canonical library boundary. It must not be conflated with a connector transport. |
| Workflow `repoMemory` tool | CLI agent path -> `agentRuntime.js:20-27` -> conditionally enabled `workflow-runtime.js:56-70` -> `workflow-tools.js:246-325` `repoMemory.run()` -> capability runner -> `kernel.runCapability('repoMemory')` | `plugin.js:260-273` resolves the capability -> `plugins/repo-memory.js:480-510` -> GitHub or markdown ingest. | `graph`, `plugin`, `persistence` | Production reachability is conditional on explicit workflow-runtime configuration. No standalone HTTP or MCP connector route was found for this tool. |
| Backup/restore operators | `package.json` scripts -> `scripts/backup.js:2-7` or `scripts/restore.js:2-7` | Script -> `backupRestore` helpers -> configured persistence files. | `persistence` | Operator entry points, not connector transports. Included because they cross the persistence boundary. |
| Training utility | `package.json` `scripts.train` -> `egitim.js` | Creates Kernel, learns the configured corpus, then saves Graph state. | `graph`, `memory`, `persistence` | Manual production utility; it is not an external client protocol. |

## Live Connector Call Chains

### GitHub repository ingest

The production-reachable GitHub connector path is:

```text
CLI company-ingest (github)
or workflow repoMemory tool
  -> Kernel.runCapability('repoMemory')
  -> PluginManager.runCapability()
  -> plugins/repo-memory.js run()
  -> ingestGithubRepo()
  -> adapters/github-adapter.js fetchRepoFiles()
  -> Kernel.proposeNode() / Kernel.proposeEdge()
  -> admission decision
  -> Graph mutation and audit only on the allowed path
```

Source anchors:

- `cli.js:495-506`
- `workflow-tools.js:246-325`
- `kernel.js:326-331`
- `plugin.js:260-273`
- `plugins/repo-memory.js:147-333` and `480-510`
- `adapters/github-adapter.js:64-124`
- `kernel.js:334-432`
- `graph.js:736-819`

`fetchRepoFiles()` performs the external GitHub read. The downstream plugin
builds provenance and proposes Graph nodes and edges. Proposal admission is
evidence of governed outcomes; it is not evidence of a connector-owned durable
journal, transaction, rollback, or exactly-once contract.

### Markdown ingest

The production-reachable markdown connector path is:

```text
CLI company-ingest (markdown)
or workflow repoMemory tool
  -> Kernel.runCapability('repoMemory')
  -> PluginManager.runCapability()
  -> plugins/repo-memory.js run()
  -> ingestMarkdownPath()
  -> adapters/markdown-adapter.js ingestMarkdown()
  -> Kernel.proposeNode() / Kernel.proposeEdge()
  -> admission decision
  -> Graph mutation and audit only on the allowed path
```

Source anchors:

- `cli.js:509-520`
- `plugins/repo-memory.js:335-465` and `480-510`
- `adapters/markdown-adapter.js:82-135`
- `kernel.js:334-432`

The adapter is a local filesystem reader. Root confinement and Graph admission
are separate boundaries.

### HTTP ingest

The production HTTP queue deliberately differs from the direct CLI and
workflow connector paths:

```text
POST /api/ingest
  -> buildIngestApprovalSnapshot()
  -> manual or decision only
  -> persisted approval
  -> approval decision endpoint
  -> handleIngest()
  -> companyBrain capability
```

GitHub and markdown are rejected before queue admission because no immutable
external-source snapshot exists. `handleIngest()` can dispatch those source
types when called directly, but the canonical HTTP caller does not admit them.

## Library-Only or Unproven Production Reachability

| Surface | Current evidence | Classification |
| --- | --- | --- |
| `lib/github-connector.js` `ingestGitHubItem()` / `ingestGitHubItems()` | Packaged and directly tested. No non-test in-repository caller reaches it. Its candidate-claim route is materially different from `repo-memory` repository graph proposals. | `library-only` |
| `adapters/github-adapter.js` `fetchAndLearn()` | Exported and tested, but no non-test caller was found. `fetchRepoFiles()` is live through `repo-memory`. | `library-only` |
| `adapters/markdown-adapter.js` `ingestAndLearn()` | Exported and tested, but no non-test caller was found. `ingestMarkdown()` is live through `repo-memory`. | `library-only` |
| `lib/provenance-ingest.js` `ingestWithProvenance()` | Exported and tested, but no non-test caller was found. `buildProvenance()` is used by live paths. | `library-only` |
| `packages/axiom-verify/index.js` | Package library export with no process, HTTP, or stdio entry in that module. | `library-only` |
| Plugins and `workflow-runtime.js` | Internal capabilities reached through a production client only when loaded and selected. They are not standalone transports. | `internal` |

No source-evidence basis exists to label these modules dead. `library-only` or
`internal` means only that canonical in-repository production reachability was
not proven.

## Test-Only and Documentation-Only Separation

- `test/**` and root `*.test.js` files are test-only callers.
- `benchmarks/**` files are benchmark harnesses, not production clients.
- `docs/**`, archived evidence, and specifications are not runtime evidence.
- `public/index.html` is presentation content, not a connector.
- `specs/v0.4/SPEC.md` describes HTTP GitHub ingest, while current
  `buildIngestApprovalSnapshot()` rejects GitHub and markdown. The source
  behavior controls this inventory.
- The receipt-viewer HTTP gateway is production-reachable on this base. The
  browser shell assets are not present on canonical `main`; the open viewer PR
  is not evidence that the browser UI has shipped.

## Source-Reality Findings

1. GitHub repository ingest and GitHub candidate-claim ingest are separate
   boundaries and must not share one coverage claim.
2. The live GitHub repository path is CLI/workflow -> `repoMemory`; the
   packaged `lib/github-connector.js` route has no proven production caller.
3. HTTP external-source ingest remains fail-closed even though the generic
   dispatcher can route GitHub and markdown when called outside that queue.
4. MCP has real gated mutation behavior, but no GitHub connector tool.
5. The SDK is a caller-controlled library adapter, not a transport.
6. Admission, provenance, audit, receipt, and durable journal evidence remain
   distinct. None can substitute for another.

## Validation Ownership

The focused regression set for this inventory is owned by the existing tests:

- `adapters/github-adapter.test.js`
- `adapters/markdown-adapter.test.js`
- `plugins/repo-memory.test.js`
- `lib/github-connector.test.js`
- `lib/provenance-ingest.test.js`
- `test/ingest-snapshot-gate-boundary.test.js`
- `test/provenance-ingest.test.js`
- `server.test.js`

The complete regression suite remains a TB-A1 closeout requirement. A passing
focused set alone must not be reported as full-regression evidence.

## Non-Claims

This inventory does not prove:

- that every connector or external client is covered;
- that every connector mutation is journaled, transactional, replay-safe, or
  exactly-once;
- that GitHub or markdown are enabled through the HTTP approval queue;
- that library-only exports are dead or safe to remove;
- that the open V4 receipt-viewer implementation is merged or production;
- V5 ecosystem readiness or V5 completion.
