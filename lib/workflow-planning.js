'use strict';

/**
 * Workflow planning — the pure tool-ranking and step-shaping functions the
 * `WorkflowAgent` class orchestrates (#2378 extraction).
 *
 * Extracted from `workflow-agent.js` with no behaviour change so that file
 * stays under the 400-line gate and the runtime seam wiring in #2378 has a
 * line budget to land in. Everything here is pure: it reads a goal and a tool
 * list and returns a ranking, a default, or a step input. No I/O, no registry,
 * no class state.
 */

const { normalizeName, normalizeConfidence, foldText, tokenize } = require('./workflow-values');

const DEFAULT_MAX_STEPS = 4;

/**
 * Default cost ceiling for a run.
 *
 * This was `null`, which `resolveBudget` turns into `Infinity` -- so every
 * caller that did not pass a budget got an unlimited one, and the budget
 * check below (`stepCost > budgetRemaining`) could never fire. The protection
 * existed but was off for everyone, which is the failure mode least likely to
 * be noticed: nothing errors, runs just never stop for cost.
 *
 * The scale: a registered tool's cost defaults to 1 and `DEFAULT_MAX_STEPS` is
 * 4, so an ordinary run spends about 4. 100 leaves roughly 25x headroom, so it
 * only bites on a genuinely expensive tool or a runaway cost, not on normal
 * work. A caller that needs more passes `budget` explicitly; a caller that
 * genuinely wants no ceiling can still opt in via `resolveBudget(value, null)`,
 * which remains an explicit choice rather than a silent default.
 */
const DEFAULT_BUDGET = 100;

function resolveBudget(value, fallback = DEFAULT_BUDGET) {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) return num;
  if (fallback === null || fallback === undefined) return Number.POSITIVE_INFINITY;
  const fallbackNum = Number(fallback);
  if (Number.isFinite(fallbackNum) && fallbackNum >= 0) return fallbackNum;
  return Number.POSITIVE_INFINITY;
}

function objectiveForGoal(goal) {
  const text = foldText(goal);
  if (!text) return 'inspect';
  if (/(learn|ingest|teach|kaydet|ogren|ogret)/.test(text)) return 'learn';
  if (/(compare|karsilastir|kiyas|vs|fark)/.test(text)) return 'compare';
  if (/(why|neden|niye|cau|reason|explain)/.test(text)) return 'reason';
  if (/(discover|discovery|hypothesis|experiment|replicat|replication|analy[sz]e|result|evidence|bilim|deney|hipotez|kesif)/.test(text)) return 'discover';
  if (/(verify|dogrula|check|kontrol|test|true|false|mi|\?)/.test(text)) return 'verify';
  if (/(plan|workflow|task|goal|agent|adim)/.test(text)) return 'plan';
  return 'inspect';
}

// #2132: one preferred tool order per objective; a new objective is a row, not a case.
const OBJECTIVE_SEQUENCES = Object.freeze(Object.assign(Object.create(null), {
  learn: ['learn', 'verify', 'ask'],
  compare: ['ask', 'compare', 'verify'],
  reason: ['ask', 'reason', 'verify'],
  discover: ['discoveryengine', 'experimentplanner', 'resultanalyzer', 'replicationchecker'],
  verify: ['ask', 'verify', 'reason'],
  plan: ['ask', 'reason', 'verify'],
}));
const DEFAULT_SEQUENCE = ['ask', 'verify', 'reason'];

function preferredSequence(objective) {
  return [...(Object.hasOwn(OBJECTIVE_SEQUENCES, objective) ? OBJECTIVE_SEQUENCES[objective] : DEFAULT_SEQUENCE)];
}

function scoreTool(tool, goalText, objective, sequenceIndex) {
  const name = normalizeName(tool.name);
  const desc = foldText(tool.description || '');
  const goal = foldText(goalText);
  const goalTokens = tokenize(goalText);

  let score = 0;
  const reasons = [];

  if (sequenceIndex >= 0) {
    score += Math.max(0, 120 - sequenceIndex * 15);
    reasons.push('objective-sequence');
  }

  if (name === objective) {
    score += 20;
    reasons.push('objective-match');
  }

  if (name === 'ask' && /\?/.test(goalText)) {
    score += 25;
    reasons.push('question-context');
  }

  if (name === 'verify' && /(verify|dogrula|check|kontrol|mi|\?)/.test(goal)) {
    score += 35;
    reasons.push('verification-signal');
  }

  if (name === 'reason' && /(why|neden|niye|reason|explain)/.test(goal)) {
    score += 35;
    reasons.push('reasoning-signal');
  }

  if (name === 'compare' && /(compare|karsilastir|kiyas|vs|fark)/.test(goal)) {
    score += 35;
    reasons.push('comparison-signal');
  }

  if (name === 'learn' && /(learn|ingest|teach|kaydet|ogren|ogret)/.test(goal)) {
    score += 35;
    reasons.push('learning-signal');
  }

  if (objective === 'discover' && /(discover|discovery|hypothesis|experiment|replicat|replication|analy[sz]e|result|evidence|bilim|deney|hipotez|kesif)/.test(goal)) {
    score += 30;
    reasons.push('discovery-signal');
  }

  for (const token of goalTokens) {
    if (token && name.includes(token)) {
      score += 6;
      reasons.push('name-token-match');
      break;
    }
  }

  for (const token of goalTokens) {
    if (token && desc.includes(token)) {
      score += 4;
      reasons.push('description-token-match');
      break;
    }
  }

  if (tool.kind === 'external') {
    score -= 15;
    reasons.push('external-tool');
  }

  score += Math.max(0, 8 - tool.order);

  return {
    score,
    reasons,
    confidence: normalizeConfidence(0.45 + Math.min(score, 140) / 250, 0.45),
  };
}

function buildStepInput(goal, objective, toolName, index, total) {
  const tool = normalizeName(toolName);
  const base = {
    goal,
    objective,
    tool: toolName,
    stepIndex: index,
    totalSteps: total,
    request: goal,
  };

  if (tool === 'discoveryengine') {
    return {
      ...base,
      text: goal,
      hypothesis: goal,
    };
  }

  if (tool === 'experimentplanner') {
    return {
      ...base,
      text: goal,
      hypothesis: goal,
    };
  }

  if (tool === 'resultanalyzer') {
    return {
      ...base,
      text: goal,
      result: goal,
      observation: goal,
    };
  }

  if (tool === 'replicationchecker') {
    return {
      ...base,
      text: goal,
      observations: [goal],
      runs: [{ id: `run-${index + 1}`, text: goal }],
    };
  }

  return {
    ...base,
  };
}

module.exports = Object.freeze({
  DEFAULT_MAX_STEPS,
  DEFAULT_BUDGET,
  resolveBudget,
  objectiveForGoal,
  OBJECTIVE_SEQUENCES,
  DEFAULT_SEQUENCE,
  preferredSequence,
  scoreTool,
  buildStepInput,
});
