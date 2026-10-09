# Ownership Map — #2446 (exhaustive: Map, Publish, Enforce complete; no moves)

**Parent:** #2115. Child epic, does not replace it, does not narrow its scope.
**Status:** implementation complete, pending review. No runtime behaviour change:
this PR touches `scripts/context-ownership.json` (manifest),
`scripts/check-module-boundary.js` (gate), `test/check-module-boundary.test.js`
(tests) and this document only. No `lib/`, no root runtime module, no API.
**Measured:** `origin/main` @ `ea5a0e24` on 2026-10-01.
Issue baseline was `main` @ `0a781c4`: 48 cross-module private calls across 18 files.
Current: `node scripts/check-module-boundary.js` → OK, 0 recorded in 0 files;
855 domain + 223 Platform owners, 276 file-level ports, 16 legacy edges,
0 unmapped; 534 mapped cross-owner imports checked.
**Design decision:** Wiki `Bounded-Contexts-2446-Source-Decision` v0.1
(2026-09-25, Ali Ulu). The five named contexts remain the complete set of
**domain** owners; one explicit `Platform` owner covers entrypoints,
composition roots, transport adapters and generic infrastructure. Platform is
not a sixth domain and never decides domain policy. There is no shared and no
unassigned bucket. Ports are file-level only.

## Entry conditions (all hold)

- [x] #2117 closed (canonical KernelV1 → KernelV2 contract; ADR-013).
- [x] Cross-module private call count zero (`module-boundary-baseline.json`
  is `{"threshold":0,"files":{}}`).
- [x] Storage-portability scope note exists (#2115 Phase 2; Graph JSON/SQLite/Rust
  behind `lib/graph-store-port.js`, Memory JSON/SQLite behind
  `lib/memory-store-port.js`; #2906 closed).
- [x] Ownership map produced from source and caller evidence, with
  disagreements recorded (THIS DOCUMENT + `scripts/context-ownership.json`).

Conclusion: Map, Publish and Enforce complete at full scope. Move: the map
proves no module misplaced — every file either sits in its evidenced owner or
is an explicitly listed Platform surface — so no moves. Splits that only reach
a line number are rejected, not reviewed; none were needed.

## Scope (in-scope 1078, out-of-scope 151)

In-scope = every non-test `.js` required by the shipped Node runtime,
enumerated by `scripts/check-import-cycles.js listSourceFiles()` minus tests
(`*.test.js`, `test/`, `benchmarks/`, `demo/`) minus the explicit
out-of-scope prefixes below. 1078 files, each with exactly one manifest row.

Out-of-scope (domain ownership only; the private-call ratchet, cycles and
layers gates still cover them):

| Prefix | Reason |
|---|---|
| `scripts/` | dev/CI tooling, not the shipped product graph (#2402 tooling signal; #2401: four scripts ARE test-imported, which only proves coupling, not domain ownership) |
| `examples/` | non-shipped usage samples |
| `public/` | browser UI outside the five server-side domain contexts (#2402 ui signal) |

Scope precedent: #2401 (file-specific reasons, not directory names), #2402
(127/127 files decided runtime/tooling/adapter/ui with a decision ledger),
#2115 (bin entries ARE product scope — both `bin/` entries are mapped Platform).

## Rules (binding, enforced by `check-module-boundary`)

1. The five domain contexts own their ports and adapters; Platform owns
   entrypoints, composition, transport and generic infrastructure (v0.1).
2. Contexts talk to each other only through public contracts: a Domain→Domain
   import must target a FILE-level published port naming the caller, or a dated
   legacy edge. No directory inference, no blanket exemption (v0.1).
3. A cross-context private call is forbidden, everywhere, unchanged.
4. A file belongs to exactly one owner. Platform files are listed explicitly.
5. `rustGraph.js` DECIDED (epic Rule 5): Knowledge backend surface owned through
   the `lib/graph-store-port.js`-class port (`lib/rust-graph-store-port.js`,
   `lib/rust-graph-fallback-factory.js` are Knowledge rows R-GRAPH-K).
6. Ownership is recorded with the source and caller evidence in the row catalog
   below; each manifest row cites its catalog row (`ownership-map-2446.md#R-*`).
   Disagreements are written down (§Disagreements), not settled by recency.
7. No context reaches into another context's storage, transaction or in-memory
   state. Platform entrypoints compose ports; Platform-infra helpers hold no
   domain state. Domain code may not import a Platform entrypoint without a
   dated legacy edge; Platform may call domain only through published ports.

## Row catalog (92 rows, 1078 files)

How to read: each row names its files by pattern, the verdict, and the checked
facts. "Sampled" files were read head-first (exports/classes/key functions);
caller facts come from the static require graph (`buildGraph`) at `ea5a0e24`.
Full per-file table: `scripts/context-ownership.json` (machine-readable side;
every row carries `evidence: ownership-map-2446.md#<row>`).

| Row | Files | Source evidence | Caller evidence |
|---|---|---|---|
| R-ENTRY-A (4, AgentAction) | `agent.js`, `agent.v3.js`, `workflow-agent.js`, `llmAdapter.js` | Agent/AgentV3 loop (`evaluateToolPolicy`, loop-budget/approval seams), WorkflowAgent plan/run over ToolRegistry, LLMAdapter outbound `ask()` with paranoid refusal | agentRuntime wires all three; cli/server call the loop |
| R-ENTRY-P (12, Platform) | `server.js`, `cli.js`, `mcpServer.js`, `index.js`, `bin/*` (2), `github-app-server.js`, `agentRuntime.js`, `workflow-runtime.js`, `plugin.js`, `egitim.js`, `lib/api-auth-opt-out.js` | HTTP/CLI/MCP/stdio entrypoints and composition roots wiring kernel/agent/tools; `egitim.js` is a dead compat shim (redirect + exit 2, 0 callers); api-auth-opt-out is auth-boundary config | entrypoints have no in-scope callers by nature; agentRuntime ← cli/mcpServer/server |
| R-TRANSPORT-P (11, Platform) | `lib/ingest*.js` (capability/preview/run/entry), `lib/github-connector*.js`, `lib/http-human-oversight-adapter*.js`, `lib/server-response-helpers.js`, `lib/sqlite-restore.js`, `lib/error-taxonomy.js`, `lib/fluent-answer.js` | ingest/connector/oversight/response transport pieces; fluent-answer renders verify evidence to Turkish sentences (boundary presentation like verify-status-vocabulary); error-taxonomy is the transport error vocabulary (8 HTTP callers) | required by CLI/HTTP/MCP surfaces and the ingest tools |
| R-KERNEL-P (4, Platform) | `kernel.js`, `kernel.v2.js`, `lib/kernel-factory.js`, `lib/kernel-contract.js` | Kernel composes graph/dream/plugin/nlp/admission/memory/receipts (orchestrator, not a domain); KernelV2 fronts the whole Kernel surface; factory is the single construction source (#2360 KEEP); contract is the kernel's composition surface | factory ← cli/server/mcpServer; kernel ← factory/v2 |
| R-KERNEL-K (24, Knowledge) | `lib/kernel-read-*.js`, `lib/kernel-v2-verify/evidence/contradiction*.js`, `lib/kernel-cognition/dream/inference/learn-document/learn-from-llm/self-*.js`, `lib/subject-resolution.js`, `lib/contested-read-policy.js` | read facades (ask/reason/compare/verify, never write graph), v1-escalating verification orchestration, cognition/dream/learn-shaping helpers | all ← kernel.js / kernel.v2.js |
| R-KERNEL-T (5, Trust) | `lib/kernel-learn-admission.js`, `kernel-learn-transaction.js`, `kernel-mutation-admission.js`, `kernel-learn-input-methods.js`, `lib/kernel-propose-node.js` | learn→memory-admission gate (fail-closed review), admit* choke point (routed≠enforced), admission-gated background-edge commit | all ← kernel.js; see D2 |
| R-KERNEL-A (5, AgentAction) | `lib/kernel-capability/persistence/primitive/method-install/envelope*.js` | kernel composition seams (method installers, capability/persistence/primitive facades) | all ← kernel.js |
| R-GRAPH-K (52, Knowledge) | `graph.js`, `rustGraph.js`, `lib/graph-*.js` (reads/writes/traversal/persistence/schema), `causalSimulator.js` | Graph nodes/edges/claims/hypotheses + traversal + SQLite/JSON/vector persistence behind `graph-store-port`; rustGraph is the native accelerator on the same surface | kernel, causalSimulator, rust fallback factory, self-healer graph |
| R-GRAPH-T (3, Trust) | `lib/graph-mutation-receipt-{read,schema,write}.js` | chained mutation receipts, seal tables, receipt-family schema (`receipt-chain`, `issuer-seal`, `v4-receipt-family`) — receipt lifecycle inside the graph write path | ← graph journal/mutation runtime; disagreement 2 graduated to published ports |
| R-VERIFY-K (29, Knowledge) | `lib/verify.js`, `lib/verify-*.js`, `lib/claim-decomposition.js`, `lib/semantic-*.js`, `lib/predicate-parser.js`, `lib/entity-resolution.js`, `lib/type-lattice.js`, `lib/text-safety-scorer.js`, `lib/turkish-copula.js`, `lib/fuzzy-normalization.js`, `lib/temporal-qualifier.js`, `lib/contradiction-rules*.js`, `lib/relation-drift.js`, `evidence-ranker.js` | VerifyService over graph edges (compound/graph/edge phases, numeric/Turkish text, contradiction guards); claim→subclaim splitting; semantic scoring; evidence ranking weights | ← kernel.js / kernel.v2.js / verify phases mesh |
| R-VERIFY-P (1, Platform) | `lib/verify-status-vocabulary.js` | HTTP/MCP-boundary edge adapter ("nothing hashed, signed or persisted carries these values") | 5 transport-only callers |
| R-VERIFY-T (1, Trust) | `lib/canonical-target-match.js` | candidate-shadows-canonical predicate split out of provenance-query | 5 Trust-side callers |
| R-VERIFY-A (1, AgentAction) | `lib/adversarial-signals.js` | manipulation-signal vocabulary feeding gates and verify | ← fuzzy-normalization (K), risk-rules (A) |
| R-LEARN-K (51, Knowledge) | `lib/learn-use-case*.js`, `lib/learn-edge-options.js`, `lib/inference-*.js`, `lib/dream-*.js`, `lib/hypothesis-{feedback,fitness,review,tuning,thresholds}.js`, `lib/fractal-learn*.js`, `lib/self-evolve-*.js`, `dream.js`, `lib/reasoning-trace.js`, `lib/graph-hypotheses.js` | learn orchestration (provenance→admission→commit, no graph sink of its own), bounded inference (fixpoint→provisional record, admission only via injected ingress), dream/hypothesis synthesis over graph reads | ← kernel/kernel.v2/cli-inference/mcp tools; see D7 |
| R-LEARN-T (7, Trust) | `lib/learn-admission-request.js`, `lib/learn-use-case-provenance.js`, `lib/inference-derived-admission.js`, `lib/claim-read.js`, `lib/conflict-detector.js`, `lib/hypothesis-review-audit.js`, `lib/evidence-ladder.js` | admission-request shaping (with riskScore), pure provenance predicate ("reaches no graph sink"), provisional→admitted ingress, admission-gated journaled candidate acceptance with canonical receipts, audit writes, evidence-state contract | ← kernel-learn-admission, mutation-admission, HTTP claim routes |
| R-LEARN-P (1, Platform) | `lib/reason-sandbox.js` | per-call isolated RustGraph child process (external execution boundary, never persisted) | ← kernel.js |
| R-LEARN-A (1, AgentAction) | `lib/gate-outcome-projection.js` | projects outcome trail into evidence-ladder claims for the Dream loop (fail-open reader, persists nothing) | ← dream-loop adapter |
| R-MEMSTORE-M (47, Memory) | `lib/memory-store*.js`, `lib/memory-{event,link,record,schema,query,package,temporal,supersede,tombstone,patch}*.js`, `storage.js`→see D2 (AgentAction), `lib/default-persistence-path.js`, `lib/store-creation-guard.js`, `lib/sqlite-busy-retry.js`, `lib/error-prevention/store.js`, `lib/sqlite-persistence-validation.js`, `persistencePaths.js` | MemoryStore owns `_memories/_events/_links`; read/write delegates behind the store API; schema/validation/normalization; path/durability helpers | ← kernel.js (store), delegates mesh internally |
| R-MEMSTORE-A (8, AgentAction) | `lib/memory-mutation-gate/*.js`, `storage.js`, `lib/storage/*.js` (14: schema/checkpoints/approvals/run-state) | memory-mutation gate (allow/review/block, no persistence); HuqanStorage holds approval leases/run-state/checkpoints/goal_memory — operational agent-loop state, no MemoryRecord rows; see D2 | ← agentRuntime, v3-storage-factory, ingest-approval-runtime, approval-store-factory |
| R-MEMSTORE-T (5, Trust) | `lib/memory-admission-gate*.js`, `lib/memory-recall-gate.js` | admission decisions (allow/review/reject/quarantine) + per-record admit/degrade/withhold on provenance/staleness, emitting ledger events | ← kernel-learn-admission, memory-lifecycle, query engine |
| R-MEMSTORE-K (1, Knowledge) | `lib/memory-blast-radius.js` | learn-write impact via backwardChain + causal simulation BEFORE write | ← kernel-learn-admission |
| R-MEMSTORE-P (1, Platform) | `lib/memory-lifecycle.js` | stateless composer of 6 modules (write→read→score→verify); 0 static callers (wiring pending, recorded) | (none static; header documents live seam) |
| R-PROV-T (33, Trust) | `lib/provenance-*.js`, `lib/audit-*.js`, `lib/trust-{policy,status,calibration,evidence-ledger,score-aggregator}.js`, `lib/mutation-{admission,journal-lock}.js`→journal is Knowledge (see below), `lib/admission-horizon.js`, `lib/ingest-{approval,snapshot-build,snapshot-verify}.js`, `lib/module-reachability*.js`, `lib/incident-envelope.js`, `lib/release-evaluation-record.js` | provenance minting (`prov_` sha), audit vocabulary + bounded reads, trust policy/projection, admission seam (never calls runMutationOnce), immutable external snapshots, wiring-audit support, signed attestation formats | ← kernel, conflict-detector, HTTP trust routes, MCP readers |
| R-PROV-K (4, Knowledge) | `lib/mutation-journal.js`, `lib/mutation-journal-lock.js`, `lib/trust-signals/*.js` | JSON-backend authority for graph runMutationOnce replay protection; robustness-lite stress probe over verify() (takes verify fn, never kernel, writes nothing) | ← graph-mutation-runtime; ← verify-result |
| R-PROV-A (2, AgentAction) | `lib/provenance-drift.js`, `lib/provenance-ingest.js` | drift findings queued as pending conflict candidates (never rewrites truth); ingest applies trust policy at the pipeline | ← connectors, kernel-learn-input |
| R-RECEIPT-T (28, Trust) | `lib/receipt/*` | canonical payload + stableStringify hashing/chaining, chain validation, family classification, seals, read-index, export integrity | pervasive: kernel, graph, HTTP/MCP/workbench readers |
| R-REGV5-T (4, Trust) | `lib/registry/*` | registry admission + read re-resolving the trust root live | ← HTTP optional-boundaries |
| R-V5X-T (14, Trust) | `lib/v5/*` | shared trust-package writer/validators, verification core, structural signing | ← HTTP v5 import/preflight routes |
| R-GATES-A (175, AgentAction) | gates/firewall/risk/approval/sandbox/tool/oversight/identity/budget/autonomy/coder/pr-guardian/safety families (full list in manifest) | allow/review/block verdicts, fail-closed enforcement, risk taxonomies, approval state machines, sandbox isolation, human-oversight cases, code-change gate, self-healer safety (observe/propose, never apply) | ← agent loop, workflow registry, MCP dispatch, HTTP/CLI surfaces |
| R-GATES-K (1, Knowledge) | `lib/gate-outcome-projection.js` | (same as R-LEARN-A; single file, one row — listed here for the family; manifest row is R-LEARN-A) | — |
| R-GATES-O (1, Observability) | `lib/gate-telemetry.js` | central gate-decision event emission via observability sink, explicitly non-authoritative | ← step-executor, loop-budget, learn-admission, tool-dispatch |
| R-GATES-T (6, Trust) | `lib/approval-{receipts,execution-evidence}.js`, `lib/sandbox-escape-{ledger,producer}.js`, `lib/autonomy-{receipt-history,trust-score}.js` | approval audit events + reviewed-action receipts, durable escape-attempt records, bounded receipt-trail scoring ("never a second authority") | ← approval-flow, guard finalization, autonomy state |
| R-GATES-P (1, Platform) | `lib/shield.js` | huqan-vs-LLM check comparison for the HTTP/SDK boundary (classifies, decides nothing; learn hint consumed by caller) | ← core-http-routes, sdk |
| R-EXTACTION-A (28, AgentAction) | `lib/external-action-{guard,envelope,identity,gate,egress,adapter,installer,sentinel}*.js`, `lib/control-plane-paths.js` | one normalized action through allow/block gates; envelope normalization; install wiring; command-policy; connector firewall | ← index, browser-hook, gate-hook, HTTP command route |
| R-EXTACTION-T (12, Trust) | `lib/external-action-receipt*.js`, `lib/external-action-identity-log.js` | canonical admission/outcome receipts, bounded JSONL trail, identity attestation log, receipt storage (writer-factory) | ← guard finalization, gate-hook, HTTP collector route |
| R-EXTCLIENT-A (21, AgentAction) | `lib/external-client-{authority,endpoint,http-adapter,package-gate,production-boundary,replay-store,trust-config}*.js`, `lib/atp-conformance*.js`, `lib/{huqan,axiom}-package-format*.js` | external-action admission transport + idempotency (replay-store = SQLite reservations, not trust records), package conformance validation | ← server boundary, sdk, a2a validation |
| R-EXTCLIENT-T (7, Trust) | `lib/external-client-mutation-receipt-owner*.js` | commits candidate claim to quarantine + seals admission receipt via mutation-admission + agent identity | ← production-boundary |
| R-EXTCLIENT-P (1, Platform) | `lib/sdk.js` | programmatic client surface composing shield + package-gate + authority | ← production-boundary (legacy edge) |
| R-WORKFLOW-A (21, AgentAction) | `lib/workflow-*.js`, `workflow-tools.js`, `lib/coder/{apply-derivation,derivation-record,observed-verification,verify-derivation,verify-ocr}.js`, `lib/deterministic-task-runner.js`, `lib/task-*.js`, `lib/code-anchor.js` | workflow planning + registry enforcing the firewall; coder pipeline (read→transform→gate→write, every write through code-change gate); content-anchored code locations for contracts | ← workflow-runtime, agentRuntime, cli-coder |
| R-WORKFLOW-P (2, Platform) | `lib/coder/journal-store.js`, `lib/workflow-contract.js` | `coder --journal` composition root (connects only); workflow↔MCP/HTTP schema contract surface | ← cli-coder, 11 CLI/HTTP/MCP surfaces |
| R-WORKFLOW-T (1, Trust) | `lib/coder/experience-reporter.js` | one journal append per coder-pipeline stage (holds no handle, never throws into the pipeline) | ← apply-derivation |
| R-CLI-P (40, Platform) | `lib/cli-*.js` (38), `lib/quickstart*.js` (2), `lib/cli-mutation-audit-intent.js`→Platform-infra (R-SHARED-P row) | CLI presentation/command tables over all contexts; read-only presenters (receipt-read-index, graph-hypotheses, inference-*) that describe but never own | ← cli.js |
| R-MCPFLAT-A (5, AgentAction) | `lib/mcp-{tool-policy,approval-views,input-sanitizers}.js`→views/sanitizers are AgentAction (approval presentation + sanitization for gates), `lib/mcp-gate-adapter*.js` (6+policy) | AB1–AB11 gate runners (fail-closed merges); approval-record presentation; input sanitization | ← tool-dispatch, agent loop, CLI/HTTP surfaces |
| R-MCPFLAT-P (17, Platform) | `lib/mcp-{capability-nonce,configuration-errors,envelope-format/schema,tool-catalog*,tool-data-schemas*,tool-names,operator-capability}.js` | transport descriptors/sanitization/schemas serving all contexts; `-trust`/`-knowledge` schemas describe but never implement those contexts | ← tool-surface, mcpServer, HTTP routes |
| R-HTTP-P (57, Platform) | `lib/http/*` routes/mounts/middleware (minus Trust/Observability/Shared rows) | request-handler composing 15 route handlers + auth/rate-limit/cors; auth-policy default-DENY; routes delegate to domain modules | ← server.js boot; see legacy edges |
| R-HTTP-T (2, Trust) | `lib/http/{http-provenance,identity-mutation-admission}.js` | strips caller-controlled provenance keys (trust decision); builds HTTP audit identity + mutation admission | ← core-http-routes, audit-writer |
| R-HTTP-O (1, Observability) | `lib/http/structured-log.js` | secret-scrubbed structured logging for the observability pipeline | ← observability server-runtime/instrumentation |
| R-OBS-O (29, Observability) | `lib/observability/*` | event writer/run recorder/queries/alert-rules/jobs over one db; best-effort (contrasts with Trust durability in journal header) | ← server-ingest-workflow-runtime; kernel-sink ← gate-telemetry |
| R-OBSMISC-O (8, Observability) | `finalizer.js`, `lib/finalizer-{run-summary,text}.js`, `lib/runtime-watchdog*.js`, `lib/server-graph-data.js`, `lib/system-status-report.js`, `lib/ai-dependency-ratio.js` | run/system summaries, process supervisor, read-only graph-data projection, deterministic-ratio metric | ← agent-step-executor, workflow guidance, CLI/MCP consumers |
| R-OBSMISC-K (2, Knowledge) | `lib/finalizer-causal-{normalize,summary}.js` | causal-chain narration helpers over graph chains | ← finalizer.js |
| R-OBSMISC-P (1, Platform) | `lib/legacy-alias-usage.js` | in-memory AXIOM-alias usage counters (deprecation telemetry, dependency-free) | ← env-compat, HTTP status, tool-names |
| R-EXP-T-T (18, Trust) | `lib/experience/{contract,journal,journal-connection,learning,learning-intake,compiler,procedure-registry,promotion-ci-gate,promotion-staged-eval,learn-read-back,verifier,reconciliation,repair,run-repair,optimization-hypothesis,canary,capability-trust*}.js` | durable ordered integrity-protected append ledger (`store.withTransaction`); LearningRecord admission (never activates); procedure-candidate pool; capability-trust ladder recomputed from evidence; promotion CI gate (`promotion-ci-gate`) and staged-trial gate (`promotion-staged-eval`) | ← agentRuntime, cli-experience-learn, MCP learn tools |
| R-EXP-A-A (7, AgentAction) | `lib/experience/{effect-boundary,runtime-seam,step-lifecycle,router,personal-execution-model,adapter-scope,write-cost-budget}.js` | execution gating/routing/cost-budget around the agent loop; PEM is a versioned composition of references (no weights, no new storage/gate) | ← agent.js, agent.v3.js, agentRuntime |
| R-EXP-O-O (1, Observability) | `lib/experience/read-model.js` | sealed-run read projection with projectionHash, shared by CLI+MCP+HTTP | ← 3 read surfaces + learning-intake |
| R-A2A-A-A (13, AgentAction) | `lib/a2a/{exchange-route-firewall,authority,contract,refusals,handler,bounded-exchange*,capability-negotiation,retry-classification}.js` | firewall/policy evaluation + bounded-exchange admission | internal mesh; ← registry-route, conformance |
| R-A2A-T-T (4, Trust) | `lib/a2a/{inter-agent-receipt-chain,delegation-audit-log,replay-store,task-store}.js` | hashed route receipts with risk ceilings; durable exchange records | ← exchange handlers/routes |
| R-A2A-I-P (5, Platform) | `lib/a2a/{routes,exchange-route,agent-card-route,negotiate-route,task-route}.js` | single mount composing 4 boundaries so server.js keeps one line | ← HTTP optional-boundaries |
| R-A2A-I-K (1, Knowledge) | `lib/a2a/agent-card.js` | Agent Card builds a *claim about a deployment* from identity authority + frozen capability table (no key material, no negotiation) | ← route files, registry-route |
| R-WB-A-A (1, AgentAction) | `lib/workbench/ingest-approval-action.js` | repaired decision+execution path for ingest approval (bounded action owner, never writes graph) | ← ingest-approval-runtime, ingest-execute-tool |
| R-WB-T-T (4, Trust) | `lib/workbench/{ingest-approval-audit,ingest-approval-audit-writer,trust-receipt-inspector,receipt-bundle-exporter}.js` | audit writers + receipt inspector/exporter over receipt-read-index/stamp | ← HTTP audit-writer, badge/export routes |
| R-WB-I-P (8, Platform) | `lib/workbench/{workbench-read-http-router,activity-*,memory-context-*,trust-receipt-route,receipt-bundle-export-route}.js` | HTTP read routers projecting workbench reads (receipt/audit injected) | ← server-read-route-runtime |
| R-CAUSAL-K (11, Knowledge) | `lib/causal/*` | causal Edge relation/strength bands + verdict facade (supports/contradicts/cycle_blocked) | internal mesh; verdict ← provenance-query-trust-receipt |
| R-CONN-A (5, AgentAction) | `lib/connectors/*` | every connector execution through executeConnectorAction (always-on firewall) | ← repo-memory plugin |
| R-ERRP-A (14, AgentAction) | `lib/error-prevention/*` (minus store/audit) | preflight engine merging upstream + prevention verdicts onto CANONICAL_VERDICTS, fail-closed | ← index (self-contained gate subsystem) |
| R-AUTOSG-A (10, AgentAction) | `lib/automation-safety-gate/*` | evaluateAutomationSafety + allow/review/block vocabulary | ← agent-action-decisions/firewall, guard-gate-phase |
| R-INTEROP-P (2, Platform) | `lib/interop/*` | W3C VC envelope + OTel mapping (transport envelopes) | ← root index |
| R-LLM-P (3, Platform) | `lib/llm-proxy/*` | byte-transparent OpenAI passthrough (observes+receipts, never gates) | ← HTTP server-request-handler |
| R-MCPDIR-P (20, Platform) | `lib/mcp/*` | tool dispatch + stdio/JSON-RPC transport + read-only learn/read/audit tools (proposals/projections, install nothing) | ← mcpServer; tools ← tool-handlers |
| R-PILOT-T (2, Trust) | `lib/pilot/{trust-receipt-pilot,trust-receipt-pilot-archive}.js` | pilot receipt schema + stableStringify hashing + signature domain | ← root index |
| R-PRG-A (9, AgentAction) | `lib/pr-guardian/*` (minus receipt) | risk patterns mapping diff/intent to allow/review/dry_run_only/block; review-service execute | ← HTTP pr-guardian/webhook routes |
| R-PRG-T (1, Trust) | `lib/pr-guardian/review-receipt.js` | execution receipt shape stored on the approval record | ← review-service-execute |
| R-SELF-A (14, AgentAction) | `lib/self-healer/*` | safety matrix (observe/propose/require_review/block/quarantine; AXIOM judges, human decides, never applies) | ← self-healer-audit plugin, post-action-monitor |
| R-STORAGE-A (14, AgentAction) | `lib/storage/*` | checkpoints/goal_memory/agent_runs schema + ToolApprovalMethods persisting gate approval records; run-state keys | ← storage.js, backupRestore.js, cli-doctor |
| R-VERDICT-A (1, AgentAction) | `lib/verdict/action-verdict.js` | canonical verdict set + ADMISSION/MCP mapping tables (projection, changes no gate decision) | 12 incl. kernel, receipt-canonical, response-builders |
| R-VIEWER-P (4, Platform) | `lib/viewer/*` | gateway composing sessionStore + injected readReceipt + static assets over HTTP | ← HTTP viewer-mount |
| R-GHAPP-P (10, Platform) | `lib/github-app-beta-{auth,handler,http-*}.js`, `lib/github-app-streaming-{auth,trust-handler}.js`, `lib/github-connector-{,ingest}.js` | HTTP/webhook transport boundary (signature verify, routing, error mapping); connector fetch+normalize transport | ← github-app-server; snapshot ← connector |
| R-GHAPP-T (12, Trust) | `lib/github-app-beta-store.js`, `lib/github-app-streaming-trust-{binding,check-run,contract,github-api,receipt,store*}.js`, `lib/github-connector-provenance.js`, `lib/repo-file-pin.js`, `lib/github-app-streaming-trust.js` | receipt-chain persistence + receipt-chained check conclusions; provenance minting + pinning | ← beta-handler, trust-internal |
| R-COMPANY-K (11, Knowledge) | `lib/company-brain-{identity,ingest,query,state}.js`, `lib/causal-edge-strength.js`, `lib/causal-simulator-{chains,report,scoring}.js`, `lib/web-research*.js` (3) | ingest writes graph via proposeNode/proposeEdge + causal strength; external-evidence gathering verified against conflicts | ← company-brain plugin, HTTP workflow routes |
| R-ADAPTERS-A (4, AgentAction) | `adapters/{external-action/*,http-adapter-transport,http-adapter-robots}.js` | external-action gate check before tool calls; SSRF-pinned fetch; robots allow/block policy | standalone adapters |
| R-ADAPTERS-K (10, AgentAction→Knowledge: 10 files) | `adapters/{git-log,github-*,http-adapter,http-adapter-html,json,markdown,pdf,yaml}-*.js` | fetch/parse sources into learnable entries via learn-entries | ← repo-memory plugin |
| R-ADAPTERS-T (1, Trust) | `adapters/utils/learn-entries.js` | builds provenance envelope + executes kernel.learn (provenance construction is the distinguishing fact) | ← 5 ingest adapters |
| R-PLUGINS-K (11, Knowledge) | `plugins/{company-brain,contradiction-alert,devil-advocate,discovery-engine,experiment-planner,idea-mri,knowledge-freshness,llm-memory,replication-checker,repo-memory,result-analyzer}.js` | graph-claim operations (ingest/discovery/staleness/conflict analysis) via kernel/graph | dynamically loaded via PluginManager (0 static callers by design) |
| R-PLUGINS-A (5, AgentAction) | `plugins/{decision-explainer,evidence-validator,policy-watchdog,secret-masker,workspace-sync}.js` | gate-decision explanation, beforeLearn firewall hooks, policy-drift lock, secret masking, cross-workspace evaluation | dynamic load; validator→adapter direction verified |
| R-PLUGINS-T (2, Trust) | `plugins/{receipt-exporter,self-healer-audit}.js` | admission-receipt export; audit-runner/finding pipeline + approval bridge | dynamic load |
| R-PLUGINS-O (2, Observability) | `plugins/{daily-digest,metric-collector}.js` | per-day run-outcome accumulator; gate-decision aggregate export | dynamic load |
| R-NLP-K (6, Knowledge) | `nlp/*` | multilingual normalize/tokenize/fact-pack extraction | ← kernel.js |
| R-SCHEMAS-T (7, Trust) | `schemas/v5/*` | agent-identity conformance/coverage/readiness/validators + shared trust-package validators | ← v5 import route, readiness script |
| R-PACKAGES-T (2, Trust) | `packages/*/index.js` | verifyATPObject/withStatusFailure + package validators (axiom entry is a compat alias) | alias ← huqan-verify |
| R-SHARED-P (19, Platform) | generic infrastructure primitives (full list in manifest; e.g. `is-plain-object`, `workspace-id`, `path-safety`, `secure-file-write`, `text-utils`, `sqlite-availability/durability`, `environment-compat`, `kernel-contract`, `mcp-tool-names`) | dependency-free helpers called from all contexts; no domain state, no policy | 3–103 callers spanning every owner |
| R-REQG-P (2, Platform) | `requestGuards.js`, `requestGuards-body.js` | API middleware composition + bounded JSON body reader | ← 18 HTTP routes + 2 domain clients (legacy edges) |
| R-REQG-A (2, AgentAction) | `requestGuards-{command-policy,rate-limit}.js` | unsafe-command policy + per-IP rate gate | ← requestGuards.js |

## Disagreements and owner resolutions (recorded, not settled by recency)

- **D1 kernel.v2 — Platform, overruling the 10-row map's AgentAction.** The old
  row cited only factory/index callers (both composition). Added behaviour is
  verify/contradiction/evidence (Knowledge) plus risk-aware learn (Trust
  admission) — itself cross-cutting, so a single domain label would lie.
  Platform (canonical runtime facade) is the honest owner. Revisit if V2 gains a
  single-domain responsibility.
- **D2 storage.js — AgentAction, overruling the memory-store intuition.**
  Wiki-demanded port analysis: callers are exclusively agent-loop/approval
  composition (agentRuntime, agent-v3-storage-factory, ingest-approval-runtime,
  mcp-approval-store-factory); rows are approval leases (#426), run-state,
  checkpoints, goal_memory — operational agent state, zero MemoryRecord and
  zero Trust-receipt rows. MemoryStore stays the sole Memory owner. The
  "AgentAction must not own persistence internals" row means reaching into
  another context's store, which storage.js never does.
- **D3 lib/github-connector.js — Platform facade over three owners.**
  11-line facade re-exporting normalize (Platform-infra), provenance (Trust)
  and ingest (Platform). Callers (gate snapshot, ingest chain) are mixed, so
  the facade is composition, not a domain decision. Wiki's "verify first" is
  satisfied by the caller list, not by a domain label.
- **D4 shared-vocabulary tension (text-utils, memory-store-utils).**
  text-utils (18 cross-context importers) is Platform-infra: pure string
  helpers, no domain state. memory-store-utils stays Memory: its helpers are
  memory-id/provenance/path shaped (25 callers reuse generic sub-helpers only).
- **D5 graph-sqlite-schema.js — Knowledge, receipt tables noted.**
  Nodes/edges DDL extracted verbatim from graph.js (caller: graph.js), but it
  also installs mutation-receipt + seal tables. If a future decision counts
  receipt-table ownership as Trust, that half splits out; recorded here.
- **D6 low-confidence rows (kept, flagged):** `personal-execution-model.js`
  (AgentAction; 0 runtime callers — wiring pending), `code-anchor.js` +
  `self-test-oracle.js` (Knowledge/AgentAction; test-only static callers),
  `memory-lifecycle.js` (Platform; 0 static callers — NOT_YET_WIRED;
  `provenance-ingest-adapter.js` was removed unwired in #3315), `agent-card.js` (Knowledge;
  deployment-claim reading), `shield.js`/`fluent-answer.js` (Platform boundary
  presentation), `error-taxonomy.js` (Platform transport vocabulary).
- **D7 learn-feeding leaves stay Knowledge** (learn-document, learn-from-llm,
  self-learn, self-evolve, kernel-cognition family): they prepare/shape learn
  input; the admission decision itself lives in the Trust-owned
  kernel-learn-admission. If the epic wants a stricter line, these are the
  named split candidates — not silently moved today.
- **D8 conflicts with the candidate table in the Wiki page** (kernel.js,
  storage.js, github-connector.js rows): resolved above with caller evidence;
  the Wiki page itself demands "resolve disputed rows from callers", which is
  what D1–D3 do. storage.js's "port split first" is §R-MEMSTORE-A.

## Ports, legacy edges, graduated seams

- 276 FILE-level published ports with measured consumer sets (generated from
  the require graph at `ea5a0e24`; evidence string on each row; reproduce and
  verify with `node scripts/generate-context-ports.js --check`, which CI runs).
  Top hubs:
  `receipt/canonical-receipt` (19 importers), `external-action-receipt` (11),
  `memory-store-utils`, `action-verdict`, `conflict-detector` (7 each).
- 16 dated legacy edges (all `reviewBy: 2026-12-31`): Domain→Platform entrypoint uses the gate cannot yet express as ports (approval-store→kernel-factory,
  approval-execution→agentRuntime, ingest tools→ingest composition, webhook
  auth boundaries, registry→exchange-route, research→HTTP envelope, ...) — see
  `legacyEdges` reasons. Each names its edge, owner, reason and expiry (v0.1).
- Graduated: the two `graph.js → Trust receipt` imports (old disagreement 2)
  are now published ports with Knowledge consumers — the seam graduated from
  dated exception to published contract. No legacy row remains for them.
- Platform→Domain (267 measured edges) all target published ports with
  Platform consumers — composition goes through public contracts (v0.1).

## Conflict check (before starting — done, no duplication)

- #2372 + #2373 (eight record surfaces): Trust/Observability/Experience split
  aligns; no ninth surface created (experience journal ≠ observability
  best-effort, noted in journal header).
- #2401 + #2402 (review queue decides scope): scope table above reuses their
  runtime/tooling/adapter/ui signals; no module under review there is silently
  reassigned (all verdicts carry source+caller facts).
- #2115 port scope: Graph/Memory ports implemented (#2906 closed); the map
  consumes them, duplicates nothing.

## Acceptance

- [x] The ownership manifest is committed and gate-enforced
  (`scripts/context-ownership.json`, 855 + 223 rows, schema v2).
- [x] `npm run check:module-boundary` is context-aware and zero (0 calls,
  0 unmapped, 534 cross-owner imports checked).
- [x] Gates green: cycles, file-size, module-boundary, layers,
  package-closure, docs-drift, lint (CI; local runs below with counts).
- [x] Full `npm test` reported with pass/fail/skip counts (CI; local targeted
  runs below — Windows-only failures pre-exist per #1363 and are compared by
  test NAME, never by count).
- [x] No behaviour change: `lib/` and root runtime untouched; only
  `scripts/context-ownership.json` (data), `scripts/check-module-boundary.js`
  (gate), `test/check-module-boundary.test.js` (tests) and this doc changed.
- [x] #2115's done-when conditions are unaffected (no debt released, no
  ceiling raised).

## Done when (epic text)

Every in-scope module has exactly one owner (855 domain + 223 Platform rows
above, 0 unmapped — the gate fails any file added without a row), the boundary
is enforced by the gate rather than by memory, and the next agent can tell
where a change belongs without asking (row catalog + per-file evidence
anchors).

## Working covenant (to every agent in this repo)

1. Work carefully, so that what you do cannot harm the project. When unsure,
   stop and write the question down instead of guessing.
2. Never report a result you did not observe. Observed, candidate,
   reproduced, confirmed stay separate.
3. Never present a mock, a unit test or a self-reported success as live use.
4. Never fabricate evidence: not a number, not an exit code, not a SHA, not a
   file's contents, not a test that was not run.
5. Do not force work you cannot complete. Say so, leave the tree consistent,
   and open the decision as its own issue.
6. Leave the gates green. A red gate is not someone else's problem.
7. Respect prior labour: read existing issues/PRs, do not redo done work, do
   not silently overrule a recorded decision (D1–D8 name what they overrule).
8. If you cannot finish, say what was not done and what was not verified.

## Coder test loop

`lib/coder/fix-loop.js` and `lib/coder/test-execution.js` belong to
AgentAction: they apply gated candidates, execute declared tests, verify the
result and restore failed candidates. The loop calls `applyDerivation` and
`runDeclaredTest`; it exposes a port to Platform through `lib/cli-coder.js`.
`lib/coder/cli-composition.js` is a Platform entry that supplies this port to
the existing command table. It holds no domain decisions. Test and rollback
evidence use the existing Experience journal, not another persistence store.
