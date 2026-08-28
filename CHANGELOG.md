# Changelog

## v0.10.1

Unreleased. A security release: every fix below landed after v0.10.0 was
published, so the version currently installable from the registry does not
carry them. Bump and tag before pointing anyone at `npm install -g huqan`.

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

