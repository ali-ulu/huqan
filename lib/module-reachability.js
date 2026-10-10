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
  'bin/huqan-cognitive-lab.js',
  'bin/huqan-causal-lab.js',
  'bin/huqan-neural-lab.js',
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
  // R12: manually invoked fixture-generation module; its output is frozen
  // before measurement. Runtime consumes the frozen JSON, never this generator.
  'fixtures/cognitive-lab/causal-confirmatory-generator.js',
  // publish.yml runs this mandatory gate immediately before publication.
  'scripts/check-release-evaluation.js',
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
  ...require('../config/semantic-wiring-ledger.json'),
  // --- code anchors (#3199) -------------------------------------------------
  // The primitive ships before its consumers on purpose, and the issue names
  // both: the contract object (a versioned behaviour invariant that has to
  // outlive the implementation) and the migration of the line-pinned
  // source-contract tests off raw line numbers. Neither exists yet, and neither
  // is this module's to invent -- wiring it to a caller that does not exist
  // would be the same "implemented and unit-tested, nothing calls it" state
  // this ledger exists to make visible, only harder to see.
  'lib/code-anchor.js': 'content-anchored code location primitive; its two named consumers (the contract object and the source-contract test migration) land separately',

  // --- memory lifecycle (#3036) --------------------------------------------
  // The six memory modules this composes each already have their own
  // production caller, so they are not listed here. This caller itself now has
  // one too: the CLI `memory-lifecycle` command drives its receipt-bound
  // tombstone/supersede through the kernel's own store, with cli.js (the UI
  // entrypoint) supplying the receipt collaborators the Adapters ring may not
  // require, so the module graduated (#3461).

  // --- cognitive lab evaluator is now wired -------------------------------
  // The isolated calibration CLI reaches the manifest and paired/budget ports,
  // executes the B1 engine replay through its opt-in replay sub-path, and now
  // feeds that replay through the fail-closed gain evaluator (#3376, slice
  // 3307-S3), so the evaluator's caller is the CLI rather than only its test.

  // --- language baseline (#3312, L1) ---------------------------------------
  // The Common Semantic IR composes the four existing parser surfaces
  // (command-parser, predicate-parser, claim-decomposition, entity-resolution)
  // into one versioned, read-only record. Phase 3 of the language track ships
  // the contract first on purpose; the issue keeps the intent/grounding/
  // semantic-reasoning phases and any parser rewrite out of this slice, so the
  // module's only caller today is its contract test. It graduates when a later
  // language phase reads the IR from a surface rather than a fixture.

  // --- action semantics (#3476, L2) ----------------------------------------
  // The candidate Action IR composes the L1 record and the shipped external-
  // action decision (external-action-envelope + external-action-guard) into one
  // versioned, read-only plan record, keeping verification/policy/execution
  // separate and authorizing nothing without a verified condition and an allow
  // policy decision. Phase 7 of the language track ships the contract first on
  // purpose; the issue keeps grounding, new language adapters and any execution
  // surface out of this slice, so the module's only caller today is its
  // contract test. It graduates when an execution surface reads the IR.

  'lib/memory-grounded-transfer.js': 'candidate-only grounded transfer check over K1 reference frames; pure contract, unit-tested, awaiting the sensor/JEPA surfaces that adopt it',
  'lib/cognitive-lab-b1-manifest.js': 'B1 candidate-measurement manifest builder for the R19 slice; pure contract, unit-tested, awaiting a caller surface that adopts it',

  // --- reflective promotion (#3469, I5) --------------------------------------
  // Graduated by #3550: the `terfi` operator command (lib/cli-promote.js)
  // drives candidates through the loop, so the loop has a production caller.

  // --- KnowledgeObject schema (#3470, K0) ------------------------------------
  // One record shape for fact/rule/procedure/policy/capability/model/
  // hypothesis, built on the memory schema's checks, with the rule that a
  // policy or capability cannot be learned. Graduated by #3568 (R49): the
  // hypothesis producer (`lib/graph-hypotheses.js`) validates a learned
  // hypothesis object through `lib/memory-hypothesis-cognition.js` before a candidate
  // is queued, so the schema has a production writer.

  // --- CognitiveMessage + reference frames (#3471, K1) ----------------------
  // The common cognitive envelope (source/target/workspace/goal/observation/
  // prediction/hypothesis/action/confidence/evidenceRefs/temporalContext/
  // budget/traceId) plus the eight-field reference frame and a field-wise
  // comparison that yields match/mismatch/unknown, never a silent merge.
  // Graduated by #3568 (R49): the hypothesis producer builds and validates a
  // message per proposed candidate, so a cognitive step now flows through it.

  // --- defeasible intake scope (#3497, R42) --------------------------------
  // The scoped defeasible projection keeps proof *production* separate from
  // learning *intake*: it reads a `proveFromRules` result and a `?SCOPE`
  // descriptor and yields a provenance-preserving record, issuing a defeater
  // only inside a scope that declared itself closed, and marking a dominated
  // record instead of deleting it. Graduated by #3497: kernel.prove returns
  // the scoped intake reading beside its proof (open-world unless the caller
  // declares the scope closed), so the projection now has a production caller.

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
  // The four agent-identity schema modules left this list for RETIRED_FILES
  // (#3315): their consumer is the check:v5-identity CI gate, not a runtime
  // caller that is still owed.

  // --- inference -----------------------------------------------------------
  // Wired to production by lib/inference-runtime.js (#3038): the runtime
  // composes the Rule IR, unification, forward/backward evaluators, derived
  // records and the admission bridge into kernel.derive/kernel.prove, so those
  // modules are no longer NOT_YET_WIRED. The remaining acknowledgements below
  // are the inference surfaces the runtime does not yet call.

  // --- self-healer ---------------------------------------------------------
  // The self-healer proposes; a human reviews before anything lands. It is
  // active and can produce a concrete fix (plugins/self-healer-audit.js
  // `propose-fix` -> lib/self-healer/fix-producer.js), but never applies one.
  // The dogfood plugin reaches classifier/audit/dryrun/finding/safety plus
  // fix-producer; index.js is a barrel, RETIRED_FILES since #3315.

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

  'lib/receipt/policy-seal.js': 'sealed K0 policy object with issuedAt-to-evidence binding and transparency requirement; pure contract, unit-tested, awaiting the signed-policy admission surface (R35 follow-up slice)',
  'lib/receipt/transparency-log-client.js': 'Rekor-style inclusion-proof client for the sealed-policy transparency reference; pure verifier, unit-tested, wires with policy-seal when the signed-policy admission surface lands',
  'lib/aura-canary-bridge.js': 'AURA<->canary bridge (rule canary trial + leak tripwire); consumed by the standalone operator loop scripts/aura-loop.js; wiring it into the core gate (egress canary plant + promotion ladder) is planned but not yet done',
  // --- issuer seal ----------------------------------------------------------
  // #3188: the primitive, the key configuration and the write delegate all
  // graduated together. graph.js reads the key once at construction and hands
  // it to the write path, so all three have a production caller and their
  // acknowledgements were removed rather than reworded.
  // Experience modules now run through coder-routing-runtime and the
  // budgeted journal; the closed journal reconstructs the live registries.
  // K incident envelope graduated (#3339): recording a post-incident review
  // builds the private, content-bound envelope and read-back verifies it, so
  // lib/post-incident-review.js is a production caller. Sending remains a
  // separate human-approved act and is still out of scope.
  // The publication gate checks the release record against the live source.
});

/**
 * Superseded-by-design modules the product deliberately keeps but will never
 * wire: a shim whose canonical implementation lives elsewhere, or an inventory
 * table kept as executable evidence rather than runtime code.
 *
 * They are still unreachable, so they do not belong in NOT_YET_WIRED -- that
 * list promises a caller is coming. A retired entry promises the opposite. The
 * distinction is the point: it keeps "wiring is owed" (a debt to pay) separate
 * from "no caller is planned" (a decision already made), so the wiring-debt
 * count measures only the former. The audit that first named these two
 * candidates is docs/audits/unreachable-classification-audit-3014.md.
 */
const RETIRED_FILES = Object.freeze({
  'lib/http/crash-recovery-inventory.js': 'Gate A durable-state inventory kept as executable evidence; its test is the consumer, no runtime caller is planned',
  'lib/http/request-limits.js': 'shim to server-timeouts.js kept to hold server.js FANOUT stable; the canonical implementation is the real module',
  // #3315 LIBRARY decisions: kept on purpose, no runtime caller planned.
  'schemas/v5/agent-identity-conformance.js': 'V5 agent-identity schema; consumed by the check:v5-identity CI gate (scripts/check-v5-identity-readiness.js), no runtime caller planned',
  'schemas/v5/agent-identity-coverage.js': 'V5 agent-identity schema; consumed by the check:v5-identity CI gate (scripts/check-v5-identity-readiness.js), no runtime caller planned',
  'schemas/v5/agent-identity-readiness.js': 'V5 agent-identity schema; consumed by the check:v5-identity CI gate (scripts/check-v5-identity-readiness.js), no runtime caller planned',
  'schemas/v5/agent-identity-validator.js': 'V5 agent-identity schema; consumed by the check:v5-identity CI gate (scripts/check-v5-identity-readiness.js), no runtime caller planned',
  'lib/self-healer/index.js': 'self-healer library barrel; submodules are reached directly through plugins/self-healer-audit.js, so a barrel caller is not owed',
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
    && !Object.prototype.hasOwnProperty.call(RETIRED_FILES, rel)
  ));

  const staleAcknowledgements = Object.keys(NOT_YET_WIRED)
    .filter((rel) => !unreachable.includes(rel))
    .sort();

  // A retired entry that is now reachable (or gone) is as misleading as a stale
  // acknowledgement: it would claim a decision that the graph no longer shows.
  const staleRetired = Object.keys(RETIRED_FILES)
    .filter((rel) => !unreachable.includes(rel))
    .sort();

  return { reachable, unreachable, unacknowledged, staleAcknowledgements, staleRetired };
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
  RETIRED_FILES,
  analyzeReachability,
};
