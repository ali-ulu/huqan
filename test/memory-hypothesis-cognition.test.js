'use strict';

/**
 * R49 (#3568): the first runtime consumer of the K0/K1 kernel contracts.
 *
 * Pinned here: a proposed hypothesis candidate now carries a validated K1
 * reference frame and CognitiveMessage and a validated K0 hypothesis object,
 * through the real CLI path (`hypotheses --propose`), and an invalid step is
 * refused before it reaches the candidate queue. The frame is not decoration:
 * it survives the candidate store, and two different frames compare as
 * review-worthy rather than merging silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const CLI = require('../cli');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const {
  COGNITIVE_CONTRACT_VIOLATION,
  DECLARED_UNKNOWN,
  assertHypothesisCognition,
  buildHypothesisCognitiveMessage,
  buildHypothesisKnowledgeObject,
  compareHypothesisFrames,
  consumeHypothesisCognition,
  hypothesisReferenceFrame,
} = require('../lib/memory-hypothesis-cognition');
const { buildHypothesisCandidate } = require('../lib/graph-hypotheses');
const { COGNITIVE_MESSAGE_FIELDS, REFERENCE_FRAME_FIELDS } = require('../lib/memory-cognitive-message');

const NOW = '2026-10-06T12:00:00.000Z';

function createCli(label = 'hypothesis-cognition') {
  const kernel = new Kernel(isolatedKernelOptions(label));
  const cli = new CLI({ kernelInstance: kernel });
  return { kernel, cli };
}

function closeCli({ kernel, cli }) {
  cli?.agent?.storage?.close?.();
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

function seedCriticalNode(kernel) {
  for (const id of ['a', 'b', 'c']) kernel.graph.addNode(id, id);
  kernel.graph.addEdge('a', 'b', 'supports', { confidence: 0.9, evidence: ['a'] });
  kernel.graph.addEdge('c', 'b', 'supports', { confidence: 0.9, evidence: ['c'] });
}

const hypothesis = {
  type: 'KRİTİK_DÜĞÜM',
  severity: 'high',
  target: 'b',
  confidence: 0.9,
  gerekce: 'b düğümünün in-degree değeri 2; eşik 2.',
};

const env = {
  HUQAN_FRAME_REPO: 'ali-ulu/huqan',
  HUQAN_FRAME_BRANCH: 'feat/3471-k1-cognitive-message',
  HUQAN_FRAME_COMMIT: '9ab5139e7752dabb5a364b531bbaa17a3972b3eb',
  HUQAN_FRAME_ENVIRONMENT: 'ci',
};

// --- the frame ------------------------------------------------------------

test('the frame has all eight K1 fields and reads explicit input first', () => {
  const frame = hypothesisReferenceFrame({ workspaceId: 'ws-1', env, time: NOW, repo: 'explicit/repo' });
  assert.deepEqual(Object.keys(frame).sort(), [...REFERENCE_FRAME_FIELDS].sort());
  assert.equal(frame.repo, 'explicit/repo', 'explicit input outranks the environment');
  assert.equal(frame.branch, 'feat/3471-k1-cognitive-message');
  assert.equal(frame.commit, '9ab5139e7752dabb5a364b531bbaa17a3972b3eb');
  assert.equal(frame.environment, 'ci');
  assert.equal(frame.actor, 'cli:hypotheses');
  assert.equal(frame.time, NOW);
  assert.equal(frame.goal, 'inspect deterministic graph hypotheses');
  assert.equal(frame.task, 'hypothesis:ws-1');
});

test('an unresolvable frame field is a declared unknown, never blank', () => {
  const frame = hypothesisReferenceFrame({ workspaceId: 'default', env: {}, time: NOW });
  for (const field of ['repo', 'branch', 'commit', 'environment']) {
    assert.equal(frame[field], DECLARED_UNKNOWN);
  }
  // A declared unknown still validates: it is an explicit gap, not an error.
  const { validateReferenceFrame } = require('../lib/memory-cognitive-message');
  assert.equal(validateReferenceFrame(frame).ok, true);
});

test('GitHub Actions variables are a fallback when HUQAN_FRAME_* are absent', () => {
  const frame = hypothesisReferenceFrame({
    env: { GITHUB_REPOSITORY: 'ali-ulu/huqan', GITHUB_REF_NAME: 'main', GITHUB_SHA: 'abc123' },
    time: NOW,
  });
  assert.equal(frame.repo, 'ali-ulu/huqan');
  assert.equal(frame.branch, 'main');
  assert.equal(frame.commit, 'abc123');
  assert.equal(frame.environment, DECLARED_UNKNOWN);
});

// --- the message ----------------------------------------------------------

test('the cognitive message declares every K1 field it has and names the unknown ones', () => {
  const frame = hypothesisReferenceFrame({ workspaceId: 'default', env, time: NOW });
  const message = buildHypothesisCognitiveMessage({
    hypothesis, workspaceId: 'default', traceId: 'cand_hyp_x', frame, budget: { tokens: 0 },
  });
  for (const field of COGNITIVE_MESSAGE_FIELDS) {
    assert.ok(field in message, `${field} is present`);
  }
  assert.equal(message.source, 'cli:hypotheses');
  assert.equal(message.target, 'graph:default');
  assert.equal(message.confidence, 0.9);
  assert.deepEqual(message.evidenceRefs, ['candidate:cand_hyp_x']);
  assert.equal(message.traceId, 'cand_hyp_x');
});

test('an unmeasured payload field is an explicit FIELD_UNKNOWN warning, not a placeholder', () => {
  const frame = hypothesisReferenceFrame({ workspaceId: 'default', env, time: NOW });
  const message = buildHypothesisCognitiveMessage({ hypothesis, workspaceId: 'default', traceId: 'cand_hyp_x', frame });
  const { validateCognitiveMessage } = require('../lib/memory-cognitive-message');
  const outcome = validateCognitiveMessage(message);
  assert.equal(outcome.ok, true);
  // `budget` was not supplied and is not invented.
  assert.equal(outcome.warnings.some((item) => item.field === 'budget' && item.code === 'FIELD_UNKNOWN'), true);
  assert.equal('budget' in message, false);
});

// --- the knowledge object -------------------------------------------------

test('the knowledge object is a learned hypothesis, the pair K0 allows', () => {
  const candidate = buildHypothesisCandidate(hypothesis, 'default');
  const { knowledgeObject: object } = consumeHypothesisCognition(candidate, hypothesis, { env, time: NOW });
  assert.equal(object.kind, 'hypothesis');
  assert.equal(object.origin, 'learned');
  assert.equal(object.status, 'active');
  assert.equal(object.receipt, null);
  assert.equal(object.knowledgeId, candidate.candidateId);
  assert.equal(object.provenance.provenanceId, candidate.provenance.provenanceId);
});

test('a learned policy would be refused by the same validator (authority boundary)', () => {
  const { validateKnowledgeObject } = require('../lib/memory-knowledge-object');
  const candidate = buildHypothesisCandidate(hypothesis, 'default');
  const { knowledgeObject } = consumeHypothesisCognition(candidate, hypothesis, { env, time: NOW });
  const widened = { ...knowledgeObject, kind: 'policy' };
  const outcome = validateKnowledgeObject(widened);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errors.some((item) => item.code === 'AUTHORITY_EXPANSION_REFUSED'), true);
});

// --- fail-closed ----------------------------------------------------------

test('an invalid step is refused with COGNITIVE_CONTRACT_VIOLATION and named fields', () => {
  const frame = hypothesisReferenceFrame({ workspaceId: 'default', env, time: NOW });
  const message = buildHypothesisCognitiveMessage({ hypothesis, workspaceId: 'default', traceId: 'cand_hyp_x', frame });
  const object = buildHypothesisKnowledgeObject({
    candidate: { candidateId: 'cand_hyp_x', claim: '[X] y', workspaceId: 'default', provenance: { provenanceId: 'p', sourceRef: 's', sourceTitle: 't', sourceType: 'hypothesis-engine', actor: 'a', timestamp: NOW, workspaceId: 'default', trustPolicyVersion: '1.0.0', confidence: 0.5 } },
    hypothesis,
    frame,
  });
  assert.throws(
    () => assertHypothesisCognition({ message: { ...message, source: '' }, frame, knowledgeObject: object }),
    (error) => error.code === COGNITIVE_CONTRACT_VIOLATION
      && error.violations.some((item) => item.contract === 'message' && item.field === 'source'),
  );
});

test('a candidate whose frame cannot validate never reaches the queue', () => {
  // `time` is the one frame field with a format rule; an unparseable value is
  // the reachable way for a caller-supplied frame to fail closed.
  const candidate = buildHypothesisCandidate(hypothesis, 'default');
  assert.throws(
    () => consumeHypothesisCognition(candidate, hypothesis, { env, time: 'not-a-timestamp' }),
    (error) => error.code === COGNITIVE_CONTRACT_VIOLATION
      && error.violations.some((item) => item.contract === 'frame' && item.field === 'time'),
  );
});

// --- frame comparison -----------------------------------------------------

test('a re-sighting in a different frame asks for review instead of merging', () => {
  const observed = hypothesisReferenceFrame({ workspaceId: 'default', env, time: NOW });
  const other = hypothesisReferenceFrame({ workspaceId: 'default', env: { ...env, HUQAN_FRAME_BRANCH: 'main' }, time: NOW });
  const compared = compareHypothesisFrames(observed, other);
  assert.equal(compared.status, 'mismatch');
  assert.equal(compared.requiresReview, true);
  assert.equal(compared.mergeAllowed, false);
  assert.deepEqual([...compared.mismatched], ['branch']);
});

test('the same frame merges only when every field matched', () => {
  const observed = hypothesisReferenceFrame({ workspaceId: 'default', env, time: NOW });
  const compared = compareHypothesisFrames(observed, observed);
  assert.equal(compared.status, 'match');
  assert.equal(compared.mergeAllowed, true);
  assert.equal(compared.requiresReview, false);
});

// --- the real path --------------------------------------------------------

test('hypotheses --propose queues a candidate carrying the validated frame', async () => {
  const managed = createCli('cli-cognition-propose');
  try {
    seedCriticalNode(managed.kernel);
    const stdout = [];
    const result = await runCliArgv(['hypotheses', '--critical', '2', '--propose', '--json'], {
      cli: managed.cli,
      stdout: (value) => stdout.push(value),
      env,
    });
    assert.equal(result.exitCode, 0);
    const candidates = managed.kernel.getCandidateClaims({ workspaceId: 'default' });
    assert.equal(candidates.length, 1);
    const frame = candidates[0].provenance.referenceFrame;
    assert.ok(frame, 'the stored candidate carries a reference frame');
    assert.deepEqual(Object.keys(frame).sort(), [...REFERENCE_FRAME_FIELDS].sort());
    assert.equal(frame.actor, 'cli:hypotheses');
  } finally {
    closeCli(managed);
  }
});

test('a re-sighting in a different frame is flagged for review, not merged', async () => {
  const managed = createCli('cli-cognition-resight');
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    seedCriticalNode(managed.kernel);
    const run = () => runCliArgv(['hypotheses', '--critical', '2', '--propose', '--json'], {
      cli: managed.cli,
      stdout: () => {},
    });

    process.env.HUQAN_FRAME_BRANCH = 'main';
    await run();
    // The same graph, seen from another branch: same candidateId, different
    // frame. The store keeps one row, and the second sighting must not merge
    // silently -- the frame comparison is recorded and the row stays pending.
    process.env.HUQAN_FRAME_BRANCH = 'feature/x';
    const second = await run();
    assert.equal(second.exitCode, 0);

    const candidates = managed.kernel.getCandidateClaims({ workspaceId: 'default' });
    assert.equal(candidates.length, 1, 'the re-sighting replaces the one row, it does not add a second');
    const comparison = candidates[0].frameComparison;
    assert.ok(comparison, 'the re-sighting records a frame comparison');
    assert.equal(comparison.mergeAllowed, false);
    assert.equal(comparison.requiresReview, true);
    assert.ok([...comparison.mismatched].includes('branch'), 'the branch difference is the recorded mismatch');
    assert.equal(candidates[0].status, 'pending');
    assert.equal(candidates[0].recommendation, 'flag');
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    closeCli(managed);
  }
});

test('the cognition module exposes the contract surface', () => {
  assert.equal(typeof assertHypothesisCognition, 'function');
  assert.equal(typeof hypothesisReferenceFrame, 'function');
  assert.equal(COGNITIVE_CONTRACT_VIOLATION, 'COGNITIVE_CONTRACT_VIOLATION');
});
