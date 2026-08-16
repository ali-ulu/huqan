'use strict';

/**
 * Mutation-bypass ratchet — the first P1 enforcement unit.
 *
 * Gate 2 closed with `NO_EXISTING_UNIVERSAL_HOOK`, and
 * `docs/task-packs/p1c-admission-seam-change-surface.md` measured that the
 * non-opt-in property comes from a CI-enforced guard rather than from
 * restructuring the storage API. This is that guard.
 *
 * ## What it locks
 *
 * Not "is `runMutationOnce` used?" -- that question is about durability, and
 * answering it would have let the boundary be declined by anyone who simply
 * did not call it. The question this locks is:
 *
 *     can a production mutation happen outside the admission boundary?
 *
 * The invariant being built toward:
 *
 *     every production mutation path -> mandatory admission seam -> mutation
 *
 * The seam does not exist yet. Until it does, every direct sink call is a
 * bypass, so the baseline below records all of them. That is deliberate: the
 * guard is useful before the seam exists, because from this commit onward a
 * *new* bypass cannot be added silently, and each routing step must lower a
 * number in a reviewable diff.
 *
 * ## Why a ratchet rather than a boolean
 *
 * A guard that only failed once the seam was finished would be dead code for
 * the whole build, and would arrive exactly when it was no longer needed. A
 * ratchet -- the same shape as `scripts/check-file-size.js` -- is enforceable
 * from day one and turns "we moved all the callers" from an assumption into a
 * number that has to reach zero.
 *
 * Counts must match the baseline **exactly**. Above it means a new bypass.
 * Below it means a caller was routed and the baseline was not lowered, which
 * would leave slack for a future bypass to hide in.
 *
 * ## Evasions this closes
 *
 * - **Tests and fixtures cannot launder a call.** The scan reads the
 *   git-tracked runtime source list from `scripts/check-file-size.js`, which
 *   already excludes tests, benchmarks and demos. A sink call added in a test
 *   file does not move these numbers, and cannot be used to "pre-approve" one.
 * - **The Rust backend is in scope.** `rustGraph.js` does not extend `Graph`;
 *   it wraps one and re-exposes `addNode`/`addEdge` as a second sink surface.
 *   A guard that followed only the `Graph` call chain would leave that path
 *   open and produce a boundary that is real in JS and absent in the backend.
 *   The scan is therefore *receiver-agnostic*: it matches the method name
 *   wherever it is called, so both sink providers are covered by construction.
 * - **Computed access cannot slip past.** `graph['addNode'](...)` does not
 *   match a dot-call regex, so bracket access to a sink name is checked
 *   separately and is not permitted anywhere in runtime source.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { listSourceFiles } = require('../scripts/check-file-size.js');

const repoRoot = path.join(__dirname, '..');

/**
 * The four write families' sinks, from
 * `docs/task-packs/p1b-gate2-hook-source-reality.md`.
 */
const SINK_METHODS = Object.freeze([
  'addNode',
  'addEdge',
  'addTag',
  'addCandidateClaim',
  'appendAuditEvent',
]);

/**
 * Every direct sink call in runtime source, with why it is still direct.
 *
 * This is a debt ledger, not an allowlist of approved designs. Every entry is
 * expected to reach zero as its caller is routed through the admission seam.
 * Lowering a number is progress; raising one needs a reason that survives
 * review.
 */
const DIRECT_SINK_BASELINE = Object.freeze({
  // --- production mutation paths: the ones P1 must route -------------------
  'kernel.js': { why: 'knowledge, candidate and audit families; the largest routing target', sinks: { addNode: 1, addEdge: 3, addCandidateClaim: 1, appendAuditEvent: 1 } },
  'lib/learn-use-case.js': { why: 'knowledge family, reached through kernel.learn', sinks: { addNode: 3, addEdge: 4, addTag: 1 } },
  'lib/conflict-detector.js': { why: 'writes across three families from one module', sinks: { addNode: 4, addEdge: 2, addCandidateClaim: 5, appendAuditEvent: 1 } },
  'kernel.v2.js': { why: 'candidate family on the V2 surface', sinks: { addCandidateClaim: 1 } },
  'agent.v3.js': { why: 'audit family', sinks: { appendAuditEvent: 2 } },
  'server.js': { why: 'direct audit write; the clearest single bypass in P1-B', sinks: { appendAuditEvent: 1 } },
  'lib/cli-mutation-audit.js': { why: 'audit family, CLI surface', sinks: { appendAuditEvent: 1 } },
  'lib/mcp-ingest-execute-tool.js': { why: 'audit family, MCP surface', sinks: { appendAuditEvent: 1 } },
  'lib/external-client-mutation-receipt-owner.js': { why: 'candidate family, external client surface', sinks: { addCandidateClaim: 1 } },

  // --- second sink provider ------------------------------------------------
  // Not a caller in the usual sense: it wraps a Graph and re-exposes the sinks.
  // Listed so the Rust path is visibly in scope rather than silently outside it.
  'rustGraph.js': { why: 'second sink provider; delegates to the wrapped Graph', sinks: { addNode: 1, addEdge: 1 } },

  // --- not production-reachable -------------------------------------------
  // Listed rather than skipped: if one of these acquires a production caller,
  // its writes become bypasses and this ledger should already name them.
  'lib/github-connector.js': { why: 'library-only connector; NOT_YET_WIRED', sinks: { addCandidateClaim: 1, appendAuditEvent: 1 } },
  'lib/self-healer/source-dependency-graph.js': { why: 'self-healer is library-only by product decision', sinks: { addNode: 1, addEdge: 1 } },
  'lib/self-healer/source-dogfood-simulator.js': { why: 'self-healer is library-only by product decision', sinks: { addNode: 1, addEdge: 2 } },

  // --- standalone tooling --------------------------------------------------
  'scripts/seed-demo.js': { why: 'standalone demo seeder; not a production mutation path', sinks: { addNode: 2, addEdge: 1 } },
});

function countSinks(source) {
  const counts = {};
  for (const method of SINK_METHODS) {
    const matches = source.match(new RegExp(`\\.${method}\\s*\\(`, 'g'));
    if (matches) counts[method] = matches.length;
  }
  return counts;
}

function measure() {
  const measured = {};
  for (const relPath of listSourceFiles()) {
    const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    const counts = countSinks(source);
    if (Object.keys(counts).length > 0) measured[relPath] = counts;
  }
  return measured;
}

test('mutation admission: no production file gains a new direct sink call', () => {
  const measured = measure();
  const violations = [];

  for (const [relPath, counts] of Object.entries(measured)) {
    const baseline = DIRECT_SINK_BASELINE[relPath];
    if (!baseline) {
      violations.push(`${relPath}: not in the ledger, but calls ${Object.keys(counts).join(', ')}`);
      continue;
    }
    for (const [method, count] of Object.entries(counts)) {
      const allowed = baseline.sinks[method] || 0;
      if (count > allowed) {
        violations.push(`${relPath}: ${method} ${allowed} -> ${count}`);
      }
    }
  }

  assert.deepEqual(violations, [], [
    'A production file gained a direct mutation sink call.',
    '',
    'Gate 2 requires every production mutation path to pass through a mandatory',
    'admission seam. Until that seam exists and this caller is routed through it,',
    'a new direct call widens the surface P1 has to close.',
    '',
    'If the call is genuinely unavoidable, raise the number in',
    'DIRECT_SINK_BASELINE with a reason -- that makes it a reviewable decision',
    'rather than a silent bypass.',
  ].join('\n'));
});

test('mutation admission: the ledger does not keep slack after a caller is routed', () => {
  const measured = measure();
  const stale = [];

  for (const [relPath, baseline] of Object.entries(DIRECT_SINK_BASELINE)) {
    const counts = measured[relPath] || {};
    for (const [method, allowed] of Object.entries(baseline.sinks)) {
      const actual = counts[method] || 0;
      if (actual < allowed) stale.push(`${relPath}: ${method} ${allowed} -> ${actual}, lower the baseline`);
    }
  }

  // Slack is where a future bypass hides: a routed caller that leaves its old
  // number behind silently re-permits the call it just removed.
  assert.deepEqual(stale, [], [
    'A direct sink call was removed but the ledger still permits it.',
    'Lower the number in DIRECT_SINK_BASELINE so the progress is recorded and',
    'the slack cannot be reused.',
  ].join('\n'));
});

test('mutation admission: computed sink access is not permitted anywhere', () => {
  // graph['addNode'](...) does not match a dot-call regex. Without this, the
  // ratchet could be walked past with a string.
  const offenders = [];
  for (const relPath of listSourceFiles()) {
    const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    for (const method of SINK_METHODS) {
      if (new RegExp(`\\[\\s*['"\`]${method}['"\`]\\s*\\]`).test(source)) {
        offenders.push(`${relPath}: computed access to ${method}`);
      }
    }
  }

  assert.deepEqual(offenders, [], 'computed access to a mutation sink evades the ratchet');
});

test('mutation admission: the Rust backend is inside the boundary, not beside it', () => {
  // rustGraph.js wraps a Graph and re-exposes addNode/addEdge, so it is a second
  // sink provider. A guard that followed only the Graph call chain would leave
  // that path open and produce a boundary that is real in JS and absent in the
  // backend. This asserts the scan actually covers it.
  assert.ok(
    Object.hasOwn(DIRECT_SINK_BASELINE, 'rustGraph.js'),
    'the Rust sink provider must be tracked by the ratchet',
  );

  const measured = measure();
  assert.ok(measured['rustGraph.js'], 'the scan must reach rustGraph.js');
});

test('mutation admission: tests and fixtures cannot move these numbers', () => {
  // The scan reads the runtime source list, which excludes tests, benchmarks
  // and demos. A sink call in a test file must not be able to pre-approve a
  // production one.
  const scanned = listSourceFiles();
  const leaked = scanned.filter((relPath) => /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/)/.test(relPath));

  assert.deepEqual(leaked, [], 'the ratchet must not read test sources');
  assert.ok(scanned.includes('kernel.js'), 'the ratchet must read production sources');
});
