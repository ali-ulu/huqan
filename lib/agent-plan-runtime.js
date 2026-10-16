'use strict';

const { normalizeGoal, firstWords } = require('./agent-memory-state');
const { prepareGoalIntegrityForPlan } = require('./goal-integrity-gate');
const { planningPolicy, objectiveForGoal, planSteps } = require('./agent-planning-policy');

function buildAgentPlan({ goal, opts = {}, runtime }) {
  const { memory, maxSteps, goalKey, findResumeRun, emit, rememberPlan, ok, setLastPlan, setActiveGoal } = runtime;
  const objective = objectiveForGoal(goal);
  const cleanedGoal = normalizeGoal(goal);
  const goalIntegrity = prepareGoalIntegrityForPlan(runtime.agent, cleanedGoal, opts);
  if (!goalIntegrity.ok) return goalIntegrity.result;
  const policy = planningPolicy({ goal: cleanedGoal, objective, memory });
  const steps = planSteps(objective, cleanedGoal);
  const plan = {
    goal: cleanedGoal,
    objective,
    shortGoal: firstWords(cleanedGoal, 5),
    steps: steps.slice(0, Math.max(1, opts.maxSteps || maxSteps)),
    selectedTools: [...policy.selectedTools],
    maxSteps: Math.max(1, opts.maxSteps || maxSteps),
    status: 'planned',
    confidence: objective === 'investigate' ? 0.58 : 0.74,
    policy,
    goalIntegrity: goalIntegrity.scope,
    memory: {
      knownGoals: memory.goals.length,
      previousRuns: memory.runs.filter(run => run?.key === goalKey(cleanedGoal)).length,
      resumed: Boolean(findResumeRun(cleanedGoal)),
    },
    rationale: objective === 'investigate'
      ? 'The overall objective is unclear; gather context first, then decide.'
      : 'The objective signal is clear; the relevant tools were ordered.',
  };
  setLastPlan(plan);
  setActiveGoal(cleanedGoal);
  emit('beforePlan', plan);
  emit('afterPlan', plan);
  rememberPlan(plan);
  return ok('plan', plan, [], { objective });
}

module.exports = { buildAgentPlan };
