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
const UNROUTED_SINK_CALLS = Object.freeze({
  // --- production mutation paths: the ones P1 must route -------------------
  'kernel.js': { why: 'knowledge and audit families; its candidate write now lives in lib/kernel-mutation-admission.js', sinks: { addNode: 1, addEdge: 3, appendAuditEvent: 1 } },
  'agent.v3.js': { why: 'audit family', sinks: { appendAuditEvent: 2 } },
  'lib/cli-mutation-audit.js': { why: 'audit family, CLI surface', sinks: { appendAuditEvent: 1 } },

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

  // --- V5 unit-of-work audit boundary (Gate 2 closeout) --------------------
  // Gate 2 closed with NO_EXISTING_UNIVERSAL_HOOK; the V5 package import
  // route is the first caller surface, and the atomicity contract (docs/v5/
  // v5-package-atomicity-contract.md) places this unit-of-work audit append
  // behind a commit check (200 only when the event is durably appended).
  // Unrouted here deliberately: the append is the unit-of-work event, not a
  // routed mutation — the family-independent admission seam remains P1's
  // job, and the commit check is that seam's atomicity precondition, not a
  // substitute for it.
  'lib/http/v5-package-import-route.js': { why: 'V5 unit-of-work audit append behind the atomicity commit check; the admission seam (P1) is not this caller\'s; counted twice: the V5_CHAIN lazy wrapper and the commit-guard call', sinks: { appendAuditEvent: 2 } },
});

/**
 * Sink calls verified by source-level review to run inside an admission
 * callback.
 *
 * This is a **reviewed routing declaration, not a machine proof.** The scan
 * cannot see that a call sits lexically inside `admit(...)`, so an entry here
 * asserts that a human checked it. The guard's real guarantee stays attached to
 * `UNROUTED_SINK_CALLS` reaching zero, not to this list being honest.
 *
 * The weakness is worth naming: a second, unrouted write added to a module
 * listed here would not be caught as a bypass -- though its count would change,
 * which is why counts are pinned here too. Machine verification (parsing for
 * the enclosing `admit` call) becomes worth its parser dependency only once one
 * of these appears: a genuine missed call inside a routed module, a callback
 * shape that makes file scanning ambiguous, or drift between this declaration
 * and source.
 */
const ROUTED_SINK_CALLS = Object.freeze({
  'lib/workbench/ingest-approval-audit-writer.js': {
    why: 'P1 first routed caller; the sole write runs inside admission.admit()',
    sinks: { appendAuditEvent: 1 },
  },
  // Lexical, like the entry above: the sink call is written inside the admit()
  // callback in admitAddCandidateClaim, having moved here out of kernel.js.
  'lib/kernel-mutation-admission.js': {
    why: 'candidate family; kernel.addCandidateClaim writes from inside admission.admit()',
    sinks: { addCandidateClaim: 1 },
  },
  // Not a sink call at all: kernel.v2.js delegates to kernel.addCandidateClaim,
  // and the receiver-agnostic scan counts it because it matches the method name.
  // Listed here rather than left unrouted because the method it delegates to is
  // now admitted, so no V2 caller can reach the graph without passing the seam.
  'kernel.v2.js': {
    why: 'candidate family on the V2 surface; delegates to the admitted kernel.addCandidateClaim',
    sinks: { addCandidateClaim: 1 },
  },
  // Lexical. The durable commit -- runMutationOnce and the sink inside it -- is
  // the admitted effect, so a refusal leaves no journal entry, row or receipt.
  // This is the only routed caller whose identity is receiver-verified before
  // the seam is reached; it still declares absence, because what is missing is
  // a claim *shape* (gate 3), not an identity. Its ABSENCE_REASONS say so.
  'lib/external-client-mutation-receipt-owner.js': {
    why: 'candidate family, external client ingress; the durable commit runs inside admission.admit()',
    sinks: { addCandidateClaim: 1 },
  },
  // A *transitive* routing claim, and weaker than the lexical one above: these
  // sinks are not inside an admit() callback, they are downstream of one. It
  // rests on two facts that test/kernel-mutation-admission.test.js asserts rather
  // than assumes -- the module exports only runLearnUseCase, and kernel.js is
  // its only caller -- so there is no second way in. If either changes, that
  // test fails before this declaration becomes wrong.
  'lib/learn-use-case.js': {
    why: 'knowledge family; reachable only via kernel.learn, which admits before the critical section',
    sinks: { addNode: 3, addEdge: 4, addTag: 1 },
  },
  // Transitive like learn-use-case, but with a caveat the entry above does not
  // have, and it is recorded rather than smoothed over: routeCandidateClaim has
  // a *second* caller, lib/github-connector.js, which does not admit. That
  // caller is classified NOT_YET_WIRED in the unrouted ledger above, so no
  // production path reaches these sinks unadmitted today -- but the routing
  // claim here is contingent on that classification staying true. If the
  // connector is ever wired, this entry moves back to UNROUTED.
  //
  // Within that bound the property is strong: all twelve calls are downstream
  // of one admit() callback, across three families (candidate rows, canonical
  // graph edges, audit events), which is the evidence that the seam sits at a
  // family-independent boundary.
  'lib/conflict-detector.js': {
    why: 'candidate + audit + knowledge sinks; reachable in production only via kernel.ingestCandidateClaim, which routes routeCandidateClaim inside admit()',
    sinks: { addNode: 4, addEdge: 2, addCandidateClaim: 5, appendAuditEvent: 1 },
  },

  // --- K2 (#328): delegated production mutation path -----------------------
  // The admission-gated background edge commit moved from kernel.js to this
  // module as commitBackgroundEdge(deps). Its addEdge and four audit appends
  // (LEARN/REJECT pair plus the derived-edge pair) all sit inside the same
  // admission-gated callback that kernel.js owned before -- delegation moved
  // the code, not the boundary, so this entry is ROUTED, not debt.
  // If this module ever writes without its injected deps, this entry must be
  // the first place that fails.
  'lib/background-provenance.js': {
    why: 'K2-delegated background edge commit; the four sinks (1 addEdge + 3 appendAuditEvent) sit inside the admission callback passed to runMutationOnce/evaluateLearnAdmission via injected deps',
    // The scan regex only counts dot-call sinks (`.method(`), so only the
    // addEdge write and the first dot-call append are ledgered; the other
    // audit appends go through the injected (dotless) alias. Both kinds sit
    // inside the admission gate.
    sinks: { addEdge: 1, appendAuditEvent: 1 },
  },
});

/** Every file permitted to contain a sink call, in either state. */
function ledgerFor(relPath) {
  return UNROUTED_SINK_CALLS[relPath] || ROUTED_SINK_CALLS[relPath] || null;
}

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
    const baseline = ledgerFor(relPath);
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
    'UNROUTED_SINK_CALLS with a reason -- that makes it a reviewable decision',
    'rather than a silent bypass.',
  ].join('\n'));
});

test('mutation admission: the ledger does not keep slack after a caller is routed', () => {
  const measured = measure();
  const stale = [];

  for (const [relPath, baseline] of Object.entries({ ...UNROUTED_SINK_CALLS, ...ROUTED_SINK_CALLS })) {
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
    'Lower the number in the ledger so the progress is recorded and',
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
    Object.hasOwn(UNROUTED_SINK_CALLS, 'rustGraph.js'),
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

test('mutation admission: the debt ledger reflects the routing done so far', () => {
  const sum = (ledger) => Object.values(ledger)
    .reduce((total, entry) => total + Object.values(entry.sinks).reduce((a, b) => a + b, 0), 0);

  const unrouted = sum(UNROUTED_SINK_CALLS);
  const routed = sum(ROUTED_SINK_CALLS);

  // The total does not fall when a caller is *routed* -- the sink call still
  // exists, it has moved inside an admission callback. Success is UNROUTED
  // reaching zero, not the total shrinking. Pinning both numbers here keeps
  // that distinction from being quietly re-interpreted later.
  //
  // The total has fallen once, from 45 to 44, and the exception is worth
  // stating rather than absorbing: `lib/mcp-ingest-execute-tool.js` did not
  // get routed, it got *deleted*. Its audit write was a second copy of a write
  // `server.js` had already routed -- both transports drive the same approval
  // owner through an injected `recordAudit` port, and only one was injecting
  // the routed writer. Removing the copy removes a sink call outright, so the
  // total moved for the only reason it legitimately can. A total that falls
  // without a duplicate having been deleted is still a finding, not slack.
  //
  // The total rose once, from 44 to 46, and the exception is stated rather
  // than absorbed: `lib/http/v5-package-import-route.js` gained the unit-of-
  // work audit append under the V5 atomicity commit check (docs/v5/
  // v5-package-atomicity-contract.md) -- counted twice by the scan because
  // the V5_CHAIN lazy wrapper is itself a dot-call. That append is the
  // unit-of-work event, not a routed mutation -- the admission seam (P1)
  // remains the family-independent boundary, and this entry is a reviewable
  // debt decision, not a routing claim.
  // K2 (#328): the background edge commit moved from kernel.js to
  // lib/background-provenance.js as a delegation, not a routing change -- its
  // stay inside the admission gate, so they count routed. The scan only
  // ledgeres dot-call sinks, so the K2 entry contributes two (addEdge + the
  // dot-call append); the other appends ride the injected alias. The total
  // rose from 46 to 48 because the module's copy of the chain is now ledgered
  // outright rather than through the kernel wrapper.
  assert.equal(unrouted, 22, 'unrouted sink calls');
  assert.equal(routed, 26, 'sink calls routed through admission (K2: +2 background edge dot-calls)');
  assert.equal(unrouted + routed, 48, 'total sink calls, raised by the K2 background edge delegation');
});
