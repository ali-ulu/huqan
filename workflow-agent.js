const { INTERNAL_TOOLS, evaluateToolPolicy } = require('./toolPolicy');
const { buildFinalSummary } = require('./finalizer');

const DEFAULT_MAX_STEPS = 4;
const DEFAULT_BUDGET = null;

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

function normalizeConfidence(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return clamp01(fallback);
  return clamp01(num);
}

function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(value) {
  return foldText(value)
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function normalizeEvidenceItem(item) {
  if (item === undefined || item === null) return null;
  if (Array.isArray(item)) {
    return item.map(normalizeEvidenceItem).filter(Boolean);
  }
  if (typeof item === 'string') {
    return { type: 'text', value: item };
  }
  if (typeof item !== 'object') {
    return { type: 'value', value: item };
  }
  const normalized = cloneValue(item);
  if (Object.prototype.hasOwnProperty.call(normalized, 'confidence')) {
    normalized.confidence = normalizeConfidence(normalized.confidence, 0);
  }
  return normalized;
}

function normalizeEvidence(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap(normalizeEvidenceItem).filter(Boolean);
}

function normalizeError(error, fallbackCode = 'ERROR', fallbackMessage = 'Tool execution failed.') {
  if (!error) {
    return { code: fallbackCode, message: fallbackMessage };
  }
  if (typeof error === 'string') {
    return { code: fallbackCode, message: error };
  }
  const code = error.code || fallbackCode;
  const message = error.message || fallbackMessage;
  return { code: String(code), message: String(message) };
}

function extractText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return String(value);
  const candidates = [
    value.finalAnswer,
    value.answer,
    value.summary,
    value.explanation,
    value.reason,
    value.text,
    value.output,
    value.result,
    value.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function resolveBudget(value, fallback = DEFAULT_BUDGET) {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) return num;
  if (fallback === null || fallback === undefined) return Number.POSITIVE_INFINITY;
  const fallbackNum = Number(fallback);
  if (Number.isFinite(fallbackNum) && fallbackNum >= 0) return fallbackNum;
  return Number.POSITIVE_INFINITY;
}

function normalizePositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
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

function preferredSequence(objective) {
  switch (objective) {
    case 'learn':
      return ['learn', 'verify', 'ask'];
    case 'compare':
      return ['ask', 'compare', 'verify'];
    case 'reason':
      return ['ask', 'reason', 'verify'];
    case 'discover':
      return ['discoveryengine', 'experimentplanner', 'resultanalyzer', 'replicationchecker'];
    case 'verify':
      return ['ask', 'verify', 'reason'];
    case 'plan':
      return ['ask', 'reason', 'verify'];
    default:
      return ['ask', 'verify', 'reason'];
  }
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

function buildReport(run) {
  const finalSummary = run.finalSummary || buildFinalSummary(run);
  const lines = [
    `Goal: ${run.goal}`,
    `Objective: ${run.objective}`,
    `Status: ${run.status}`,
    `Steps: ${run.steps.length}`,
    `Confidence: ${run.confidence.toFixed(2)}`,
    `Next action: ${run.nextAction.action}${run.nextAction.tool ? ` -> ${run.nextAction.tool}` : ''}`,
    'Final summary:',
    `- Mode: ${finalSummary.mode}`,
    'Known facts:',
    ...(finalSummary.knownFacts.length ? finalSummary.knownFacts.map(item => `- ${item}`) : ['- none']),
    'Unknowns:',
    ...(finalSummary.unknowns.length ? finalSummary.unknowns.map(item => `- ${item}`) : ['- none']),
    `- Conclusion: ${finalSummary.conclusion}`,
    'Next questions:',
    ...(finalSummary.nextQuestions.length ? finalSummary.nextQuestions.map(item => `- ${item}`) : ['- none']),
    'Recommendations:',
    ...run.recommendations.map(item => `- ${item}`),
    'Trace:',
    ...run.trace.map(item => {
      const step = item.stepId ? `${item.stepId}: ` : '';
      const tool = item.tool ? `${item.tool}` : 'n/a';
      const status = item.status ? ` ${item.status}` : '';
      const score = Number.isFinite(item.score) ? ` score=${item.score}` : '';
      return `- ${step}${tool}${status}${score}`;
    }),
    `Final answer: ${run.finalAnswer || 'n/a'}`,
  ];
  return lines.join('\n');
}

function deriveNextAction(run, remainingSteps) {
  const nextStep = Array.isArray(remainingSteps) && remainingSteps.length ? remainingSteps[0] : null;

  if (run.status === 'completed') {
    return { action: 'none', tool: null, reason: 'Workflow completed.' };
  }
  if (run.status === 'paused') {
    return {
      action: 'resume',
      tool: nextStep ? nextStep.tool : null,
      reason: 'Step or budget limit reached.',
    };
  }
  if (run.status === 'blocked') {
    return {
      action: 'revise',
      tool: null,
      reason: 'Unknown or blocked tool must be replaced.',
    };
  }
  if (run.status === 'partial') {
    return {
      action: 'repair',
      tool: nextStep ? nextStep.tool : (run.steps[run.steps.length - 1] ? run.steps[run.steps.length - 1].tool : null),
      reason: 'A step failed; retry or simplify the plan.',
    };
  }
  if (run.status === 'failed') {
    return {
      action: 'repair',
      tool: null,
      reason: 'No step completed successfully.',
    };
  }

  return {
    action: 'continue',
    tool: nextStep ? nextStep.tool : null,
    reason: 'Continue the planned workflow.',
  };
}

function buildRecommendations(run) {
  const recommendations = [];

  if (run.status === 'completed') {
    recommendations.push('No immediate action required.');
  }
  if (run.status === 'paused') {
    recommendations.push('Resume from the remaining steps.');
    recommendations.push('Increase maxSteps or budget only if needed.');
  }
  if (run.status === 'partial') {
    recommendations.push('Inspect the failing tool and narrow the goal scope.');
    recommendations.push('Retry with a smaller plan if the failure is transient.');
  }
  if (run.status === 'failed') {
    recommendations.push('No tool completed successfully; revise the plan before retrying.');
  }
  if (run.status === 'blocked') {
    recommendations.push('Replace the unknown or blocked tool with a registered internal tool.');
  }
  if (run.evidence.length === 0) {
    recommendations.push('Add at least one tool that can produce evidence.');
  }
  if (run.confidence < 0.7) {
    recommendations.push('Collect more evidence before concluding.');
  }
  if (run.trace.some(item => item.policyAction === 'review')) {
    recommendations.push('Review policy-gated tools before re-running.');
  }

  return Array.from(new Set(recommendations));
}

function normalizeToolOutput(result, tool, policy, meta = {}) {
  const hasEnvelope = result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok');
  const envelope = hasEnvelope ? result : { ok: true, data: result };
  const ok = Boolean(envelope.ok);
  const data = envelope.data !== undefined ? cloneValue(envelope.data) : cloneValue(envelope);
  const error = ok ? null : normalizeError(envelope.error, 'TOOL_ERROR', 'Tool execution failed.');
  const evidence = normalizeEvidence(envelope.evidence || data?.evidence || []);
  const confidenceSource = envelope.confidence ?? envelope.meta?.confidence ?? data?.confidence ?? meta.confidence;
  const confidence = normalizeConfidence(confidenceSource, ok ? 0.55 : 0);

  return {
    ok,
    tool: tool.name,
    status: policy && policy.blocked
      ? 'blocked'
      : policy && policy.review && !meta.approved
        ? 'review'
        : ok
          ? 'done'
          : 'error',
    inputSchema: cloneValue(tool.inputSchema),
    description: tool.description,
    data,
    output: data,
    evidence,
    confidence,
    error,
    meta: {
      tool: {
        name: tool.name,
        description: tool.description,
        inputSchema: cloneValue(tool.inputSchema),
        kind: tool.kind,
        cost: tool.cost,
      },
      policy: cloneValue(policy),
    },
  };
}

class ToolRegistry {
  constructor(opts = {}) {
    this._tools = [];
    this._order = 0;
    this._internalTools = new Set([
      ...Array.from(INTERNAL_TOOLS || []),
      ...Array.isArray(opts.internalTools) ? opts.internalTools.map(normalizeName) : [],
    ].map(normalizeName));
  }

  _cloneTool(tool) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: cloneValue(tool.inputSchema),
      kind: tool.kind,
      cost: tool.cost,
      order: tool.order,
      tags: Array.isArray(tool.tags) ? [...tool.tags] : [],
      registeredAt: tool.registeredAt,
    };
  }

  registerTool(tool = {}) {
    const name = normalizeName(tool.name);
    if (!name) {
      throw new Error('Tool name is required.');
    }
    if (typeof tool.run !== 'function') {
      throw new Error(`Tool ${name} must define run(context, input).`);
    }

    const record = {
      name,
      description: String(tool.description || ''),
      inputSchema: tool.inputSchema ? cloneValue(tool.inputSchema) : { type: 'object' },
      run: tool.run,
      kind: tool.kind === 'external' ? 'external' : 'internal',
      cost: normalizePositiveInteger(tool.cost, 1),
      order: Number.isFinite(tool.order) ? Number(tool.order) : this._order,
      tags: Array.isArray(tool.tags) ? [...tool.tags] : [],
      registeredAt: this._order,
    };
    this._order += 1;

    const existingIndex = this._tools.findIndex(entry => entry.name === name);
    if (existingIndex >= 0) {
      record.order = this._tools[existingIndex].order;
      record.registeredAt = this._tools[existingIndex].registeredAt;
      this._tools[existingIndex] = record;
    } else {
      this._tools.push(record);
    }

    return this._cloneTool(record);
  }

  listTools() {
    return [...this._tools]
      .sort((a, b) => a.order - b.order)
      .map(tool => this._cloneTool(tool));
  }

  getTool(name) {
    const normalized = normalizeName(name);
    const tool = this._tools.find(entry => entry.name === normalized);
    return tool ? this._cloneTool(tool) : null;
  }

  _getToolRecord(name) {
    const normalized = normalizeName(name);
    return this._tools.find(entry => entry.name === normalized) || null;
  }

  _policyInternalTools() {
    const names = new Set([...this._internalTools]);
    for (const tool of this._tools) {
      if (tool.kind !== 'external') {
        names.add(tool.name);
      }
    }
    return names;
  }

  runTool(name, input, context = {}) {
    const tool = this._getToolRecord(name);
    if (!tool) {
      const policy = evaluateToolPolicy({
        tool: name,
        input,
        context,
        internalTools: this._policyInternalTools(),
      });
      return {
        ok: false,
        tool: normalizeName(name),
        status: 'blocked',
        inputSchema: null,
        description: '',
        data: null,
        output: null,
        evidence: [],
        confidence: 0,
        error: normalizeError({ code: 'UNKNOWN_TOOL', message: `Unknown tool: ${String(name)}` }, 'UNKNOWN_TOOL', `Unknown tool: ${String(name)}`),
        meta: {
          tool: null,
          policy,
        },
      };
    }

    const policy = evaluateToolPolicy({
      tool: tool.name,
      input,
      context,
      internalTools: this._policyInternalTools(),
    });
    const approved = Boolean(context.approved || context.allowReview);

    if (tool.kind === 'external' && policy.blocked) {
      return normalizeToolOutput({
        ok: false,
        error: {
          code: 'TOOL_BLOCKED',
          message: policy.reasons[0] || `Tool ${tool.name} is blocked.`,
        },
        evidence: [],
        meta: { policy },
      }, tool, policy, context);
    }

    if (tool.kind === 'external' && policy.review && !approved) {
      return normalizeToolOutput({
        ok: false,
        error: {
          code: 'TOOL_REVIEW_REQUIRED',
          message: policy.reasons[0] || `Tool ${tool.name} requires review.`,
        },
        evidence: [],
        meta: { policy },
      }, tool, policy, context);
    }

    try {
      const result = tool.run(cloneValue(context), cloneValue(input));
      return normalizeToolOutput(result, tool, policy, context);
    } catch (error) {
      return normalizeToolOutput({
        ok: false,
        error: normalizeError(error, 'TOOL_ERROR', `Tool ${tool.name} threw an error.`),
        evidence: [],
        meta: { policy },
      }, tool, policy, context);
    }
  }
}

class WorkflowAgent {
  constructor(opts = {}) {
    this.maxSteps = normalizePositiveInteger(opts.maxSteps, DEFAULT_MAX_STEPS);
    this.budget = resolveBudget(opts.budget, DEFAULT_BUDGET);
    this.registry = opts.registry instanceof ToolRegistry
      ? opts.registry
      : new ToolRegistry({ internalTools: opts.internalTools || [] });
    this.lastPlan = null;
    this.lastRun = null;

    if (Array.isArray(opts.tools)) {
      for (const tool of opts.tools) {
        this.registerTool(tool);
      }
    }
  }

  registerTool(tool) {
    return this.registry.registerTool(tool);
  }

  listTools() {
    return this.registry.listTools();
  }

  getTool(name) {
    return this.registry.getTool(name);
  }

  runTool(name, input, context = {}) {
    return this.registry.runTool(name, input, context);
  }

  _rankTools(goal, tools, objective) {
    const sequence = preferredSequence(objective);
    const goalText = String(goal || '');
    const ranked = tools.map(tool => {
      const preferredIndex = sequence.indexOf(tool.name);
      const base = scoreTool(tool, goalText, objective, preferredIndex);
      return {
        tool,
        score: base.score,
        confidence: base.confidence,
        reasons: base.reasons,
        preferredIndex,
      };
    });

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.tool.order !== b.tool.order) return a.tool.order - b.tool.order;
      return a.tool.name.localeCompare(b.tool.name);
    });

    return ranked;
  }

  _selectStepTools(goal, rankedTools, objective, maxSteps, budget) {
    const sequence = preferredSequence(objective);
    const selected = [];
    const used = new Set();
    let estimatedBudget = 0;

    for (const preferredName of sequence) {
      if (selected.length >= maxSteps) break;
      const match = rankedTools.find(item => item.tool.name === preferredName);
      if (!match || used.has(match.tool.name)) continue;
      if (estimatedBudget + match.tool.cost > budget) break;
      selected.push(match);
      used.add(match.tool.name);
      estimatedBudget += match.tool.cost;
    }

    for (const item of rankedTools) {
      if (selected.length >= maxSteps) break;
      if (used.has(item.tool.name)) continue;
      if (estimatedBudget + item.tool.cost > budget) break;
      selected.push(item);
      used.add(item.tool.name);
      estimatedBudget += item.tool.cost;
    }

    if (!selected.length && rankedTools.length) {
      const first = rankedTools[0];
      if (first.tool.cost <= budget) {
        selected.push(first);
      }
    }

    return selected;
  }

  _buildPlan(goal, opts = {}) {
    const normalizedGoal = String(goal || '').trim();
    const objective = objectiveForGoal(normalizedGoal);
    const maxSteps = normalizePositiveInteger(opts.maxSteps, this.maxSteps);
    const budget = resolveBudget(opts.budget, this.budget);
    const tools = this.listTools();
    const rankedTools = this._rankTools(normalizedGoal, tools, objective);
    const selectedTools = this._selectStepTools(normalizedGoal, rankedTools, objective, maxSteps, budget);

    const steps = selectedTools.map((item, index) => ({
      id: `step-${index + 1}`,
      tool: item.tool.name,
      input: buildStepInput(normalizedGoal, objective, item.tool.name, index, selectedTools.length),
      status: 'planned',
      evidence: [],
      confidence: item.confidence,
      cost: item.tool.cost,
      reason: item.reasons.join(', '),
    }));

    const trace = rankedTools.map(item => ({
      phase: 'plan',
      tool: item.tool.name,
      score: item.score,
      confidence: item.confidence,
      reasons: item.reasons,
    }));

    const confidence = steps.length
      ? normalizeConfidence(steps.reduce((sum, step) => sum + step.confidence, 0) / steps.length, 0.5)
      : 0;

    const plan = {
      ok: true,
      goal: normalizedGoal,
      objective,
      status: 'planned',
      maxSteps,
      budget,
      selectedTools: steps.map(step => step.tool),
      steps,
      evidence: [],
      confidence,
      trace,
      errors: [],
      report: buildReport({
        goal: normalizedGoal,
        objective,
        status: 'planned',
        steps,
        confidence,
        nextAction: { action: 'run', tool: steps[0] ? steps[0].tool : null, reason: 'Plan ready.' },
        recommendations: ['Run the selected tools in order.'],
        trace,
        finalAnswer: '',
      }),
      nextAction: {
        action: 'run',
        tool: steps[0] ? steps[0].tool : null,
        reason: 'Plan ready.',
      },
      recommendations: ['Run the selected tools in order.'],
      finalAnswer: '',
      toolScores: rankedTools.map(item => ({
        tool: item.tool.name,
        score: item.score,
        confidence: item.confidence,
        reasons: item.reasons,
      })),
    };

    this.lastPlan = cloneValue(plan);
    return cloneValue(plan);
  }

  plan(goal, opts = {}) {
    return this._buildPlan(goal, opts);
  }

  _normalizePlanInput(goal, opts = {}) {
    if (opts.plan && typeof opts.plan === 'object' && Array.isArray(opts.plan.steps)) {
      const plan = cloneValue(opts.plan);
      plan.goal = String(plan.goal || goal || '').trim();
      plan.objective = String(plan.objective || objectiveForGoal(plan.goal));
      plan.status = plan.status || 'planned';
      plan.maxSteps = normalizePositiveInteger(plan.maxSteps, this.maxSteps);
      plan.budget = resolveBudget(plan.budget, this.budget);
      plan.selectedTools = Array.isArray(plan.selectedTools) ? [...plan.selectedTools] : plan.steps.map(step => step.tool).filter(Boolean);
      plan.steps = plan.steps.map((step, index) => ({
        id: String(step.id || `step-${index + 1}`),
        tool: normalizeName(step.tool),
        input: step.input !== undefined ? cloneValue(step.input) : buildStepInput(plan.goal, plan.objective, step.tool, index, plan.steps.length),
        status: step.status || 'planned',
        evidence: Array.isArray(step.evidence) ? cloneValue(step.evidence) : [],
        confidence: normalizeConfidence(step.confidence, 0.5),
        cost: normalizePositiveInteger(step.cost, 1),
        reason: String(step.reason || ''),
      }));
      plan.trace = Array.isArray(plan.trace) ? cloneValue(plan.trace) : [];
      plan.errors = Array.isArray(plan.errors) ? cloneValue(plan.errors) : [];
      plan.evidence = Array.isArray(plan.evidence) ? cloneValue(plan.evidence) : [];
      plan.report = String(plan.report || '');
      plan.nextAction = plan.nextAction && typeof plan.nextAction === 'object' ? cloneValue(plan.nextAction) : null;
      plan.recommendations = Array.isArray(plan.recommendations) ? [...plan.recommendations] : [];
      plan.finalAnswer = String(plan.finalAnswer || '');
      return plan;
    }

    if (Array.isArray(opts.steps)) {
      return this._normalizePlanInput(goal, {
        ...opts,
        plan: {
          goal,
          steps: opts.steps,
          selectedTools: opts.steps.map(step => step.tool).filter(Boolean),
          maxSteps: opts.maxSteps,
          budget: opts.budget,
        },
      });
    }

    return this.plan(goal, opts);
  }

  run(goal, opts = {}) {
    const plan = this._normalizePlanInput(goal, opts);
    const maxSteps = normalizePositiveInteger(opts.maxSteps, plan.maxSteps || this.maxSteps);
    const budget = resolveBudget(opts.budget, plan.budget ?? this.budget);
    const steps = [];
    const evidence = [];
    const trace = Array.isArray(plan.trace) ? cloneValue(plan.trace) : [];
    const errors = [];
    const planSteps = Array.isArray(plan.steps) ? cloneValue(plan.steps) : [];
    const allTools = this.listTools();
    const selectedToolNames = Array.from(new Set(planSteps.map(step => step.tool).filter(Boolean)));
    let budgetRemaining = budget;
    let sawSuccess = false;
    let sawError = false;
    let sawBlocked = false;
    let sawReview = false;
    let paused = false;

    for (let index = 0; index < planSteps.length; index += 1) {
      if (steps.length >= maxSteps) {
        paused = true;
        break;
      }

      const plannedStep = planSteps[index];
      const registryTool = this.getTool(plannedStep.tool);
      const stepCost = normalizePositiveInteger(plannedStep.cost, registryTool ? registryTool.cost : 1);
      if (stepCost > budgetRemaining) {
        paused = true;
        break;
      }

      const context = {
        goal: plan.goal,
        objective: plan.objective,
        plan,
        step: plannedStep,
        stepIndex: index,
        maxSteps,
        budgetRemaining,
        approved: Boolean(opts.approved),
      };
      const result = this.runTool(plannedStep.tool, plannedStep.input, context);
      budgetRemaining -= stepCost;

      const step = {
        id: plannedStep.id,
        tool: result.tool || normalizeName(plannedStep.tool),
        input: cloneValue(plannedStep.input),
        output: cloneValue(result.output),
        status: result.status,
        evidence: normalizeEvidence(result.evidence),
        confidence: normalizeConfidence(result.confidence, 0),
        error: result.error ? cloneValue(result.error) : null,
        policy: result.meta ? cloneValue(result.meta.policy) : null,
        trace: [
          {
            phase: 'run',
            stepId: plannedStep.id,
            tool: result.tool || normalizeName(plannedStep.tool),
            status: result.status,
            evidenceCount: normalizeEvidence(result.evidence).length,
            confidence: normalizeConfidence(result.confidence, 0),
            policyAction: result.meta && result.meta.policy ? result.meta.policy.action : 'allow',
            riskScore: result.meta && result.meta.policy ? result.meta.policy.riskScore : 0,
            score: plannedStep.confidence,
          },
        ],
      };

      steps.push(step);
      trace.push(step.trace[0]);
      evidence.push(...step.evidence);

      if (step.status === 'done') {
        sawSuccess = true;
      } else if (step.status === 'blocked') {
        sawBlocked = true;
        if (result.error) errors.push({ stepId: step.id, tool: step.tool, code: result.error.code, message: result.error.message });
        break;
      } else if (step.status === 'review') {
        sawReview = true;
        if (result.error) errors.push({ stepId: step.id, tool: step.tool, code: result.error.code, message: result.error.message });
        break;
      } else {
        sawError = true;
        if (result.error) errors.push({ stepId: step.id, tool: step.tool, code: result.error.code, message: result.error.message });
        break;
      }
    }

    if (!steps.length && planSteps.length) {
      // If the first step never ran because of budget or max-step limits, report it as paused.
      paused = true;
    }

    const completedAllPlannedSteps = planSteps.length > 0 && steps.length === planSteps.length && !sawBlocked && !sawReview && !sawError && !paused;
    let status = 'blocked';
    if (completedAllPlannedSteps) {
      status = 'completed';
    } else if (paused) {
      status = 'paused';
    } else if (sawBlocked) {
      status = steps.length > 1 ? 'partial' : 'blocked';
    } else if (sawReview) {
      status = 'partial';
    } else if (sawError) {
      status = steps.some(step => step.status === 'done') ? 'partial' : 'failed';
    } else if (steps.some(step => step.status === 'done')) {
      status = 'partial';
    } else if (!planSteps.length) {
      status = 'blocked';
      errors.push({ stepId: null, tool: null, code: 'NO_STEPS', message: 'Plan does not contain any executable steps.' });
    }

    const successfulSteps = steps.filter(step => step.status === 'done');
    const confidence = steps.length
      ? normalizeConfidence(steps.reduce((sum, step) => sum + step.confidence, 0) / steps.length, 0)
      : normalizeConfidence(plan.confidence, 0);
    const finalText = [...steps].reverse().map(step => extractText(step.output)).find(Boolean) || '';
    const finalAnswer = finalText || (status === 'completed'
      ? 'Workflow completed.'
      : 'Workflow did not produce a final answer.');
    const run = {
      ok: status === 'completed',
      goal: plan.goal,
      objective: plan.objective,
      status,
      maxSteps,
      budget,
      budgetRemaining,
      selectedTools: selectedToolNames,
      steps,
      evidence,
      confidence,
      trace,
      errors,
      report: '',
      nextAction: null,
      recommendations: [],
      finalAnswer,
      plan: cloneValue(plan),
      tools: allTools,
    };

    run.nextAction = deriveNextAction(run, planSteps.slice(steps.length));
    run.recommendations = buildRecommendations(run);
    run.finalSummary = buildFinalSummary(run);
    run.report = buildReport(run);

    this.lastRun = cloneValue(run);
    return cloneValue(run);
  }
}

module.exports = WorkflowAgent;
module.exports.WorkflowAgent = WorkflowAgent;
module.exports.ToolRegistry = ToolRegistry;
module.exports.normalizeConfidence = normalizeConfidence;
module.exports.normalizeEvidence = normalizeEvidence;
module.exports.normalizeError = normalizeError;

