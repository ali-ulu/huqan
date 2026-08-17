'use strict';

/**
 * Contract for the learn family's admission step.
 *
 * Routing `kernel.learn` had to prove three things at once, and each has its
 * own section below:
 *
 *   1. admission runs after the plugin transform, at the point where the
 *      payload can no longer be rewritten, and before any durable machinery;
 *   2. durability semantics are untouched, and an admission refusal stays
 *      distinguishable from DURABLE_MUTATION_JOURNAL_UNAVAILABLE;
 *   3. all three learn entry points reach the same boundary, and the family's
 *      sinks have no other way in.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createMutationAdmission } = require('../lib/mutation-admission.js');
const {
  ABSENCE_REASONS,
  CANDIDATE_INGEST_ACTION,
  LEARN_ACTION,
  admitCandidateIngest,
  admitLearn,
} = require('../lib/kernel-mutation-admission.js');

const repoRoot = path.join(__dirname, '..');
const FIXED_CLOCK = () => new Date('2026-08-16T12:00:00.000Z');

/** A kernel stub exposing only what admitLearn touches. */
function makeKernel(beforeLearn) {
  return {
    _runBeforeLearn: beforeLearn || ((text, opts) => ({ text, opts })),
  };
}

// --- 1. ordering ----------------------------------------------------------

test('ordering: admission sees the payload the plugins produced, not the original', () => {
  const kernel = makeKernel(() => ({
    text: 'rewritten by a plugin',
    opts: { workspaceId: 'plugin-workspace' },
  }));
  const seen = [];
  const admission = {
    admit: (context, mutate) => { seen.push(context); return { admitted: true, result: mutate() }; },
  };

  const sealed = admitLearn(kernel, 'original text', { workspaceId: 'caller-workspace' }, admission);

  // If admission ran first it would have judged 'caller-workspace' and then a
  // plugin would have changed it -- approving one payload and writing another.
  assert.equal(seen[0].workspaceId, 'plugin-workspace');
  assert.equal(sealed.text, 'rewritten by a plugin');
  assert.equal(seen[0].action, LEARN_ACTION);
});

test('ordering: the transform cannot be reached without going through admission', () => {
  // The caller never sees the untransformed payload: admitLearn calls the
  // transform itself, so there is no arrangement in which admission is skipped
  // or run first.
  const source = fs.readFileSync(path.join(repoRoot, 'lib/kernel-mutation-admission.js'), 'utf8');
  assert.match(source, /_runBeforeLearn\(text, opts\)/);

  const kernelSource = fs.readFileSync(path.join(repoRoot, 'kernel.js'), 'utf8');
  // kernel.learn no longer calls the transform directly.
  assert.equal((kernelSource.match(/this\._runBeforeLearn\(/g) || []).length, 0,
    'kernel.learn must reach the transform only through admitLearn');
  assert.match(kernelSource, /admitLearn\(this, text, opts\)/);
});

test('ordering: admission precedes the critical section and the durable journal', () => {
  const kernelSource = fs.readFileSync(path.join(repoRoot, 'kernel.js'), 'utf8');
  const admitAt = kernelSource.indexOf('admitLearn(this, text, opts)');
  const criticalAt = kernelSource.indexOf("_enterCriticalSection('learn')");
  const journalAt = kernelSource.indexOf('runMutationOnce(operationId');

  assert.ok(admitAt > 0 && criticalAt > 0 && journalAt > 0);
  assert.ok(admitAt < criticalAt, 'admission must precede the critical section');
  assert.ok(criticalAt < journalAt, 'the critical section still precedes the journal');
});

test('ordering: a refusal produces no payload, so nothing downstream can proceed', () => {
  const kernel = makeKernel();
  const admission = { admit: () => ({ admitted: false, reason: 'admission.context_invalid' }) };

  assert.throws(() => admitLearn(kernel, 'text', {}, admission), (error) => {
    assert.equal(error.code, 'MUTATION_ADMISSION_REFUSED');
    assert.equal(error.admissionReason, 'admission.context_invalid');
    return true;
  });
});

// --- 2. durability --------------------------------------------------------

test('durability: admission neither performs nor replaces the durable write', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'lib/kernel-mutation-admission.js'), 'utf8');

  // Invariant 1 again, at this call site: the seam must not acquire durability
  // responsibilities on the way in.
  // Calls, not mentions: the module's own documentation names both in order to
  // explain why it stays out of them.
  assert.ok(!/runMutationOnce\s*\(/.test(source), 'the learn admission must not touch the journal');
  assert.ok(!/_enterCriticalSection\s*\(/.test(source), 'the learn admission must not take the lock');
});

test('durability: an admission refusal is not the journal-unavailable failure', () => {
  const kernel = makeKernel();
  const admission = { admit: () => ({ admitted: false, reason: 'identity.workspace_binding_failed' }) };

  let code = '';
  try { admitLearn(kernel, 'text', {}, admission); } catch (error) { code = error.code; }

  // "may not happen" and "cannot be recorded safely" are different operational
  // states and an operator responds differently to each. kernel.js still throws
  // DURABLE_MUTATION_JOURNAL_UNAVAILABLE on its own path.
  assert.equal(code, 'MUTATION_ADMISSION_REFUSED');
  assert.notEqual(code, 'DURABLE_MUTATION_JOURNAL_UNAVAILABLE');

  const kernelSource = fs.readFileSync(path.join(repoRoot, 'kernel.js'), 'utf8');
  assert.match(kernelSource, /DURABLE_MUTATION_JOURNAL_UNAVAILABLE/);
});

// --- 3. the family reaches one boundary -----------------------------------

test('family: learnDocument and learnAsync funnel into learn', () => {
  const kernelSource = fs.readFileSync(path.join(repoRoot, 'kernel.js'), 'utf8');

  // Re-proven as a source assertion rather than inherited from the P1-B
  // measurement: if either grew its own path, gating learn would stop gating
  // the family and this would fail.
  const learnDocument = kernelSource.slice(kernelSource.indexOf('learnDocument(text, opts = {})'));
  assert.match(learnDocument.slice(0, 900), /this\.learn\(/);

  const learnAsync = kernelSource.slice(kernelSource.indexOf('async learnAsync(text, opts = {})'));
  assert.match(learnAsync.slice(0, 400), /this\.learn\(/);
});

test('family: the learn sinks have exactly one way in', () => {
  // lib/learn-use-case.js holds the knowledge family's eight sink calls. Its
  // ROUTED entry is a transitive claim, so the two facts it rests on are
  // asserted here rather than assumed: one export, one caller.
  const useCase = fs.readFileSync(path.join(repoRoot, 'lib/learn-use-case.js'), 'utf8');
  assert.match(useCase, /module\.exports = \{ runLearnUseCase \}/);

  const { execFileSync } = require('node:child_process');
  const callers = execFileSync('git', ['grep', '-l', 'runLearnUseCase(', '--', '*.js'], {
    cwd: repoRoot, encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !/(\.test\.js$|^test\/)/.test(file))
    .filter((file) => file !== 'lib/learn-use-case.js');

  assert.deepEqual(callers, ['kernel.js'],
    'a second caller would reach the learn sinks without passing admission');
});

// --- context --------------------------------------------------------------

test('context: opts.actor is not promoted to an identity claim', () => {
  const kernel = makeKernel();
  const seen = [];
  const admission = {
    admit: (context, mutate) => { seen.push(context); return { admitted: true, result: mutate() }; },
  };

  admitLearn(kernel, 'text', { actor: 'cli-user', sourceType: 'cli', sourceRef: 'cli:ogret' }, admission);

  // A caller-supplied label describing who the caller is, is exactly what
  // "identity is receiver-owned" forbids. Routing revealed the field; it did
  // not license using it.
  assert.equal(seen[0].identityClaim.kind, 'absent');
  assert.match(ABSENCE_REASONS.identityClaim, /caller-supplied label/);
  assert.equal(JSON.stringify(seen[0]).includes('cli-user'), false,
    'the actor label must not travel into the admission context');
});

test('context: the workspace is resolved in the open, with the same default', () => {
  const kernel = makeKernel();
  const seen = [];
  const admission = {
    admit: (context, mutate) => { seen.push(context); return { admitted: true, result: mutate() }; },
  };

  admitLearn(kernel, 'text', {}, admission);
  admitLearn(kernel, 'text', { workspaceId: '  spaced  ' }, admission);

  assert.equal(seen[0].workspaceId, 'default');
  assert.equal(seen[1].workspaceId, 'spaced');
});

test('context: the real seam admits a complete learn context', () => {
  // Not a stub: the actual module, proving the context this caller builds is
  // one the seam accepts.
  const kernel = makeKernel();
  const sealed = admitLearn(kernel, 'text', { workspaceId: 'default' }, createMutationAdmission({ clock: FIXED_CLOCK }));

  assert.equal(sealed.text, 'text');
  assert.deepEqual(sealed.opts, { workspaceId: 'default' });
});

// --- candidate ingest -----------------------------------------------------

test('candidate ingest: the mutation runs inside the admission, not after it', () => {
  const kernel = {};
  const order = [];
  const admission = {
    admit: (context, mutate) => {
      order.push('admit:enter');
      const result = mutate();
      order.push('admit:exit');
      return { admitted: true, result };
    },
  };

  const result = admitCandidateIngest(kernel, { workspaceId: 'default' }, () => {
    order.push('mutation');
    return 'routed';
  }, admission);

  // The stronger of the two shapes: everything routeCandidateClaim reaches --
  // all twelve conflict-detector sinks, across three families -- is lexically
  // inside an active admission rather than merely downstream of one.
  assert.deepEqual(order, ['admit:enter', 'mutation', 'admit:exit']);
  assert.equal(result, 'routed');
});

test('candidate ingest: a refusal means the mutation never runs', () => {
  let ran = false;
  const admission = { admit: () => ({ admitted: false, reason: 'identity.invalid_claim' }) };

  assert.throws(
    () => admitCandidateIngest({}, {}, () => { ran = true; }, admission),
    (error) => {
      assert.equal(error.code, 'MUTATION_ADMISSION_REFUSED');
      assert.match(error.message, /candidate ingest/);
      return true;
    },
  );
  assert.equal(ran, false);
});

test('candidate ingest: kernel.ingestCandidateClaim wraps routeCandidateClaim', () => {
  const kernelSource = fs.readFileSync(path.join(repoRoot, 'kernel.js'), 'utf8');

  // The route call must be the callback, not a sibling statement -- otherwise
  // the twelve downstream sinks would run outside the admission.
  assert.match(
    kernelSource,
    /admitCandidateIngest\(this, opts, \(\) => routeCandidateClaim\(this, input, opts\)\)/,
  );
});

test('candidate ingest: conflict-detector sinks have exactly one production way in', () => {
  // The ROUTED claim for lib/conflict-detector.js rests on these facts, so they
  // are asserted rather than assumed.
  const detector = fs.readFileSync(path.join(repoRoot, 'lib/conflict-detector.js'), 'utf8');

  // Only routeCandidateClaim is exported among the three functions that hold
  // sink calls; the other two are internal.
  assert.match(detector, /module\.exports = \{[\s\S]*routeCandidateClaim,/);
  assert.ok(!/module\.exports[\s\S]*acceptCandidateClaimJournaled/.test(detector));
  assert.ok(!/module\.exports[\s\S]*\bappendAudit\b/.test(detector));

  const { execFileSync } = require('node:child_process');
  const callers = execFileSync('git', ['grep', '-l', 'routeCandidateClaim(', '--', '*.js'], {
    cwd: repoRoot, encoding: 'utf8',
  })
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((f) => !/(\.test\.js$|^test\/)/.test(f))
    .filter((f) => f !== 'lib/conflict-detector.js');

  // github-connector is NOT_YET_WIRED, so kernel.js is the only production way in.
  assert.deepEqual(callers.sort(), ['kernel.js', 'lib/github-connector.js']);
});

test('candidate ingest: routing it does NOT make the candidate family routed', () => {
  // Two other production entries reach graph.addCandidateClaim without passing
  // admission. Recording this as a test keeps the ledger honest: a future
  // reader must not infer family coverage from this unit.
  const kernelSource = fs.readFileSync(path.join(repoRoot, 'kernel.js'), 'utf8');
  assert.match(kernelSource, /return this\.graph\.addCandidateClaim\(candidate, opts\)/,
    'kernel.addCandidateClaim still writes directly');

  const externalClient = fs.readFileSync(
    path.join(repoRoot, 'lib/external-client-mutation-receipt-owner.js'), 'utf8');
  assert.match(externalClient, /graph\.addCandidateClaim\(/,
    'the external client still writes directly');
});
