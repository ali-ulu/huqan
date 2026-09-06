'use strict';

/**
 * Who is allowed to touch the world, and on what grounds.
 *
 * scripts/enforcement-coverage.js finds every call site that can execute a
 * process, write to the filesystem or leave the machine. This file is the other
 * half: the recorded judgement about each one. A file with such a call site and
 * no entry here fails the check.
 *
 * Classification is per file rather than per line on purpose. A file has one
 * job, and eighty individually argued lines would be eighty places for a reason
 * to rot while the code moved under it. If a file's role changes, its entry
 * should change with it -- and that is a review conversation, which is the
 * point.
 *
 * The roles are ordered by how much they are trusted, most to least.
 */
const ROLES = Object.freeze({
  /**
   * This code *is* the boundary. Gating it would be circular: the sandbox
   * cannot ask itself for permission to be a sandbox.
   */
  enforcement: 'is the admission boundary itself; gating it would be circular',
  /**
   * Writes the evidence trail. A receipt that needed admission to be written
   * could not record a denial, so the audit record would be missing exactly the
   * events that matter most.
   */
  evidence: 'writes the audit trail; gating it would lose the record of denials',
  /**
   * The product's own datastore, under a path the product resolves. Not an
   * arbitrary write: the target is derived from configuration, not from agent
   * input.
   */
  persistence: 'the product datastore, at a path the product resolves, not one an agent supplies',
  /**
   * Runs only when a human invokes it directly from a terminal. There is no
   * agent in the loop to admit.
   */
  operator_tool: 'runs only under direct human invocation; no agent is in the loop',
  /**
   * Reads the outside world into the graph. It ingests; it does not act.
   */
  adapter_read: 'ingests external data; performs no mutation of the outside world',
  /**
   * Genuinely outside the boundary. Listed rather than hidden -- a governance
   * product that conceals its own gaps is making the error it exists to
   * prevent.
   */
  unguarded: 'outside the admission boundary; recorded openly rather than hidden',
});

/**
 * Every production file with a risky call site, and why it holds one.
 *
 * The reasons are specific because a generic one ("internal") would pass review
 * forever without anybody re-reading the code.
 */
const CLASSIFIED = Object.freeze({
  // ── the boundary itself ────────────────────────────────────────────────
  'sandboxRunner.js': Object.freeze({
    role: 'enforcement',
    why: 'spawns process.execPath running __filename in CHILD_MODE -- this is the AB6 isolation mechanism, and its argv is fixed in source',
  }),
  'lib/external-action-gate-install.js': Object.freeze({
    role: 'enforcement',
    why: 'installs and self-validates the gate hook into an agent profile; the spawns are the gate proving itself and the writes are its own configuration',
  }),

  // ── the evidence trail ─────────────────────────────────────────────────
  'lib/external-action-receipt.js': Object.freeze({
    role: 'evidence',
    why: 'appends the external-action receipt itself, at the path defaultExternalActionReceiptPath resolves',
  }),
  'lib/external-action-receipt-collector.js': Object.freeze({
    role: 'evidence',
    why: 'append-only receipt store; the tenant-scoped JSONL the fleet view reads',
  }),
  'lib/external-action-receipt-shipper.js': Object.freeze({
    role: 'evidence',
    why: 'writes the outbound batch queue and its frozen trail; append-only and under the shipper state root',
  }),
  'lib/receipt/public-trust-receipt.js': Object.freeze({
    role: 'evidence',
    why: 'writes the allowlist-projected public form of a trust receipt to a caller-named export path',
  }),
  'lib/graph-record-utils.js': Object.freeze({
    role: 'evidence',
    why: 'persists mutation receipt records beside the graph they attest to',
  }),
  'lib/mutation-journal-lock.js': Object.freeze({
    role: 'evidence',
    why: 'the durable mutation journal lock; losing it would break replay idempotency',
  }),
  'lib/fitness-history.js': Object.freeze({
    role: 'evidence',
    why: 'appends the fitness history series under the resolved state directory; append-only, never rewritten',
  }),

  // ── the product datastore ──────────────────────────────────────────────
  'lib/graph-json-snapshot.js': Object.freeze({ role: 'persistence', why: 'writes the JSON graph snapshot to the configured memoryPath; the non-SQLite backend for the canonical graph' }),
  'lib/graph-json-transaction.js': Object.freeze({ role: 'persistence', why: 'the JSON graph write transaction: writes a temp file beside memoryPath and renames it, so a crash cannot leave a half-written graph' }),
  'lib/memory-store-json-persistence.js': Object.freeze({ role: 'persistence', why: 'the JSON memory store backend, writing to the configured memoryStorePath rather than any agent-supplied path' }),
  'lib/default-persistence-path.js': Object.freeze({ role: 'persistence', why: 'creates the resolved state directory before first write; mkdir only, at a path derived from configuration' }),
  'persistencePaths.js': Object.freeze({ role: 'persistence', why: 'resolves and creates the product state directories on startup; the paths come from config and platform defaults, never from a request' }),
  'lib/a2a/replay-store.js': Object.freeze({ role: 'persistence', why: 'the A2A replay reservation store; its durability is what makes at-most-once delivery hold across a restart' }),
  'lib/a2a/task-store.js': Object.freeze({ role: 'persistence', why: 'the A2A task store backing at-most-once delivery, under the configured replay directory' }),
  'lib/a2a/delegation-audit-log.js': Object.freeze({ role: 'persistence', why: 'the A2A delegation audit trail, under the same configured replay directory; one exclusive-create file per exchange, and every write failure is swallowed so recording can never refuse a delegation' }),
  'lib/registry/registry-record-store.js': Object.freeze({ role: 'persistence', why: 'the trust registry record store, under the resolved registry directory' }),
  'lib/github-app-beta-store.js': Object.freeze({ role: 'persistence', why: 'the GitHub App beta store, at HUQAN_GITHUB_APP_STORE_PATH; written only on the deployment-gated beta path' }),
  'lib/github-app-streaming-trust-store.js': Object.freeze({ role: 'persistence', why: 'the streaming trust store, at a configured path and only when the streaming-trust flag is enabled' }),
  'lib/hypothesis-thresholds.js': Object.freeze({ role: 'persistence', why: 'persists learned hypothesis thresholds under the state directory; product-owned data, no external input in the path' }),
  'lib/huqan-package-format.js': Object.freeze({ role: 'persistence', why: 'writes an exported package to the caller-named output path' }),
  'agent.js': Object.freeze({ role: 'persistence', why: 'writes agent checkpoints and run state so a run can resume; the path is the kernel persistence descriptor, not a request field' }),

  // ── operator tools ─────────────────────────────────────────────────────
  'backupRestore.js': Object.freeze({
    role: 'operator_tool',
    why: 'backup and restore, invoked from the CLI by a human; spawns are the SQLite backup path',
  }),
  'lib/quickstart-cli.js': Object.freeze({ role: 'operator_tool', why: 'the quickstart writes a demo workspace on explicit invocation' }),
  'lib/self-healer/source-dogfood-simulator.js': Object.freeze({
    role: 'operator_tool',
    why: 'writes a simulated source tree for the dogfood run; never reached by an agent request',
  }),
  'plugins/metric-collector.js': Object.freeze({ role: 'operator_tool', why: 'plugin writing its own metric output file; loaded only when an operator enables the plugin directory' }),
  'plugins/receipt-exporter.js': Object.freeze({ role: 'operator_tool', why: 'plugin exporting receipts to an operator-named path; runs on explicit invocation, not on an agent request' }),

  // ── read-only adapters ─────────────────────────────────────────────────
  'adapters/git-log-adapter.js': Object.freeze({
    role: 'adapter_read',
    why: 'execFileSync of git log to ingest history; argv is fixed and the repository path is the configured workspace',
  }),
  'adapters/github-adapter.js': Object.freeze({
    role: 'adapter_read',
    why: 'fetches public GitHub data for ingestion; performs no write against the API',
  }),

  // ── outside the boundary, listed ───────────────────────────────────────
  'rustGraph.js': Object.freeze({
    role: 'unguarded',
    why: 'spawns the Rust accelerator at the fixed RUST_BIN path with no arguments. Not agent-controllable, but it is a process launch that no admission decision covers, and RUST_BIN is env-configurable (HUQAN_RUST_BIN)',
  }),
  'lib/runtime-watchdog.js': Object.freeze({
    role: 'unguarded',
    why: 'fetches its own health URL on a heartbeat. The default target is the local server and the check is injectable, but the request itself passes no gate',
  }),
  'lib/pr-guardian/github-client.js': Object.freeze({
    role: 'unguarded',
    why: 'outbound GitHub API calls on the PR Guardian path; deployment-gated by config rather than by an admission decision',
  }),
});

module.exports = { ROLES, CLASSIFIED };
