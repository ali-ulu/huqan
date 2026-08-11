'use strict';

/**
 * Module reachability from the production entry points.
 *
 * A large part of this repository ships and is tested but is never executed by
 * the product: nothing in cli.js, server.js or mcpServer.js reaches it. Green
 * tests plus a `docs/` page describing a feature can then read as "this works",
 * when what is actually true is "this is implemented and unit-tested, and
 * nothing calls it". ADR-008 invariant 7 makes the same point for gates: a gate
 * existing in a library is not evidence that a production caller is enforced by
 * it.
 *
 * This module makes that distinction mechanical. It walks the static require
 * graph from the declared entry points and reports what it never reaches. Every
 * unreached file must then be classified, either as a legitimate non-required
 * artifact or as an explicitly acknowledged not-yet-wired module with a reason.
 * Anything unreached and unclassified fails the accompanying test, so a new
 * subsystem cannot quietly join the pile.
 *
 * Scope note: this is a *static* analysis of literal `require('./x')` calls. It
 * cannot see dynamic loads, which is why plugins are declared as entry points
 * below rather than being detected -- plugin.js loads them with readdirSync.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Entry points the product itself runs. */
const PRODUCTION_ENTRY_POINTS = Object.freeze([
  'cli.js',
  'server.js',
  'mcpServer.js',
  'kernel.js',
]);

/**
 * Directories whose files are loaded dynamically at runtime and so are
 * unreachable in a static graph while still genuinely running. plugin.js
 * enumerates this directory with readdirSync.
 */
const DYNAMIC_ENTRY_DIRS = Object.freeze(['plugins']);

/**
 * Files that are their own entry point -- run directly, never required. Being
 * unreachable from cli/server/mcp is correct for these, not a finding.
 */
const STANDALONE_PREFIXES = Object.freeze([
  'benchmarks/',
  'scripts/',
  'obsidian-plugin/',
  'packages/',
]);

const STANDALONE_FILES = Object.freeze([
  'demo-causal-autolearn.js',
  'scripts/egitim-demo.js', // npm run train
  'egitim.js', // #363: deprecation shim → scripts/egitim-demo.js (ships nothing, refuses to run)
]);

/**
 * Modules that are shipped and tested but not reached by any production entry
 * point. Each entry states why, so this list reads as a set of decisions rather
 * than as neglect.
 *
 * Removing an entry from this list is how a subsystem graduates: wire it up,
 * and the test stops requiring the acknowledgement.
 */
const NOT_YET_WIRED = Object.freeze({
  // --- external-client trust boundary -------------------------------------
  // ADR-010 selected the production boundary but deliberately did not wire it;
  // enabling the route is a separately authorized step (ADR-008 required
  // sequence, EXTERNAL-CLIENT-ENABLEMENT-0).
  'lib/external-client-authority.js': 'external-client boundary; awaiting EXTERNAL-CLIENT-ENABLEMENT-0 (ADR-010)',
  'lib/external-client-package-gate.js': 'external-client boundary; awaiting EXTERNAL-CLIENT-ENABLEMENT-0 (ADR-010)',
  'lib/external-client-endpoint-contract.js': 'external-client boundary; the route is intentionally unregistered',
  'lib/external-client-http-adapter.js': 'external-client boundary; transport for the unregistered route',
  'lib/external-client-mutation-receipt-owner.js': 'external-client boundary; mutation/receipt owner for the unregistered route',
  'lib/external-client-replay-store.js': 'external-client boundary; replay reservation for the unregistered route',
  'lib/external-client-trust-config.js': 'external-client boundary; static trust profile materializer',
  'lib/sdk.js': 'library client surface; no production caller, see docs/audits/production-connector-client-call-chain-inventory.md',

  // --- reviewed external ingest -------------------------------------------
  'lib/reviewed-external-admission.js': 'reviewed external ingest chain; no production caller',
  'lib/reviewed-external-admission-reservation.js': 'reviewed external ingest chain; no production caller',
  'lib/reviewed-external-execution.js': 'reviewed external ingest chain; no production caller',
  'lib/reviewed-external-graph-contract.js': 'reviewed external ingest chain; no production caller',
  'lib/reviewed-external-graph-execution.js': 'reviewed external ingest chain; no production caller',
  'lib/reviewed-external-ingest-batch.js': 'reviewed external ingest chain; no production caller',
  'lib/reviewed-external-ingest-candidates.js': 'reviewed external ingest chain; no production caller',
  'lib/external-ingest-approval.js': 'external ingest approval path; no production caller',
  'lib/external-ingest-queue.js': 'external ingest queue; no production caller',
  'lib/external-source-resolver.js': 'external source resolution; no production caller',

  // --- V5 ------------------------------------------------------------------
  // V5 has not passed its entry audit (V5-C1); none of this is claimable.
  'lib/v5/cryptographic-profile-contract.js': 'V5 track; V5 entry audit (#273) has not passed',
  'lib/v5/cryptographic-verification-adapter.js': 'V5 track; V5 entry audit (#273) has not passed',
  'lib/v5/runtime-reader.js': 'V5 track; V5 entry audit (#273) has not passed',
  'lib/v5/runtime-writer.js': 'V5 track; V5 entry audit (#273) has not passed',
  'lib/v5/structural-signing-helper.js': 'V5 track; V5 entry audit (#273) has not passed',
  'lib/v5/trusted-key-resolver.js': 'V5 track; V5 entry audit (#273) has not passed',
  'lib/v5/verification-core.js': 'V5 track; V5 entry audit (#273) has not passed',
  'schemas/v5/agent-identity-conformance.js': 'V5 schema track; not wired',
  'schemas/v5/agent-identity-coverage.js': 'V5 schema track; not wired',
  'schemas/v5/agent-identity-readiness.js': 'V5 schema track; not wired',
  'schemas/v5/agent-identity-validator.js': 'V5 schema track; not wired',
  'schemas/v5/shared-trust-package-validator.js': 'V5 schema track; not wired',

  // --- self-healer ---------------------------------------------------------
  // Library plus tests by design; the repo's "no autonomous Self-Healer"
  // non-goal means nothing here runs unattended. See #224.
  // The dogfood plugin reaches dryrun/finding/safety plus the bounded source
  // simulation path. audit-runner.js and finding-classifier.js remain separate
  // library surfaces and are still genuinely unreached.
  'lib/self-healer/index.js': 'self-healer is library-only by design (#224); no autonomous runner',
  'lib/self-healer/audit-runner.js': 'self-healer is library-only by design (#224)',
  'lib/self-healer/finding-classifier.js': 'self-healer is library-only by design (#224)',

  // --- other ---------------------------------------------------------------
  'lib/approval-queue.js': 'not reached from an entry point; approval flow uses lib/approval-flow.js',
  'lib/atp-conformance.js': 'conformance helper; used by tests only',
  'lib/axiom-package-format.js': 'package format validator; reached only via the unwired external-client gate',
  'lib/deterministic-json-copy.js': 'shared package/external-client helper; reached only through unwired library surfaces',
  'lib/huqan-package-format.js': 'canonical package format surface; reached only via package consumers and the unwired external-client gate',
  'lib/causal/index.js': 'causal barrel export; entry points require the individual modules',
  'lib/github-connector.js': 'library-only connector; classified as such in docs/audits/connector-trust-coverage-inventory.md',
  'lib/self-test-oracle.js': 'self-test helper; used by tests only',
  'lib/tool-approval-idempotency.js': 'no production caller',
  'causalSimulator.js': 'simulation helper; no production caller',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function collectSourceFiles(root, dir = root, acc = []) {
  const skip = new Set(['node_modules', '.git', 'docs', 'test', 'coverage']);
  for (const name of fs.readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) collectSourceFiles(root, full, acc);
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
}

function walkRequires(file, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return;
  }
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const resolved = resolveRequire(file, match[1]);
    if (resolved) walkRequires(resolved, seen);
  }
}

function isStandalone(relPath) {
  return STANDALONE_FILES.includes(relPath)
    || STANDALONE_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isDynamicEntry(relPath) {
  return DYNAMIC_ENTRY_DIRS.some((dir) => relPath.startsWith(`${dir}/`));
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root] repository root
 * @returns {{reachable: string[], unreachable: string[], unacknowledged: string[], staleAcknowledgements: string[]}}
 */
function analyzeReachability(opts = {}) {
  const root = isPlainObject(opts) && opts.root ? opts.root : path.join(__dirname, '..');
  const seen = new Set();

  const entries = [...PRODUCTION_ENTRY_POINTS];
  for (const dir of DYNAMIC_ENTRY_DIRS) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.js')) entries.push(`${dir}/${name}`);
    }
  }

  for (const entry of entries) {
    const full = path.join(root, entry);
    if (fs.existsSync(full)) walkRequires(full, seen);
  }

  const all = collectSourceFiles(root).map((file) => path.relative(root, file).split(path.sep).join('/'));
  const reachable = all.filter((rel) => seen.has(path.join(root, rel))).sort();
  const unreachable = all.filter((rel) => !seen.has(path.join(root, rel))).sort();

  const unacknowledged = unreachable.filter((rel) => (
    !isStandalone(rel)
    && !isDynamicEntry(rel)
    && !Object.prototype.hasOwnProperty.call(NOT_YET_WIRED, rel)
  ));

  const staleAcknowledgements = Object.keys(NOT_YET_WIRED)
    .filter((rel) => !unreachable.includes(rel))
    .sort();

  return { reachable, unreachable, unacknowledged, staleAcknowledgements };
}

module.exports = {
  PRODUCTION_ENTRY_POINTS,
  DYNAMIC_ENTRY_DIRS,
  STANDALONE_PREFIXES,
  STANDALONE_FILES,
  NOT_YET_WIRED,
  analyzeReachability,
};
