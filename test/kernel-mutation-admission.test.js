'use strict';

/**
 * Contract for the kernel's admission steps.
 *
 * Sections 1-3 cover `admitLearn`. Routing `kernel.learn` had to prove three
 * things at once:
 *
 *   1. admission runs after the plugin transform, at the point where the
 *      payload can no longer be rewritten, and before any durable machinery;
 *   2. durability semantics are untouched, and an admission refusal stays
 *      distinguishable from DURABLE_MUTATION_JOURNAL_UNAVAILABLE;
 *   3. all three learn entry points reach the same boundary, and the family's
 *      sinks have no other way in.
 *
 * Section 4 covers `admitCandidateIngress`, which has to prove something
 * different: not that a payload was sealed, but that the *routing decision and
 * its writes* happen inside the admitted effect, across all three families
 * `routeCandidateClaim` touches — and that the candidate entry points it does
 * not cover stay visible as debt rather than being absorbed into the claim.
 *
 * Section 5 covers `admitAddCandidateClaim`, the candidate family's second
 * routed entry point. Its burden is mostly about what must *not* change: the
 * pre-existing availability fault still throws without consulting the seam, and
 * the path still performs no conflict detection. Routing a caller may not
 * repair it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createMutationAdmission } = require('../lib/mutation-admission.js');
const {
  ABSENCE_REASONS,
  ADD_CANDIDATE_CLAIM_ACTION,
  CANDIDATE_ABSENCE_REASONS,
  CANDIDATE_INGRESS_ACTION,
  LEARN_ACTION,
  admitAddCandidateClaim,
  admitCandidateIngress,
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

// --- 4. candidate ingress -------------------------------------------------

const os = require('node:os');
const Kernel = require('../kernel.js');
const { AUDIT_EVENTS } = require('../lib/audit-log.js');

const candidateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-candidate-admission-'));
test.after(() => fs.rmSync(candidateTempDir, { recursive: true, force: true }));

function makeCandidateKernel(name) {
  return new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(candidateTempDir, `${name}.json`),
    dbPath: path.join(candidateTempDir, `${name}.db`),
  });
}

function makeClaim(overrides = {}) {
  return {
    claim: 'kedi hayvandir',
    subject: 'kedi',
    relation: 'IS_A',
    object: 'hayvan',
    provenance: {
      provenanceId: 'prov-admission-001',
      sourceRef: 'docs/claims.md#1',
      sourceTitle: 'Claims',
      sourceType: 'document',
      actor: 'builder',
      timestamp: '2026-06-02T00:00:00Z',
      confidence: 0.91,
      workspaceId: 'workspace-a',
      trustPolicyVersion: '0.8.0',
    },
    ...overrides,
  };
}

test('candidate ingress: a refusal leaves no candidate row, no edge and no audit event', () => {
  const kernel = makeCandidateKernel('refused');
  const admission = { admit: () => ({ admitted: false, reason: 'admission.context_invalid' }) };

  assert.throws(
    () => admitCandidateIngress(kernel, makeClaim(), { workspaceId: 'workspace-a' }, admission),
    (error) => {
      assert.equal(error.code, 'MUTATION_ADMISSION_REFUSED');
      return true;
    },
  );

  // This is the property the learn path cannot offer. There, admission hands a
  // sealed payload back and a caller could in principle write it. Here the
  // routing *is* the admitted effect, so a refusal is not merely advisory --
  // there is nothing to write, because nothing was decided.
  assert.deepEqual(kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' }), []);
  assert.equal(kernel.graph.getEdge('kedi', 'hayvan', 'IS_A', 'workspace-a'), null);
  assert.deepEqual(kernel.graph.getAuditEvents({ workspaceId: 'workspace-a' }), []);
});

test('candidate ingress: all three families are written inside the admitted effect', () => {
  const kernel = makeCandidateKernel('three-families');
  let stateBeforeMutate = null;

  const admission = {
    admit: (context, mutate) => {
      // Sampled at the moment admission has decided but the effect has not run.
      // If any of the three families were written before this point, the seam
      // would be observing a mutation rather than gating it.
      stateBeforeMutate = {
        candidates: kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' }).length,
        audits: kernel.graph.getAuditEvents({ workspaceId: 'workspace-a' }).length,
        edge: kernel.graph.getEdge('kedi', 'hayvan', 'IS_A', 'workspace-a'),
      };
      return { admitted: true, result: mutate() };
    },
  };

  const routed = admitCandidateIngress(kernel, makeClaim(), { workspaceId: 'workspace-a' }, admission);

  assert.deepEqual(stateBeforeMutate, { candidates: 0, audits: 0, edge: null });
  assert.equal(routed.candidate.status, 'accepted');

  // candidate family
  assert.equal(kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' }).length, 1);
  // knowledge family — the canonical edge the accept path writes
  assert.ok(kernel.graph.getEdge('kedi', 'hayvan', 'IS_A', 'workspace-a'));
  // audit family
  assert.ok(kernel.graph.getAuditEvents({
    eventType: AUDIT_EVENTS.CLAIM_ACCEPTED, workspaceId: 'workspace-a',
  }).length >= 1);
});

test('candidate ingress: the real seam admits, and kernel.ingestCandidateClaim has no other path', () => {
  const kernel = makeCandidateKernel('real-seam');
  const routed = kernel.ingestCandidateClaim(makeClaim(), { workspaceId: 'workspace-a' });
  assert.equal(routed.candidate.status, 'accepted');

  // Source-level: kernel.js must not reach routeCandidateClaim directly, or the
  // admitted-effect property above would hold only for the path this test took.
  const kernelSource = fs.readFileSync(path.join(repoRoot, 'kernel.js'), 'utf8');
  assert.equal((kernelSource.match(/routeCandidateClaim\(/g) || []).length, 0,
    'kernel.js must reach routeCandidateClaim only through admitCandidateIngress');
  assert.match(kernelSource, /admitCandidateIngress\(this, input, opts\)/);
});

test('candidate family: all three production entry points are routed', () => {
  // This test has now been restated twice, once per entry point routed, which
  // is what it is for: the family-level claim may not be inherited, only
  // rewritten by whoever changed what it describes.
  const kernelSource = fs.readFileSync(path.join(repoRoot, 'kernel.js'), 'utf8');
  assert.equal((kernelSource.match(/this\.graph\.addCandidateClaim\(/g) || []).length, 0,
    'kernel.addCandidateClaim must reach the graph only through admitAddCandidateClaim');
  assert.match(kernelSource, /admitAddCandidateClaim\(this, candidate, opts\)/);

  // The third ingress bypasses the kernel entirely, so it holds the seam
  // itself rather than reusing anything here: its durable commit is the
  // admitted effect.
  const externalClient = fs.readFileSync(
    path.join(repoRoot, 'lib/external-client-mutation-receipt-owner.js'), 'utf8');
  assert.match(externalClient, /admission\.admit\(\{/,
    'the external client ingress must hold its own admission seam');
  const admitAt = externalClient.indexOf('admission.admit({');
  const journalAt = externalClient.indexOf('graph.runMutationOnce(operationId');
  const sinkAt = externalClient.indexOf('graph.addCandidateClaim(localCandidate');
  assert.ok(admitAt > 0 && admitAt < journalAt && journalAt < sinkAt,
    'admission must enclose the durable commit, which encloses the sink');

  // Absence is declared here for a different reason than everywhere else, and
  // the wording must not drift back to the copied one: this caller's identity
  // IS receiver-verified. What is missing is a claim shape, which is gate 3's.
  const { ABSENCE_REASONS: EXTERNAL_REASONS } =
    require('../lib/external-client-mutation-receipt-owner.js');
  assert.match(EXTERNAL_REASONS.identityClaim, /verifies a receiver-owned identity/);
  assert.doesNotMatch(EXTERNAL_REASONS.identityClaim, /caller-supplied label/);
  assert.notEqual(EXTERNAL_REASONS.identityClaim, CANDIDATE_ABSENCE_REASONS.identityClaim);

  // And the transitive routing claim for conflict-detector.js is contingent on
  // github-connector staying unwired; assert the second caller is still the
  // library-only one the ledger classifies as NOT_YET_WIRED.
  const connector = fs.readFileSync(path.join(repoRoot, 'lib/github-connector.js'), 'utf8');
  assert.match(connector, /routeCandidateClaim\(/,
    'github-connector is routeCandidateClaim\'s second caller and is not admitted');
});

test('candidate ingress context: caller-supplied actors are not promoted, workspace is resolved in the open', () => {
  const kernel = makeCandidateKernel('context');
  const seen = [];
  const admission = {
    admit: (context, mutate) => { seen.push(context); return { admitted: true, result: mutate() }; },
  };

  admitCandidateIngress(kernel, makeClaim({ provenance: null }), {}, admission);
  admitCandidateIngress(kernel, makeClaim(), { workspaceId: '  spaced  ', actor: 'cli-user', reviewedBy: 'reviewer-a' }, admission);

  assert.equal(seen[0].action, CANDIDATE_INGRESS_ACTION);
  assert.equal(seen[0].workspaceId, 'default');
  assert.equal(seen[1].workspaceId, 'spaced');

  assert.equal(seen[1].identityClaim.kind, 'absent');
  assert.match(CANDIDATE_ABSENCE_REASONS.identityClaim, /caller-supplied label/);
  // reviewedBy names a reviewer but models no delegation; recording it as an
  // identity or a delegation chain would let the request describe who it is.
  assert.equal(seen[1].delegationContext.kind, 'absent');
  assert.equal(JSON.stringify(seen[1]).includes('cli-user'), false);
  assert.equal(JSON.stringify(seen[1]).includes('reviewer-a'), false);
});

// --- 5. the direct candidate write ----------------------------------------

test('addCandidateClaim: a refusal stores no row', () => {
  const kernel = makeCandidateKernel('acc-refused');
  const admission = { admit: () => ({ admitted: false, reason: 'admission.context_invalid' }) };

  assert.throws(
    () => admitAddCandidateClaim(kernel, makeClaim(), { workspaceId: 'workspace-a' }, admission),
    (error) => {
      assert.equal(error.code, 'MUTATION_ADMISSION_REFUSED');
      return true;
    },
  );
  assert.deepEqual(kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' }), []);
});

test('addCandidateClaim: the write runs inside the admitted effect', () => {
  const kernel = makeCandidateKernel('acc-inside');
  let rowsBeforeMutate = null;
  const admission = {
    admit: (context, mutate) => {
      rowsBeforeMutate = kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' }).length;
      return { admitted: true, result: mutate() };
    },
  };

  kernel._mutationAdmission = admission;
  kernel.addCandidateClaim(makeClaim(), { workspaceId: 'workspace-a' });

  assert.equal(rowsBeforeMutate, 0);
  assert.equal(kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' }).length, 1);
});

test('addCandidateClaim: the availability fault still throws, and never reaches admission', () => {
  // Preserved exactly: "there is nothing to write to" is an infrastructure
  // fault, not a decision about whether a write is permitted, so it must not
  // arrive at the seam as an admitted-then-failed mutation.
  const admission = { admit: () => { throw new Error('admission must not be consulted'); } };

  assert.throws(
    () => admitAddCandidateClaim({ graph: null }, makeClaim(), {}, admission),
    /Graph candidate claim storage is unavailable\./,
  );
  assert.throws(
    () => admitAddCandidateClaim({ graph: {} }, makeClaim(), {}, admission),
    /Graph candidate claim storage is unavailable\./,
  );
});

test('addCandidateClaim: it is a distinct action from candidate ingress, because it skips conflict detection', () => {
  const kernel = makeCandidateKernel('acc-action');
  const seen = [];
  const admission = {
    admit: (context, mutate) => { seen.push(context); return { admitted: true, result: mutate() }; },
  };

  admitAddCandidateClaim(kernel, makeClaim(), { workspaceId: 'workspace-a' }, admission);

  assert.equal(seen[0].action, ADD_CANDIDATE_CLAIM_ACTION);
  assert.notEqual(ADD_CANDIDATE_CLAIM_ACTION, CANDIDATE_INGRESS_ACTION);

  // The behavioural difference the distinct action exists to make expressible.
  // Contrast with the ingress test above, which ends at status 'accepted' with a
  // conflict evaluated and a canonical edge written: here nothing is decided.
  const stored = kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].conflict, null, 'no conflict was evaluated on this path');
  assert.equal(stored[0].status, 'pending', 'no accept/reject decision was taken');
  assert.equal(kernel.graph.getEdge('kedi', 'hayvan', 'IS_A', 'workspace-a'), null,
    'the direct write must not produce a canonical edge');
});

test('addCandidateClaim: the workspace is resolved with the sink\'s own four-source precedence', () => {
  const kernel = makeCandidateKernel('acc-workspace');
  const seen = [];
  const admission = {
    admit: (context, mutate) => { seen.push(context); return { admitted: true, result: mutate() }; },
  };

  // Each call drops one source, so the next one down has to be the one used.
  admitAddCandidateClaim(kernel, { ...makeClaim(), workspaceId: 'from-claim' }, { workspaceId: '  from-opts  ' }, admission);
  admitAddCandidateClaim(kernel, { ...makeClaim(), workspaceId: 'from-claim' }, {}, admission);
  admitAddCandidateClaim(kernel, makeClaim(), {}, admission);
  admitAddCandidateClaim(kernel, { claim: 'x', proposedEdge: { workspaceId: 'from-edge' } }, {}, admission);
  admitAddCandidateClaim(kernel, { claim: 'x' }, {}, admission);

  assert.deepEqual(seen.map((context) => context.workspaceId), [
    'from-opts',
    'from-claim',
    'workspace-a', // provenance.workspaceId
    'from-edge',
    'default',
  ]);
});
