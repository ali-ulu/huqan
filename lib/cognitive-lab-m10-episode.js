'use strict';

/**
 * #4071 COG-M10 Lab episode: one holdout group x one arm.
 *
 * The episode runs the real dream→verify path, not a simulation of it: the
 * group's true facts are seeded into a fresh Kernel graph, the Dream loop
 * selects hypotheses through lib/agent-v3-dream-loop-adapter, and every
 * verification step is executed through lib/agent-step-executor (firewall +
 * kernel.verify). Only the group's candidate pool is injected as the dream
 * result; the loop's own transition/persistence code is untouched.
 *
 * The arm is `candidate` (curiosity ranker + monitoring history) or `control`
 * (flag off: the legacy confidence order). Both arms share the same budget.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');
const { createInitialState } = require('./dream-experiment-loop');
const { processDreamStep } = require('./agent-v3-dream-loop-adapter');
const { executeAgentStep } = require('./agent-step-executor');

const WORKSPACE = 'default';
const MAX_HYPOTHESES = 3;
const MAX_CYCLES = 1;
const round6 = (value) => Math.round(value * 1e6) / 1e6;

function seedFacts(kernel, group) {
  for (const candidate of group.candidates) {
    if (!candidate.oracle) continue;
    kernel.graph.addNode(candidate.from, candidate.from, null, { workspaceId: WORKSPACE });
    kernel.graph.addNode(candidate.to, candidate.to, null, { workspaceId: WORKSPACE });
    kernel.graph.addEdge(candidate.from, candidate.to, candidate.relation, { workspaceId: WORKSPACE });
  }
}

/**
 * @param {{group: object, history: Array, arm: 'candidate'|'control'}} input
 * @returns {object} the per-group execution record the evaluator consumes
 */
function runM10Episode({ group, history, arm } = {}) {
  if (!group || !Array.isArray(group.candidates) || !['candidate', 'control'].includes(arm)) {
    throw new TypeError('M10_EPISODE_INPUT_INVALID');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m10-episode-'));
  const kernel = new Kernel({ useSQLite: false, loadPlugins: false, memoryPath: path.join(directory, 'graph.json') });
  try {
    seedFacts(kernel, group);
    const goal = `m10 ${group.sourceGroup}`;
    const options = {
      workspaceId: WORKSPACE, goal, curiosity: arm === 'candidate',
      curiosityHistory: arm === 'candidate' ? history : undefined,
      maxHypotheses: MAX_HYPOTHESES, maxCycles: MAX_CYCLES,
      experimentId: `m10-${group.sourceGroup}-${arm}`,
    };
    const agentState = { workspaceId: WORKSPACE, agentId: `m10-${arm}`, goal, steps: [], iteration: 0 };
    const shapeOf = (item) => `${item.from}|${item.relation}|${item.to}`;
    const byShape = new Map(group.candidates.map((candidate) => [shapeOf(candidate), candidate]));
    let loopState = createInitialState({ workspaceId: WORKSPACE, goal, maxHypotheses: MAX_HYPOTHESES, maxCycles: MAX_CYCLES });
    let dream = processDreamStep(kernel, loopState, { step: { tool: 'dream', input: {} }, report: { result: group.candidates } }, options);
    loopState = dream.state;
    const attempts = [];
    let next = dream.nextStep;
    while (next) {
      const key = next.dreamExperiment?.hypothesisKey;
      const report = executeAgentStep({
        step: next, state: { ...agentState, steps: [next] }, opts: {},
        runtime: { kernel, allowedTools: new Set(['verify']), emit: () => {} },
      });
      const status = report?.result?.data?.status;
      const hypothesis = loopState.hypotheses.find((item) => item.key === key) || null;
      const candidate = hypothesis ? byShape.get(shapeOf(hypothesis)) : null;
      attempts.push({
        key, region: hypothesis?.region ?? candidate?.region ?? null, confidence: hypothesis?.confidence ?? 0,
        status: typeof status === 'string' && status ? status : 'unknown',
        difficulty: candidate?.difficulty ?? group.difficulty,
        blocked: report?.status === 'blocked',
      });
      const advanced = processDreamStep(kernel, loopState, { step: next, report }, options);
      loopState = advanced.state;
      next = advanced.nextStep;
      if (advanced.blocked) break;
    }
    const verified = attempts.filter((attempt) => attempt.status === 'verified').length;
    const errorSum = attempts.reduce((sum, attempt) =>
      sum + Math.abs(attempt.confidence - (attempt.status === 'verified' ? 1 : 0)), 0);
    const selectedDifficulty = attempts.length
      ? attempts.reduce((sum, attempt) => sum + attempt.difficulty, 0) / attempts.length
      : group.difficulty;
    return {
      sourceGroup: group.sourceGroup, arm, attempted: attempts.length, verified,
      errorSum: round6(errorSum), selectedDifficulty: round6(selectedDifficulty),
      blockedSteps: attempts.filter((attempt) => attempt.blocked).length,
      curiosityStatus: loopState.curiosity?.status ?? null,
      attempts,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { runM10Episode, WORKSPACE, MAX_HYPOTHESES, MAX_CYCLES };
