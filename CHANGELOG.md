# Changelog

## v0.11.0

### Added
- **fractal-learn (#1714).** New `huqan.fractal-learn` MCP tool running a
  bounded recursive knowledge-synthesis loop: it chains `kernel.dream` rounds
  (hypothesis generation admitted through the mutation gate) and stops when the
  per-round entropy gain saturates (`exhausted` / `saturated` / `maxRounds`).
  Every write is receipted and the tool is gated `mutating_requires_review`, so
  the graph never grows silently.
- **autoTune (#1716).** `huqan.fractal-learn` gains a one-way `autoTune` mode:
  after each round it reads review feedback and tightens `minScore` /
  `entropyFloor`, but never loosens them automatically. Tightening is recorded
  per round; loosening always requires human approval.
- **Graph health scoring and threshold tuning advice.** `huqan fitness` scores
  graph health (coverage, precision, connectivity, consistency → A–F grade);
  `huqan tuning` turns review feedback into a threshold proposal — advice only,
  it never applies a change.

## v0.10.1

Unreleased — the manifest is bumped and waiting on a `v0.10.1` tag. Until that
tag is pushed, `npm install -g huqan` still serves v0.10.0, which carries none
of the fixes below.

Primarily a security release, and the first release since v0.10.0 reached the
registry on 2026-08-27, so it also carries everything else that landed in
between.

### Added
- **Graceful shutdown on SIGTERM/SIGINT (#1697).** `server.js` stops accepting
  connections and drains the HTTP server before closing observability timers,
  viewer state, approval storage, external-client resources and the kernel
  graph. A five-second fail-safe exits non-zero if the drain does not finish,
  so a container stop no longer severs in-flight requests silently.

### Fixed
- **Mutation journal replay tracking (#1671).** Journal sections are
  null-prototype maps. On a plain object `operations['__proto__'] = entry`
  re-points the prototype instead of creating an own property, so a completed
  mutation left no record and the same operationId ran a second time;
  `constructor` and `toString` failed the other way, reading an inherited value
  back as a journal row. Persisted records keep own-property semantics across a
  JSON round trip.
- **External client transport (#1672).** `scripts/external-client.js` requires
  HTTPS for any bearer-authenticated destination that is not loopback. It
  previously sent `authorization: Bearer <HUQAN_API_KEY>` in the clear to
  whatever URL it was given. Plain HTTP survives only for `127.0.0.0/8`,
  `[::1]` and `localhost`, where the request never reaches a network interface,
  and the check runs before the credential is read.
- **Release authority (#1673).** `publish.yml` checks the ref for every
  trigger, not only for tag pushes. A manual `workflow_dispatch` could reach
  `npm publish` from any ref, skipping the tag/version binding entirely. A
  publish now requires an immutable `v<version>` tag matching the manifest whose
  commit is an ancestor of the default branch, and the job runs in the
  `npm-publish` environment.
- **MCP capability replay (#1674).** Consumed capability nonces are recorded
  durably, one exclusively-created file per nonce, instead of in a process-local
  map. A restart inside a capability's five-minute validity window used to
  forget the nonce and accept a spent token again. Reservation is atomic across
  workers; verification stays fail-closed when the store cannot be written.
- **PR Guardian execution (#1675).** An approved action is claimed atomically
  into `executing` before the GitHub call and finalized with an explicit
  execution record, so a repeated or concurrent request cannot post the comment
  twice. A call that threw is left `failed` with an unknown outcome rather than
  silently retried.
- **Docker build context (#1676).** Environment files, npm/yarn credentials,
  private keys, certificates and service-account material are excluded before
  the runtime stage's `COPY . .`, with example files re-included.
- **PR Guardian webhook destination (#1677).** The workflow validates
  `PR_GUARDIAN_WEBHOOK_URL` before building or signing anything: HTTPS unless
  loopback, no embedded credentials, fragment or query, and no control
  characters. Its checkout is pinned to the base SHA, so the scripts the job
  runs are the reviewed ones rather than the pull request's.
- **Data loss on a corrupt JSON graph (#1703).** JSON graph loading moved to
  its own persistence module and now rejects malformed JSON, bad record
  shapes, explicitly null collections and colliding normalized node ids. A
  failed load keeps the previous in-memory view but refuses `save()` and
  canonical mutations with `GRAPH_JSON_LOAD_FAILED`, so a damaged file can no
  longer be overwritten by the process that failed to read it. Writing
  reopens only once a valid snapshot loads.
- **Concurrent SQLite mutations (#1698).** The durable mutation transaction
  takes `BEGIN IMMEDIATE`, acquiring the write reservation before the
  idempotency re-check. Two processes could previously both enter the mutation
  callback for the same `operationId`.
- **A dead lock owner blocked writers for 30 seconds (#1706).** The JSON
  mutation journal consulted a lock record's age before its pid, so a crash
  left every later mutation waiting out the full lock timeout and then failing
  with a contention code — while the owning process was provably gone. A
  parsed record naming a dead pid now decides at once; age remains the
  fallback where liveness cannot settle it, which is what keeps a half-written
  lock from a live writer from being evicted. The verdict is unchanged: the
  lock is still preserved for investigation and never silently stolen.
- **MCP resources left open on shutdown (#1701).** The MCP server closes owned
  approval and kernel resources on JSON-RPC shutdown, idempotently and aware
  of what it owns, and exits non-zero when cleanup fails.
- **Hypothesis noise (#1643).** `dream()` no longer treats markdown table
  pipes, CI job ids, or punctuation-only nodes as hypothesis sources, so the
  human review queue stops filling with proposals built from ingest debris.
- **The first sixty seconds of the CLI (#1693, #1694, #1695).** The gate
  refusal for a mutating command was Turkish on an English CLI, half its
  diacritics stripped, and named no way forward; it is now English, states the
  decision and reason, and points at a next step that exists. Five
  `[Plugin] … disabled` warnings no longer precede every command's output —
  `huqan status` reports which plugins are active, which are waiting on a
  capability, and which capability each one wants. The quickstart no longer
  ends by suggesting a command that answers `unknown` against the reader's own
  graph.

### Documentation
- **The decision vocabulary in the README matches the code (#1705).** The
  "How it works" outcome line advertised an `ESCALATE` result no gate returns
  and omitted `quarantine` and `reject`, which the memory admission gate does.
  Escalation is real but belongs one layer up — a reviewer's decision at the
  approval boundary, present where an organization has more than one approver
  and absent in a single-user install — and the README now says so.
  `test/readme-decision-vocabulary.test.js` reads the constants and fails if
  the prose drifts from them again.

### Tests
- Filesystem failure modes: read-only persistence directory, truncated
  mutation journal, corrupt SQLite file (#1699).
- HTTP transport failure paths over real TCP: auth rejection before ingest
  mutation, declared and chunked uploads over the body limit, malformed JSON
  (#1700).
- Real multi-process coverage for the SQLite durable journal, including a
  process killed inside a transaction (#1698).

## v0.10.0

Published to npm on 2026-08-27 — the first version on the registry. Before it,
every install was a `git clone`.

### Added
- `huqan-mcp` binary. `bin/huqan-mcp.js` is a `bin` entry that starts the MCP
  server by name instead of by absolute path, so Claude Desktop can be
  configured with `npx -y --package=huqan huqan-mcp` and no prior install. It is
  a file of its own rather than a shebang on `mcpServer.js`, which sits at
  exactly the 800-line threshold `scripts/check-file-size.js` enforces.
- `scripts/check-package-closure.js` and `npm run check:package-closure` — fail
  when a module the installed package loads is missing from
  `package.json#files`. It walks *load-time* requires outward from `main`, every
  `bin`, and each published plugin and adapter; requires behind a guard are out
  of scope, which is what keeps the deliberately repo-only V5 family from being
  reported as a defect. Wired into `prepublishOnly`, so a publish that would
  ship a broken tarball fails before it uploads.
- `GET /api/v2/memory-approvals` and `POST /api/v2/memory-approvals/{id}/decision`
  — operator-gated approval over HTTP. Both require the API key *and* a separate
  operator token in `x-huqan-operator-token`, so the surface that may propose a
  memory write cannot approve it. Unconfigured, they answer 404.
- `docs/a2a-deployment.md` — the operator recipe for the four A2A routes, which
  shipped with no way to turn them on.
- English spellings for every CLI command that had only a Turkish one: `status`,
  `dream`, `save`, `think`, `stop thinking`, `consolidate`, `hello`, `agent:`,
  and bare `why X`. The Turkish spellings keep working.

### Fixed
- A `PREVENTS` edge made `verify` contradict the sentence that states it, at
  confidence 0.95. `CAUSES`, `ENABLES` and `DEPENDS_ON` were correct; only
  `PREVENTS` inverted.
- Manual and decision ingest failed on every causal relation. `addCompanyEdge`
  never passed `strength`, which `graph.js::addEdge` requires for a causal
  relation and enforces by throwing, so each attempt left orphan nodes and no
  edge. The rule now lives in `lib/causal-edge-strength.js`.
- `huqan.policy` reported HUQAN's own advertised tools as unknown third-party
  tools: `huqan.learn` answered `external / block` while `learn` answered
  `internal / allow`. Namespaced names now resolve, and MCP tool names are
  answered from `lib/mcp-gate-adapter.js`, the authority for what calling one
  does.
- Turkish prose on English API surfaces: the evidence sentences built in
  `lib/verify.js` and the MCP tool descriptions. Three of those literals also
  carried `U+FFFD`, so callers were reading `Say?sal kar??la?t?rma`.
- `docs/current-agent-checkpoint.json` pinned a `canonicalMain` SHA that is not
  a reachable object in this repository, which failed
  `scripts/agent-context.js` and four tests.
- Three modules loaded by the installed package were missing from
  `package.json#files`, so `npm install` produced a tarball that threw
  `Cannot find module` at load: `lib/safe-file-walk.js` (required by all four
  file adapters — JSON, Markdown, PDF and YAML), `lib/causal-edge-strength.js`
  (the `company-brain` plugin) and `lib/connectors/entry-ingest-flow.js` (the
  `repo-memory` plugin). Every path resolved from a clone, so nothing in the
  repository noticed. `check:package-closure` above is the guard that now does.
- `README.md` named the A2A environment variables without their `HUQAN_`
  prefix, so following it verbatim left the routes off.

### Changed — install footprint
- `pdfjs-dist` and `pdfkit` moved to `optionalDependencies`, and both are now
  loaded on first use rather than at require-time. Previously a top-level
  `require` in `plugins/receipt-exporter.js`, and a `require.resolve` for the
  standard-font path in `adapters/pdf-adapter.js`, made a missing or
  half-installed PDF dependency take the whole module down at load — the kernel
  printed `Plugin failed to load: receipt-exporter.js` at every start and the
  plugin's JSON export went down with the PDF one. The failure now lands on the
  PDF call that needs it, as `HUQAN_PDF_EXPORT_UNAVAILABLE` naming the package
  to install. `npm install --omit=optional` takes the install from about 111 MB
  to about 20 MB with the full learn → approve → verify → receipt path intact.

### Known limits of the published tarball
- `POST /api/a2a/exchange` cannot be enabled from an `npm install`. It reaches
  the V5 cryptographic family, which `package.json#files` deliberately does not
  publish, so the route stays `404` there however it is configured; the other
  three A2A routes do turn on. Run the exchange from a clone. `README.md` now
  says so.

### Changed
- **MCP `huqan.verify` emits the canonical English status vocabulary**
  (`verified` / `contradicted` / `unknown`) instead of the Turkish one. This is
  a wire change on an advertised output schema, gated in RFC-001's M1-M4 shape:
  `HUQAN_MCP_LEGACY_VERIFY_STATUS=1` restores the legacy enum, and one predicate
  drives both the advertised schema and the emitted payload so they cannot
  disagree. Removal of the opt-in needs its own announced breaking release.
- The CLI command reference is English-first.
- AXIOM-era names moved to HUQAN across the surfaces that carry no wire, data or
  signed-artifact contract, each with the old name retained as an alias:
  `createAxiomClient`, `runAxiomSdkCommand`, the LangChain tool name,
  `server.closeAxiom`, `AxiomStorage`, the `axiom-core` crate, the identity
  fallback subject, and `lib/axiom-package-format.js`, whose implementation
  moved to the canonical filename.
- `/llm-sor` emits `huqanCheck` alongside `axiomCheck`, never instead of it.

### Unchanged, deliberately
The frozen ATP 0.1 lineage — `format: "axiom-package"`, `atpVersion: "0.1"`,
the fixtures under `specs/axiom-package-format/0.1/`, `packages/axiom-verify`
and the `.axiom.json` reader. They are what proves old packages still verify.
The `axiom.*` MCP aliases and `AXIOM_*` environment variables stay accepted on
input and are never emitted.

## v0.9.1

Released 2026-06-12 (Memory Core Final), following the 2026-06-07 AB1 Action Risk Classifier release.

### AB1 Action Risk Classifier (2026-06-07)

#### Added
- `lib/action-risk-classifier.js` — deterministic action risk classifier (AB1)
  - `classify(action, opts)` function — classifies intended agent actions before execution
  - 11 action types: `read_only`, `local_analysis`, `test_execution`, `file_write`, `memory_write`, `tool_execution`, `network_access`, `deployment`, `destructive`, `auto_merge`, `unknown`
  - 4 risk levels: `low`, `medium`, `high`, `critical`
  - 4 decisions: `allow`, `review`, `block`, `human_review`
  - Safe normalization: `null`, `undefined`, empty object, unknown types all handled without throwing
  - Policy version: `AB1.0.0`
- `test/action-risk-classifier.test.js` — 21 tests, 0 failures
  - 6 core tests covering all critical action types
  - 15 edge case tests covering null/undefined/malformed inputs

#### Rules (AB1)
- No agent action bypasses classification
- `auto_merge` and `destructive` are permanently blocked
- `deployment` requires explicit human review
- Unknown action types are never silently allowed

#### Not included (AB1 scope boundary)
- No tool execution
- No server/API/MCP changes
- No memory writes
- No deploy logic
- No auto-merge logic

### Memory Core Final Release (2026-06-12)

#### Added
- Memory Core compatibility aligned on `main` after PR #42.
- Main `MemoryStore` now exposes the Memory Core compatibility surface without replacing the normalized SQLite architecture.
- Release smoke now reflects the final verified full suite result: `1277 pass / 0 fail / 16 skipped`.

#### Highlights
- Main MemoryStore architecture preserved.
- Memory Core API compatibility aligned.
- SQLite and normalized persistence compatibility preserved.
- Deterministic memory behavior preserved.
- Provenance, audit, and workspace invariants preserved.
- Package schema and roundtrip coverage preserved.

#### Out of scope
- Self-Healer
- MCP tool surface expansion
- UI changes
- embeddings
- summary / cluster plugin
- runtime import/export expansion beyond the existing MemoryStore behavior

