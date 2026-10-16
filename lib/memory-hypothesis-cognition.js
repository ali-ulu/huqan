'use strict';

/**
 * R49: the first runtime consumer of the K0/K1 kernel contracts.
 *
 * K0 (`lib/memory-knowledge-object.js`, #3470) and K1
 * (`lib/memory-cognitive-message.js`, #3471) shipped as schemas with no
 * caller: both sat in `lib/module-reachability.js` NOT_YET_WIRED "awaiting a
 * producer or consumer that validates through it". This module is that caller.
 *
 * A graph hypothesis is already, by definition, a cognitive step: the engine
 * observes a graph shape, predicts a defect, and flags it for a person. Until
 * now the candidate carried only provenance; the reference frame that says
 * *where* the observation is true was lost, so a finding could not be tied to
 * the repo/branch/commit it was made in.
 *
 * Three artifacts are built and validated here, and only here:
 *
 * - the K1 reference frame (repo/branch/commit/environment/actor/time/goal/task),
 *   read from explicit input, then the `HUQAN_FRAME_*` / GitHub Actions
 *   environment, then a declared `unknown`. A value that is genuinely not known
 *   is declared `unknown` rather than left out: K1's frame validator requires
 *   all eight fields, and two frames that both declare `unknown` agree that
 *   they do not know. A known value against a declared `unknown` is a
 *   mismatch, which -- like `unknown` -- asks for review rather than merging.
 * - the K1 CognitiveMessage envelope (thirteen fields) that carries the step.
 * - the K0 KnowledgeObject (`kind: 'hypothesis'`, `origin: 'learned'`) the step
 *   would become if it were ever admitted as knowledge. It is built and
 *   validated, never written: promotion stays a separate, gated act.
 *
 * Fail-closed: an artifact that does not validate raises
 * `COGNITIVE_CONTRACT_VIOLATION` with the offending fields, so an invalid
 * candidate never reaches the candidate queue. `compareHypothesisFrames` wraps
 * K1's comparator so a re-sighting in a different frame is reported as
 * explicit review rather than a silent merge.
 */

const {
  compareReferenceFrames,
  validateCognitiveMessage,
  validateReferenceFrame,
} = require('./memory-cognitive-message');
const { validateKnowledgeObject } = require('./memory-knowledge-object');
const { isPlainObject } = require('./is-plain-object');

const COGNITIVE_SOURCE = 'cli:hypotheses';
const COGNITIVE_CONTRACT_VIOLATION = 'COGNITIVE_CONTRACT_VIOLATION';
const HYPOTHESIS_OBJECT_VERSION = '1.0.0';
const DEFAULT_TRUST_POLICY_VERSION = '1.0.0';
const DEFAULT_GOAL = 'inspect deterministic graph hypotheses';

// Declared, not implied. A field we cannot resolve is named `unknown` so the
// frame still validates and a reader can see the gap instead of an empty value
// that reads as "measured none".
const DECLARED_UNKNOWN = 'unknown';

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function confidenceOf(hypothesis) {
  const value = Number.isFinite(hypothesis?.confidence) ? hypothesis.confidence : 0.5;
  return Math.max(0, Math.min(1, value));
}

/**
 * The K1 reference frame for a hypothesis observation. Explicit input wins;
 * then the environment; then a declared `unknown`. `time` defaults to now so
 * the frame is always valid, and `actor` is the engine, not the reviewer.
 */
function hypothesisReferenceFrame(input = {}) {
  const env = isPlainObject(input.env) ? input.env : process.env;
  const workspaceId = text(input.workspaceId, 'default');
  return Object.freeze({
    repo: text(input.repo) || firstEnv(env, ['HUQAN_FRAME_REPO', 'GITHUB_REPOSITORY']) || DECLARED_UNKNOWN,
    branch: text(input.branch) || firstEnv(env, ['HUQAN_FRAME_BRANCH', 'GITHUB_REF_NAME']) || DECLARED_UNKNOWN,
    commit: text(input.commit) || firstEnv(env, ['HUQAN_FRAME_COMMIT', 'GITHUB_SHA']) || DECLARED_UNKNOWN,
    environment: text(input.environment) || firstEnv(env, ['HUQAN_FRAME_ENVIRONMENT', 'NODE_ENV']) || DECLARED_UNKNOWN,
    actor: text(input.actor, COGNITIVE_SOURCE),
    time: text(input.time) || new Date().toISOString(),
    goal: text(input.goal, DEFAULT_GOAL),
    task: text(input.task, `hypothesis:${workspaceId}`),
  });
}

/**
 * The K1 CognitiveMessage for one hypothesis. Fields we do not have are left
 * out on purpose: K1 records an absent payload field as an explicit
 * `FIELD_UNKNOWN` warning, which is the honest reading, instead of a
 * placeholder that looks measured.
 */
function buildHypothesisCognitiveMessage({ hypothesis, workspaceId, traceId, frame, budget }) {
  const confidence = confidenceOf(hypothesis);
  const message = {
    source: COGNITIVE_SOURCE,
    target: `graph:${workspaceId}`,
    workspace: workspaceId,
    goal: frame.goal,
    observation: { target: hypothesis.target, severity: hypothesis.severity },
    prediction: hypothesis.gerekce,
    hypothesis: { type: hypothesis.type, target: hypothesis.target, confidence },
    action: 'flag',
    confidence,
    evidenceRefs: [`candidate:${traceId}`],
    temporalContext: { observedAt: frame.time },
    traceId,
  };
  if (isPlainObject(budget)) message.budget = budget;
  return message;
}

/**
 * The K0 KnowledgeObject a hypothesis candidate would become if admitted.
 * `kind: 'hypothesis'` with `origin: 'learned'` is exactly the pair K0 allows
 * and the pair it would refuse for a policy or capability, so the authority
 * boundary is exercised by the real producer rather than only by a unit test.
 */
function buildHypothesisKnowledgeObject({ candidate, hypothesis, frame, trustPolicyVersion }) {
  const confidence = confidenceOf(hypothesis);
  return {
    knowledgeId: candidate.candidateId,
    kind: 'hypothesis',
    origin: 'learned',
    version: HYPOTHESIS_OBJECT_VERSION,
    workspaceId: candidate.workspaceId,
    content: {
      claim: candidate.claim,
      type: hypothesis.type,
      target: hypothesis.target,
      severity: hypothesis.severity,
      confidence,
      referenceFrame: frame,
    },
    provenance: {
      ...candidate.provenance,
      trustPolicyVersion: text(candidate.provenance?.trustPolicyVersion)
        || text(trustPolicyVersion, DEFAULT_TRUST_POLICY_VERSION),
    },
    dependencies: [],
    confidence,
    scope: { workspaceId: candidate.workspaceId },
    status: 'active',
    supersedes: null,
    receipt: null,
  };
}

function contractError(violations) {
  const named = violations.map((item) => `${item.contract}.${item.field || '<root>'}:${item.code}`).join(', ');
  const error = new Error(`hypothesis cognition violates the K0/K1 contract: ${named}`);
  error.code = COGNITIVE_CONTRACT_VIOLATION;
  error.violations = violations;
  return error;
}

/**
 * Validate the three artifacts together and refuse the whole step on any
 * violation. Warnings (an explicit unknown) do not fail: unknown is not
 * invalid.
 */
function assertHypothesisCognition({ message, frame, knowledgeObject }) {
  const checks = {
    message: validateCognitiveMessage(message),
    frame: validateReferenceFrame(frame),
    knowledgeObject: validateKnowledgeObject(knowledgeObject),
  };
  const violations = [];
  for (const [contract, check] of Object.entries(checks)) {
    for (const item of check.errors) violations.push({ contract, ...item });
  }
  if (violations.length > 0) throw contractError(violations);
  return checks;
}

/**
 * The R49 consumer as `buildHypothesisCandidate` calls it: given the candidate
 * and the hypothesis, build the frame, the message and the K0 object, validate
 * all three together, and return them. Throws
 * `COGNITIVE_CONTRACT_VIOLATION` rather than returning a partial step, so an
 * invalid candidate is refused at the producer.
 */
function consumeHypothesisCognition(candidate, hypothesis, frameInput = {}) {
  const frame = hypothesisReferenceFrame({
    workspaceId: candidate.workspaceId,
    ...frameInput,
  });
  const cognitiveMessage = buildHypothesisCognitiveMessage({
    hypothesis,
    workspaceId: candidate.workspaceId,
    traceId: candidate.candidateId,
    frame,
    budget: frameInput.budget,
  });
  const knowledgeObject = buildHypothesisKnowledgeObject({
    candidate,
    hypothesis,
    frame,
    trustPolicyVersion: frameInput.trustPolicyVersion,
  });
  const outcome = assertHypothesisCognition({ message: cognitiveMessage, frame, knowledgeObject });
  return {
    frame,
    cognitiveMessage,
    knowledgeObject,
    warnings: outcome.message.warnings.map((item) => item.field),
  };
}

/**
 * Compare the frame a candidate was observed in against the frame it is being
 * compared to. Argument order follows K1: `expected` is what the caller
 * compares against, `stored` is what the candidate actually carries.
 */
function compareHypothesisFrames(expected, stored) {
  return compareReferenceFrames(expected, stored);
}

module.exports = Object.freeze({
  COGNITIVE_CONTRACT_VIOLATION,
  COGNITIVE_SOURCE,
  DECLARED_UNKNOWN,
  DEFAULT_GOAL,
  assertHypothesisCognition,
  buildHypothesisCognitiveMessage,
  buildHypothesisKnowledgeObject,
  compareHypothesisFrames,
  confidenceOf,
  consumeHypothesisCognition,
  hypothesisReferenceFrame,
});
