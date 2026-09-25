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
const { isPlainObject } = require('./is-plain-object');
const { collectSourceFiles, walkRequires } = require('./module-reachability-walk');

/**
 * Entry points the product itself runs.
 *
 * index.js is here because it is package.json's `main` (#329): it is what an
 * external consumer executes on `require('huqan')`, so it is a real entry
 * point even though no in-repo file requires it. kernel.js is kept listed for
 * the same reason -- it was `main` before the root export moved.
 *
 * bin/huqan-mcp.js is here on the same footing: package.json declares it as a
 * `bin`, so an installed consumer executes it directly. Nothing in this
 * repository requires it, and that is correct -- it is the outermost edge of
 * the MCP entry, not a module.
 */
const PRODUCTION_ENTRY_POINTS = Object.freeze([
  'cli.js',
  'server.js',
  'mcpServer.js',
  'bin/huqan-mcp.js',
  'bin/huqan-gate-hook.js',
  'index.js',
  'kernel.js',
  'github-app-server.js',
]);

/**
 * Directories whose files are loaded dynamically at runtime and so are
 * unreachable in a static graph while still genuinely running. plugin.js
 * enumerates this directory with readdirSync.
 */
const DYNAMIC_ENTRY_DIRS = Object.freeze(['plugins', 'adapters/external-action']);

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
  'scripts/huqan-watchdog.js', // npm run server:guarded; outer production supervisor
  'scripts/knowledge-graph-demo.js', // npm run train
  'egitim.js', // #363: deprecation shim â†’ scripts/knowledge-graph-demo.js (ships nothing, refuses to run)
  // #1792: spawned by lib/external-action-gate-install-validate.js to load an installed
  // gate artifact from the deployment's own resolution root. Requiring it would
  // defeat its purpose -- the point is that it runs outside this process.
  'lib/external-action-gate-sentinel.js',
]);

/** Repository examples are source-checkout artifacts, not product entry points. */
const NON_RUNTIME_PREFIXES = Object.freeze(['examples/']);

/**
 * Assets the browser executes, which Node never requires.
 *
 * `public/` is shipped to the client by the static-asset table in
 * lib/http/static-assets.js, so these files are reached over HTTP rather than
 * through the require graph -- being absent from it is correct, not pending
 * work. Their real "is this wired up" question is whether the page that links
 * them can actually fetch them, and test/dashboard-static-assets.test.js
 * answers that one over real HTTP.
 */
const BROWSER_ASSET_PREFIXES = Object.freeze(['public/']);

/** Package entry points executed by external consumers rather than this app. */
const CONSUMER_ENTRY_POINTS = Object.freeze([
  'packages/huqan-verify/index.js',
  // The AXIOM-era module name, re-exporting lib/huqan-package-format.js. It
  // ships so an external consumer that already requires it keeps working, and
  // nothing in this repository requires it -- which is the point, not an
  // oversight. Being unreached here is what proves the canonical name is the
  // one this codebase actually uses.
  'lib/axiom-package-format.js',
]);

/** Source modules that exist only to support tests, not a future product path. */
const TEST_ONLY_FILES = Object.freeze([
  'lib/self-test-oracle.js',
  // lib/deterministic-task-runner.js used to sit here, reachable only from
  // benchmark fixtures. The `coder` command now reaches it through
  // lib/cli-coder.js -> lib/coder/apply-derivation.js, so it is on a product
  // path and belongs in the ordinary reachability graph.
]);

/** Structural exports whose individual modules are the runtime entry surface. */
const STRUCTURAL_FILES = Object.freeze([
  'lib/causal/index.js',
  // Source-checkout compatibility aliases. Production and the installed
  // package use the canonical publishable implementations in lib/receipt.
  'lib/v5/cryptographic-profile-contract.js',
  'lib/v5/cryptographic-verification-adapter.js',
  'lib/v5/public-trust-receipt.js',
  'lib/v5/trusted-key-resolver.js',
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
  // --- V5 ------------------------------------------------------------------
  // ADR-010's V5_IMPLEMENTATION_ENTRY: FAIL used to be the reason nothing could
  // call these. That decision was superseded by
  // docs/v5/v5-implementation-entry-successor-audit.md.
  //
  // Six modules have since left this list the only way a module may: P0-B and
  // the V5 preflight caller gave two more a production caller. POST
  // /api/a2a/exchange reaches
  // lib/a2a/exchange-route.js, which reaches lib/a2a/bounded-exchange.js, which
  // requires the cryptographic profile contract, the verification adapter, the
  // public trust receipt importer and the trusted-key resolver.
  //
  // What remains is genuinely unreached. The list tracks that, not what is
  // forbidden, so deleting a line below would fail the check as a stale
  // acknowledgement rather than graduate anything.
  'schemas/v5/agent-identity-conformance.js': 'V5 schema implementation; entry authorized, no production caller yet',
  'schemas/v5/agent-identity-coverage.js': 'V5 schema implementation; entry authorized, no production caller yet',
  'schemas/v5/agent-identity-readiness.js': 'V5 schema implementation; entry authorized, no production caller yet',
  'schemas/v5/agent-identity-validator.js': 'V5 schema implementation; entry authorized, no production caller yet',

  // --- self-healer ---------------------------------------------------------
  // Library plus tests by design; the repo's "no autonomous Self-Healer"
  // non-goal means nothing here runs unattended. See #224.
  // The dogfood plugin reaches classifier/audit/dryrun/finding/safety plus the
  // bounded source simulation path. index.js remains a library barrel rather
  // than a production entry and stays outside the reachability ledger below.
  'lib/self-healer/index.js': 'self-healer is library-only by product decision; no autonomous runner',

  // self-evolve graduated: the product decision this list was waiting on was
  // taken, and huqan.self-evolve now dispatches through
  // lib/mcp/self-evolve-tool.js -> lib/self-evolve-adapter.js. The adapter
  // reaches lib/self-evolve-probe.js on the same path, so the probe stopped
  // being an unwired investigation tool at the same moment: it is now the
  // measurement the tool reports its verdict from. Both acknowledgements were
  // removed rather than reworded, because a reachable module listed here fails
  // the check as a stale acknowledgement.

  // AB6 graduated: sandboxRunner.js evaluates lib/sandbox-isolation.js before it
  // spawns anything, so the gate now has a production caller and needs no
  // acknowledgement here. It was never wired to the MCP surface, because sandbox
  // isolation is a property of how a runner is launched rather than of a tool
  // invocation (#1253) -- the entry point it belongs at is where the sandbox is
  // created, which is where it now sits.

  // --- issuer seal ----------------------------------------------------------
  // The primitive ships before its wiring on purpose. Sealing changes the
  // stored receipt shape wherever it is switched on, and it needs an issuing
  // key from deployment configuration; both deserve their own review rather
  // than riding along with the crypto. Graduating this line means giving the
  // seal a production caller -- deleting it without one fails the check as a
  // stale acknowledgement, which is exactly the intended pressure.
  'lib/receipt/issuer-seal.js': 'receipt issuer seal primitive; emission path and key configuration land separately',
  'lib/issuer-seal-config.js': 'issuer seal key configuration; reached once graph.js calls the sealed write path',
  // The write delegate is finished and tested ahead of its call site on
  // purpose. graph.js sits exactly at its line-size debt ceiling, and that
  // ledger may only shrink, so swapping its two receipt-write blocks over to
  // this module means first extracting enough from graph.js to pay for the
  // call. Raising the ceiling instead is a debt decision, and a feature that
  // is off by default is not the change that should be making it.
  'lib/graph-mutation-receipt-write.js': 'sealed mutation receipt write delegate; graph.js call sites swap over in the extraction that pays for them', 'lib/http/crash-recovery-inventory.js': 'Gate A item 7 inventory; static table, no runtime caller', 'lib/http/request-limits.js': 'Gate A limiter shim; canonical is server-timeouts.js', 'lib/experience/contract.js': 'E1 ExperienceContract primitive, pure by product decision; first production consumer is the E2 journal that requires it', 'lib/experience/compiler.js': 'Phase 6 procedure compiler for the replace_text pilot; production caller lands with the registry intake', 'lib/experience/journal.js': 'E2 ExperienceJournal append/read surface; production caller lands with the crash-reconciliation and HTTP/CLI/MCP read-surface deliveries', 'lib/experience/learning.js': 'Phase 4 learning admission pool; production caller lands with the procedure-candidate intake', 'lib/experience/reconciliation.js': 'E5 operation ledger for crash recovery; production caller lands with the runtime seam wiring that performs effects', 'lib/experience/verifier.js': 'E3 ExperienceVerifier assessment surface; production caller lands with the verified-assessment intake that appends verification events', 'lib/experience/read-model.js': 'E6 shared Experience read projection; surface callers land with the runtime seam wiring that supplies a production journal', 'lib/experience/repair.js': 'Phase 5 repair planner; production caller lands with the runtime seam wiring that executes plans', 'lib/experience/capability-trust.js': 'Capability Trust ladder; production caller lands with the Procedure Registry intake that supplies real evidenceWindow events', 'lib/experience/router.js': 'Deterministic Router; production caller lands with the runtime seam that dispatches a request through capability trust into an executor', 'lib/experience/personal-execution-model.js': 'Personal Execution Model composing policy, preference, environment and capability trust versions; production caller lands with whatever surface (CLI/MCP/HTTP) eventually calls evaluatePersonalExecutionModel() for a real request', 'lib/cli-experience-read.js': 'E6 CLI renderer for the shared projection; command registration lands with the runtime seams', 'lib/mcp/experience-read-tool.js': 'E6 MCP adapter for the shared projection; catalog and dispatch entries land with the runtime seams', 'lib/http/experience-read-route.js': 'E6 HTTP adapter for the shared projection; server mounting lands with the runtime seams', 'lib/experience/optimization-hypothesis.js': 'bounded hypothesis detectors over Experience history; production caller lands with whatever runtime seam evaluates hypotheses on a schedule or trigger, which is explicitly out of scope for the pure detectors themselves', 'lib/experience/canary.js': 'canary trial state machine sitting between candidate compilation and promotion evaluation; production caller lands with the runtime seam that dispatches live requests through a router and can therefore sample them into a trial', 'lib/experience/capability-trust-canary-extension.js': 'canary-specific Capability Trust ladder functions, split out of capability-trust.js purely to stay under the file-size ratchet; reachable only once capability-trust.js itself gains the Procedure Registry intake caller it is still waiting on', 'lib/experience/permitted-fallback.js': 'Permitted Fallback permission and provenance-labelling primitive; production caller lands with the runtime seam that checks it after a router or PEM refusal, before any model call', 'lib/experience/permitted-fallback-trust.js': 'Permitted Fallback anti-erosion counter and paranoid-mode promotion gate; production caller lands with the runtime seam that records fallback usage against Capability Trust', 'lib/experience/capability-trust-fallback-extension.js': 'fallback-specific Capability Trust ladder function, split out of capability-trust.js purely to stay under the file-size ratchet; reachable only once permitted-fallback-trust.js itself gains a production caller', 'lib/experience/procedure-registry.js': 'Phase 6 immutable Procedure Registry storing compile() output; production caller lands with the capability-trust intake that resolves boundProcedureVersion against it instead of treating it as an opaque string', 'lib/experience/write-cost-budget.js': 'E0-c write-cost budget for the fail-closed journal; the number and its check ship before the runtime seam wiring that measures the live write against them', 'lib/delegation-service.js': 'DelegationService v0 validation boundary; production caller and execution routing land with the plan-compiler and policy-attachment slices', 'lib/agent-capability-report.js': 'K capability report builder; production publisher lands with the trust-protocol publish slice', 'lib/delegation-rate-counter.js': 'E spawn rate counter; production spawn gate lands with the runtime-wiring slice',  'lib/financial-aggregation.js': 'D payment aggregation ledger; production financial gate lands with the runtime-wiring slice','lib/impact-budget-ledger.js': 'A/I budget reservation ledger; production gate wiring lands with the runtime-wiring slice', 'lib/provenance-ingest-adapter.js': 'kernel.learn orchestration over built provenance; production learn sites pass provenance opts to kernel.learn directly, so a production caller lands when a surface adopts the adapter instead of duplicating the call', 'lib/external-action-action-binding.js': 'workspace-scoped action binding for a review approval; ships before its caller so the digest is falsifiable before anything is written against it, and the guard review path that binds through it lands separately', 'lib/conflict-candidate-review.js': 'reviewConflictCandidate() human-verdict API for conflict candidates, mirroring hypothesis-review.js; production caller lands with a CLI command symmetric to cli-hypotheses.js\'s review subflag, out of scope for the triage-resolution path itself',
});



function isStandalone(relPath) {
  return STANDALONE_FILES.includes(relPath)
    || STANDALONE_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isDynamicEntry(relPath) {
  return DYNAMIC_ENTRY_DIRS.some((dir) => relPath.startsWith(`${dir}/`));
}

function isNonRuntimeArtifact(relPath) {
  return NON_RUNTIME_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isBrowserAsset(relPath) {
  return BROWSER_ASSET_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root] repository root
 * @returns {{reachable: string[], unreachable: string[], unacknowledged: string[], staleAcknowledgements: string[]}}
 */
function analyzeReachability(opts = {}) {
  const root = isPlainObject(opts) && opts.root ? opts.root : path.join(__dirname, '..');
  const seen = new Set();

  const entries = [...PRODUCTION_ENTRY_POINTS, ...STANDALONE_FILES, ...CONSUMER_ENTRY_POINTS];
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
    && !isNonRuntimeArtifact(rel)
    && !isBrowserAsset(rel)
    && !TEST_ONLY_FILES.includes(rel)

    && !STRUCTURAL_FILES.includes(rel)
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
  NON_RUNTIME_PREFIXES,
  BROWSER_ASSET_PREFIXES,
  CONSUMER_ENTRY_POINTS,
  TEST_ONLY_FILES,
  STRUCTURAL_FILES,
  NOT_YET_WIRED,
  analyzeReachability,
};
