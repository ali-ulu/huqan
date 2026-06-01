const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Dream = require('./dream');
const { INTERNAL_TOOLS, evaluateToolPolicy } = require('./toolPolicy');
const { buildFinalSummary } = require('./finalizer');

const DEFAULT_MAX_STEPS = 4;
const ALLOWED_TOOLS = INTERNAL_TOOLS;
const MEMORY_LIMITS = {
  plans: 24,
  runs: 32,
  goals: 64,
};

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeGoal(goal) {
  return String(goal || '').trim();
}

function lower(goal) {
  return normalizeGoal(goal).toLowerCase();
}

function firstWords(text, count = 3) {
  return normalizeGoal(text)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, count)
    .join(' ');
}

function stripQuestionMarks(text) {
  return String(text || '').replace(/[؟?]+/g, '').trim();
}

function normalizeSummaryText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMemoryPath(opts = {}, kernel) {
  if (Object.prototype.hasOwnProperty.call(opts || {}, 'memoryPath')) {
    return opts.memoryPath;
  }
  const kernelMemoryPath = kernel?.graph?.memoryPath;
  if (typeof kernelMemoryPath === 'string' && kernelMemoryPath.endsWith('.json')) {
    return kernelMemoryPath.replace(/\.json$/, '.agent.json');
  }
  return path.join(process.cwd(), 'agent.memory.json');
}

function defaultMemoryState() {
  return {
    version: 1,
    updatedAt: null,
    plans: [],
    runs: [],
    goals: [],
    failures: [],
    stats: {
      tools: {},
      objectives: {},
    },
  };
}

class Agent {
  constructor(opts = {}) {
    this.kernel = opts.kernel;
    this.plugins = this.kernel?.plugins;
    this.dream = opts.dream || (this.kernel ? new Dream(this.kernel) : null);
    this.maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS;
    this.memoryPath = normalizeMemoryPath(opts, this.kernel);
    this.storage = opts.storage || null;
    this.memory = this._loadMemory();
    this.lastPlan = null;
    this.lastRun = null;
    this.activeGoal = null;
  }

  _emit(event, data) {
    if (this.plugins && typeof this.plugins.emit === 'function') {
      this.plugins.emit(event, data);
    }
    return data;
  }

  _ok(type, data = null, evidence = [], meta = {}) {
    if (this.kernel && typeof this.kernel._ok === 'function') {
      return this.kernel._ok(type, data, evidence, meta);
    }
    return {
      ok: true,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: null,
      meta,
    };
  }

  _fail(type, code, message, evidence = [], meta = {}, data = null) {
    if (this.kernel && typeof this.kernel._fail === 'function') {
      const result = this.kernel._fail(type, code, message, meta);
      result.data = data;
      if (Array.isArray(evidence) && evidence.length) {
        result.evidence = evidence;
      }
      return result;
    }
    return {
      ok: false,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: { code, message },
      meta,
    };
  }

  _collectEvidence(items = []) {
    const evidence = [];
    for (const item of items) {
      if (item && Array.isArray(item.evidence)) evidence.push(...item.evidence);
    }
    return evidence.filter(Boolean);
  }

  _isStalledProgress(previousSummary, currentSummary) {
    const prev = normalizeSummaryText(previousSummary);
    const curr = normalizeSummaryText(currentSummary);
    if (!curr) return true;
    if (curr === 'bilmiyorum' || curr === 'bilinmiyor' || curr === 'unknown') return true;
    if (!prev) return false;
    return curr === prev;
  }

  _loadMemory() {
    if (!this.memoryPath) return defaultMemoryState();
    try {
      if (!fs.existsSync(this.memoryPath)) return defaultMemoryState();
      const parsed = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
      return this._normalizeMemory(parsed);
    } catch (_) {
      return defaultMemoryState();
    }
  }

  _normalizeMemory(memory = {}) {
    const base = defaultMemoryState();
    const normalized = {
      ...base,
      ...memory,
      plans: Array.isArray(memory.plans) ? memory.plans : [],
      runs: Array.isArray(memory.runs) ? memory.runs : [],
      goals: Array.isArray(memory.goals) ? memory.goals : [],
      failures: Array.isArray(memory.failures) ? memory.failures : [],
      stats: {
        tools: memory.stats && typeof memory.stats.tools === 'object' && memory.stats.tools ? memory.stats.tools : {},
        objectives: memory.stats && typeof memory.stats.objectives === 'object' && memory.stats.objectives ? memory.stats.objectives : {},
      },
    };
    return normalized;
  }

  _saveMemory() {
    if (!this.memoryPath) return;
    try {
      const dir = path.dirname(this.memoryPath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.memoryPath, JSON.stringify(this.memory, null, 2));
    } catch (_) {
      // Memory persistence is best-effort only.
    }
  }

  _goalKey(goal) {
    return lower(goal);
  }

  _findGoalRecord(goal) {
    const key = this._goalKey(goal);
    for (let i = this.memory.goals.length - 1; i >= 0; i -= 1) {
      const entry = this.memory.goals[i];
      if (entry && entry.key === key) return entry;
    }
    return null;
  }

  _findResumeRun(goal) {
    const key = this._goalKey(goal);
    for (let i = this.memory.runs.length - 1; i >= 0; i -= 1) {
      const entry = this.memory.runs[i];
      if (!entry || entry.key !== key) continue;
      if (entry.status === 'completed') continue;
      if (!Array.isArray(entry.queuedSteps) || entry.queuedSteps.length === 0) continue;
      return entry;
    }
    return null;
  }

  _updateToolStats(tool, status) {
    if (!tool) return;
    const bucket = this.memory.stats.tools[tool] || { planned: 0, success: 0, blocked: 0, error: 0 };
    bucket.planned += 1;
    if (status === 'done') bucket.success += 1;
    else if (status === 'blocked') bucket.blocked += 1;
    else if (status === 'error') bucket.error += 1;
    this.memory.stats.tools[tool] = bucket;
  }

  _updateObjectiveStats(objective, status) {
    if (!objective) return;
    const bucket = this.memory.stats.objectives[objective] || { plans: 0, completed: 0, blocked: 0, error: 0 };
    bucket.plans += 1;
    if (status === 'completed') bucket.completed += 1;
    else if (status === 'blocked') bucket.blocked += 1;
    else if (status === 'error') bucket.error += 1;
    this.memory.stats.objectives[objective] = bucket;
  }

  _pruneMemory() {
    this.memory.plans = this.memory.plans.slice(-MEMORY_LIMITS.plans);
    this.memory.runs = this.memory.runs.slice(-MEMORY_LIMITS.runs);
    this.memory.goals = this.memory.goals.slice(-MEMORY_LIMITS.goals);
    this.memory.failures = this.memory.failures.slice(-MEMORY_LIMITS.goals);
  }

  _recordGoal(goal, objective, status, meta = {}) {
    const key = this._goalKey(goal);
    const entry = {
      key,
      goal: normalizeGoal(goal),
      objective,
      status,
      updatedAt: nowIso(),
      ...meta,
    };
    this.memory.goals.push(entry);
    this._pruneMemory();
    if (this.storage && typeof this.storage.saveGoalMemory === 'function') {
      try {
        this.storage.saveGoalMemory({
          goal: entry.goal,
          objective,
          status,
          completedSteps: meta.completedSteps || 0,
          finalAnswer: meta.finalAnswer || '',
          resumed: Boolean(meta.resumed),
          selectedTools: meta.selectedTools || [],
        });
      } catch (_) {
        // Storage is best-effort; JSON memory remains canonical fallback.
      }
    }
  }

  _stepSignature(step = {}, state = {}) {
    const tool = String(step.tool || '').trim();
    const action = String(step.action || '').trim();
    const input = normalizeGoal(step.input || state.goal || '');
    return `${tool}|${action}|${input}`;
  }

  _findRecentFailure(signature) {
    const key = String(signature || '');
    for (let i = this.memory.failures.length - 1; i >= 0; i -= 1) {
      const entry = this.memory.failures[i];
      if (entry && entry.signature === key) return entry;
    }
    return null;
  }

  _recordFailure(step, state, result, attempt = 1) {
    const signature = this._stepSignature(step, state);
    const entry = {
      signature,
      tool: step.tool,
      action: step.action,
      goal: normalizeGoal(state.goal),
      error: result?.error?.message || result?.error?.code || result?.error || 'unknown',
      attempt,
      updatedAt: nowIso(),
    };
    this.memory.failures.push(entry);
    this._pruneMemory();
    this._saveMemory();
    return entry;
  }

  _rememberPlan(plan, meta = {}) {
    const entry = {
      id: crypto.randomUUID?.() || `plan-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      goal: plan.goal,
      key: this._goalKey(plan.goal),
      objective: plan.objective,
      selectedTools: Array.isArray(plan.selectedTools) ? [...plan.selectedTools] : [],
      steps: Array.isArray(plan.steps) ? cloneValue(plan.steps) : [],
      status: plan.status || 'planned',
      confidence: plan.confidence,
      rationale: plan.rationale,
      policy: plan.policy ? cloneValue(plan.policy) : undefined,
      memory: plan.memory ? cloneValue(plan.memory) : undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...meta,
    };
    this.memory.plans.push(entry);
    this._recordGoal(plan.goal, plan.objective, 'planned', {
      selectedTools: entry.selectedTools,
    });
    this._pruneMemory();
    this._saveMemory();
    return entry;
  }

  _rememberRun(state) {
    const entry = {
      id: state.memoryId || state.id || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      goal: state.goal,
      key: this._goalKey(state.goal),
      objective: state.objective,
      selectedTools: Array.isArray(state.selectedTools) ? [...state.selectedTools] : [],
      steps: cloneValue(state.steps || []),
      queuedSteps: cloneValue(state.queuedSteps || []),
      evidence: cloneValue(state.evidence || []),
      notes: cloneValue(state.notes || []),
      plan: state.plan ? cloneValue(state.plan) : null,
      status: state.status,
      finalAnswer: state.finalAnswer,
      completedSteps: state.completedSteps || 0,
      remainingSteps: state.remainingSteps || 0,
      report: state.report || '',
      resumed: Boolean(state.resumed),
      resumedFrom: state.resumedFrom || null,
      progress: state.progress ? cloneValue(state.progress) : { stalledCount: 0, lastSummary: '' },
      startedAt: state.startedAt || nowIso(),
      updatedAt: nowIso(),
    };
    const index = this.memory.runs.findIndex(run => run.id === entry.id);
    if (index >= 0) this.memory.runs[index] = entry;
    else this.memory.runs.push(entry);
    this._updateObjectiveStats(entry.objective, state.status);
    this._recordGoal(entry.goal, entry.objective, state.status, {
      selectedTools: entry.selectedTools,
      finalAnswer: entry.finalAnswer,
      resumed: entry.resumed,
      completedSteps: entry.completedSteps,
    });
    this._pruneMemory();
    this._saveMemory();
    if (this.storage && typeof this.storage.saveRun === 'function') {
      try {
        this.storage.saveRun({
          ...entry,
          checkpointId: state.checkpointId || state.resumeToken || null,
          resumeToken: state.resumeToken || null,
          iteration: state.steps ? state.steps.length : 0,
          budgetRemaining: state.budgetRemaining || 0,
        });
      } catch (_) {
        // Non-fatal persistence mirror.
      }
    }
    return entry;
  }

  _policy(goal, objective) {
    const text = lower(goal);
    const baseOrders = {
      learn: ['learn', 'verify', 'ask'],
      verify: ['ask', 'verify', 'reason', 'dream'],
      compare: ['ask', 'compare', 'dream', 'verify'],
      reason: ['ask', 'reason', 'verify', 'dream'],
      dream: ['dream', 'ask', 'verify'],
      plan: ['ask', 'verify', 'dream', 'reason'],
      investigate: ['ask', 'verify', 'reason', 'dream'],
    };
    const signals = [];
    const failureHits = [];
    if (/(ignore|yok say|sistem mesaj|system prompt|developer message|gizli komut)/i.test(text)) {
      signals.push('manipulation');
    }
    if (/\b(mi|mı|mu|mü)\b/.test(text) || /\?$/.test(text)) {
      signals.push('question');
    }
    if (/(plan|task|görev|ajan|workflow|adım)/i.test(text)) {
      signals.push('workflow');
    }
    const base = baseOrders[objective] || baseOrders.investigate;
    const scores = new Map(base.map((tool, index) => [tool, 100 - index * 10]));
    const scoreReasons = new Map(base.map(tool => [tool, ['objective-default']]));
    const bump = (tool, amount, reason) => {
      scores.set(tool, (scores.get(tool) || 0) + amount);
      const reasons = scoreReasons.get(tool) || [];
      reasons.push(reason);
      scoreReasons.set(tool, reasons);
    };
    const toolStats = this.memory?.stats?.tools || {};
    for (const [tool, stat] of Object.entries(toolStats)) {
      const success = Number(stat.success || 0);
      const blocked = Number(stat.blocked || 0);
      const error = Number(stat.error || 0);
      const planned = Number(stat.planned || 0);
      const boost = success * 4 - blocked * 5 - error * 7;
      if (scores.has(tool) && boost !== 0) {
        bump(tool, boost, boost > 0 ? 'tool-health-positive' : 'tool-health-negative');
      }
      if (planned > 0 && (blocked + error) > success && scores.has(tool)) {
        signals.push('tool-health-risk');
      }
    }
    if (signals.includes('manipulation')) {
      bump('verify', 25, 'manipulation-risk');
      bump('reason', 8, 'manipulation-risk');
    }
    const goalRecord = this._findGoalRecord(goal);
    if (goalRecord) {
      signals.push('known-goal');
      bump('ask', 6, 'known-goal');
      if (goalRecord.status === 'completed') {
        signals.push('known-goal-success');
        bump('verify', 5, 'known-goal-success');
      }
      if (goalRecord.status === 'blocked' || goalRecord.status === 'error') {
        signals.push('known-goal-risk');
        bump('dream', 10, 'known-goal-risk');
        bump('reason', 6, 'known-goal-risk');
      }
    }
    for (const tool of base) {
      const sig = `${tool}|${objective}|${text}`;
      const failure = this._findRecentFailure(sig);
      if (failure) {
        failureHits.push({ tool, error: failure.error, attempt: failure.attempt });
        signals.push('recent-failure');
        bump(tool, -35, 'recent-failure');
      }
    }
    const toolScores = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tool, score]) => ({
        tool,
        score,
        reasons: scoreReasons.get(tool) || [],
      }));
    const ordered = toolScores.map(item => item.tool);
    for (const tool of base) {
      if (!ordered.includes(tool)) ordered.push(tool);
    }
    return {
      objective,
      selectedTools: ordered.slice(0, 4),
      baseTools: base,
      signals,
      failureHits,
      toolScores,
      rationale: signals.includes('manipulation')
        ? 'Risk-aware policy boosted verify and reason first.'
        : signals.includes('recent-failure')
          ? 'Recent failure history reduced repeated tool choices.'
        : signals.includes('tool-health-risk')
          ? 'Tool health history reduced unreliable choices.'
        : goalRecord
          ? 'Known goal found in memory, so the planner keeps a slightly stronger ask/verify mix.'
          : 'Default tool policy selected by objective.',
    };
  }

  _objective(goal) {
    const text = lower(goal);
    if (/(öğren|ekle|kaydet|teach|learn)/i.test(text)) return 'learn';
    if (/(karşılaştır|kıyas|compare|vs)/i.test(text)) return 'compare';
    if (/(neden|niçin|why)/i.test(text)) return 'reason';
    if (/(doğrula|kontrol et|verify|çeliş|risk|manipül)/i.test(text)) return 'verify';
    if (/\b(mi|mı|mu|mü)\b/.test(text) || /\?$/.test(text)) return 'verify';
    if (/(hipotez|öner|dream|rüya|fikir)/i.test(text)) return 'dream';
    if (/(plan|görev|task|ajan|workflow|yap)/i.test(text)) return 'plan';
    return 'investigate';
  }

  _buildPlan(goal, opts = {}) {
    const objective = this._objective(goal);
    const cleanedGoal = normalizeGoal(goal);
    const shortGoal = firstWords(cleanedGoal, 5);
    const policy = this._policy(cleanedGoal, objective);
    const steps = [];
    const selectedTools = [...policy.selectedTools];

    const pushStep = (id, action, tool, input, rationale) => {
      steps.push({ id, action, tool, input, rationale });
    };

    if (objective === 'learn') {
      pushStep('ingest', 'learn', 'learn', cleanedGoal, 'İstek bilgi eklemeye dönük.');
      pushStep('confirm', 'verify', 'verify', cleanedGoal, 'Yeni bilgi mümkünse doğrulanır.');
    } else if (objective === 'compare') {
      pushStep('context', 'ask', 'ask', cleanedGoal, 'Karşılaştırma için bağlam toplanır.');
      pushStep('compare', 'compare', 'compare', cleanedGoal, 'İki varlık arasındaki farklar çıkarılır.');
    } else if (objective === 'reason') {
      pushStep('context', 'ask', 'ask', cleanedGoal, 'Sebep analizi için bağlam alınır.');
      pushStep('reason', 'reason', 'reason', cleanedGoal, 'Neden-sonuç zinciri oluşturulur.');
    } else if (objective === 'verify') {
      pushStep('context', 'ask', 'ask', cleanedGoal, 'İddianın grafikteki durumu kontrol edilir.');
      pushStep('verify', 'verify', 'verify', cleanedGoal, 'Doğruluk ve çelişki denetlenir.');
      pushStep('fallback', 'dream', 'dream', {}, 'Sonuç bilinmiyorsa hipotez üretip boşluğu işaretler.');
    } else if (objective === 'dream') {
      pushStep('dream', 'dream', 'dream', {}, 'Hipotez ve bağlamsal öneri üretilir.');
      pushStep('context', 'ask', 'ask', cleanedGoal, 'Hipotez sonrası bağlam açılır.');
    } else if (objective === 'plan') {
      pushStep('context', 'ask', 'ask', cleanedGoal, 'Görevin kapsamı netleştirilir.');
      pushStep('verify', 'verify', 'verify', cleanedGoal, 'Kritik iddia veya kısıtlar doğrulanır.');
      pushStep('dream', 'dream', 'dream', {}, 'Alternatif yol ve riskler keşfedilir.');
    } else {
      pushStep('context', 'ask', 'ask', cleanedGoal, 'Genel bağlam toplanır.');
      pushStep('verify', 'verify', 'verify', cleanedGoal, 'Mevcut iddia destekleniyor mu kontrol edilir.');
      pushStep('dream', 'dream', 'dream', {}, 'Eksik alanlar için hipotez üretilir.');
    }

    const limitedSteps = steps.slice(0, Math.max(1, opts.maxSteps || this.maxSteps));
    const memorySummary = {
      knownGoals: this.memory.goals.length,
      previousRuns: this.memory.runs.filter(run => run && run.key === this._goalKey(cleanedGoal)).length,
      resumed: Boolean(this._findResumeRun(cleanedGoal)),
    };
    const plan = {
      goal: cleanedGoal,
      objective,
      shortGoal,
      steps: limitedSteps,
      selectedTools,
      maxSteps: Math.max(1, opts.maxSteps || this.maxSteps),
      status: 'planned',
      confidence: objective === 'investigate' ? 0.58 : 0.74,
      policy,
      memory: memorySummary,
      rationale: objective === 'investigate'
        ? 'Genel amaç belirsiz; önce bağlam topla, sonra karar ver.'
        : 'Amaç sinyali açık; ilgili araçlar sıralandı.',
    };

    this.lastPlan = plan;
    this.activeGoal = cleanedGoal;
    this._emit('beforePlan', plan);
    this._emit('afterPlan', plan);
    this._rememberPlan(plan);
    return this._ok('plan', plan, [], { objective });
  }

  plan(goal, opts = {}) {
    return this._buildPlan(goal, opts);
  }

  _extractAgentSummary(result) {
    if (!result || typeof result !== 'object') return { text: '', status: 'unknown', evidence: [] };
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    const evidence = Array.isArray(result.evidence) ? result.evidence : [];
    return {
      text:
        data.answer ||
        data.explanation ||
        data.summary ||
        data.reason ||
        data.hypothesis ||
        data.status ||
        '',
      status: data.status || 'unknown',
      evidence,
      data,
    };
  }

  _buildRunRecommendations(state) {
    const recommendations = new Set();
    const lastStep = state.steps[state.steps.length - 1] || null;
    const blocked = state.status === 'blocked' || lastStep?.status === 'blocked';
    const stalledCount = Number(state.progress?.stalledCount || 0);
    const policySignals = Array.isArray(state.plan?.policy?.signals) ? state.plan.policy.signals : [];

    if (blocked) recommendations.add('Sadece izinli tool setiyle devam et ve istegi daralt.');
    if (state.status === 'paused') recommendations.add('Hedefi degistirmeden once checkpoint uzerinden devam et.');
    if (stalledCount >= 2) recommendations.add('Ayni toolu tekrar etmeden once hedefi yeniden ifade et veya baglam ekle.');
    if (policySignals.includes('recent-failure')) recommendations.add('Yakin gecmiste hata veren tool imzasini tekrar etme; ask veya dream fallback kullan.');
    if (policySignals.includes('tool-health-risk')) recommendations.add('Zayif tool yolunu tekrar denemeden once hedefi daralt.');
    if (state.objective === 'verify') recommendations.add('Once ask ile baglam topla, sonra odakli ifadeyi verify ile denetle.');
    if (state.objective === 'reason') recommendations.add('Sebep ve kanit zincirini ara olgularla guclendir.');
    if (!recommendations.size) recommendations.add('Secili tool karisimi ile devam et.');

    const toolHealth = Object.entries(this.memory?.stats?.tools || {})
      .map(([tool, stat]) => ({
        tool,
        success: Number(stat.success || 0),
        blocked: Number(stat.blocked || 0),
        error: Number(stat.error || 0),
      }))
      .filter(item => item.success || item.blocked || item.error)
      .sort((a, b) => (b.error + b.blocked) - (a.error + a.blocked))
      .slice(0, 3);

    return {
      items: [...recommendations],
      toolHealth,
    };
  }

  _suggestNextAction(state) {
    const lastStep = state.steps[state.steps.length - 1] || null;
    const blocked = state.status === 'blocked' || lastStep?.status === 'blocked';
    const stalledCount = Number(state.progress?.stalledCount || 0);
    const selectedTools = Array.isArray(state.selectedTools) ? state.selectedTools : [];
    const completedActions = new Set((state.steps || []).map(step => step.action));
    const lastPolicy = lastStep?.policy || null;

    if (blocked) {
      return {
        action: 'revise',
        tool: 'ask',
        reason: 'Blocked execution detected; refine the request and use only allowed tools.',
      };
    }
    if (stalledCount >= 2) {
      return {
        action: 'reframe',
        tool: 'dream',
        reason: 'Progress stalled; reframe the target or add new context.',
      };
    }
    if (state.status === 'paused') {
      return {
        action: 'resume',
        tool: selectedTools[0] || 'ask',
        reason: 'Run paused before completion; continue from the checkpoint.',
      };
    }
    if (lastPolicy && lastPolicy.category === 'external' && lastPolicy.action === 'review') {
      return {
        action: 'approval',
        tool: lastStep.tool,
        reason: 'External tool request is waiting for approval before execution.',
      };
    }
    if (lastStep && lastStep.result && lastStep.result.ok === false) {
      return {
        action: 'fallback',
        tool: selectedTools.includes('dream') ? 'dream' : 'ask',
        reason: 'Last step failed; switch to the safest available fallback.',
      };
    }
    if (state.objective === 'verify') {
      if (!completedActions.has('verify')) {
        return {
          action: 'verify',
          tool: 'verify',
          reason: 'Verification has not run yet for this objective.',
        };
      }
      return {
        action: 'explain',
        tool: selectedTools.includes('reason') ? 'reason' : 'ask',
        reason: 'Verification ran; explain the result or gather missing context.',
      };
    }
    if (state.objective === 'reason') {
      return {
        action: 'reason',
        tool: 'reason',
        reason: 'Reasoning objective should continue with a cause/evidence chain.',
      };
    }
    return {
      action: 'continue',
      tool: selectedTools[0] || 'ask',
      reason: 'Current flow is healthy; continue with the selected tool mix.',
    };
  }

  inspectToolPolicy(tool, input = '', context = {}) {
    const policy = evaluateToolPolicy({
      tool,
      input,
      context,
      internalTools: ALLOWED_TOOLS,
    });
    const approval = this._queueToolApproval(policy, input, context);
    policy.approvalId = approval ? approval.id : null;
    policy.approvalStatus = approval ? approval.status : null;
    return this._ok('policy', policy, [], {
      tool: policy.tool,
      category: policy.category,
      action: policy.action,
      approvalId: approval ? approval.id : null,
      approvalStatus: approval ? approval.status : null,
    });
  }

  _queueToolApproval(policy, input, context = {}) {
    if (!this.storage || typeof this.storage.saveToolApproval !== 'function') return null;
    if (!policy || policy.category !== 'external') return null;
    const status = policy.action === 'review' ? 'pending' : 'blocked';
    const decision = policy.action === 'review' ? '' : 'blocked';
    const reason = Array.isArray(policy.reasons) ? policy.reasons[0] || '' : '';
    try {
      return this.storage.saveToolApproval({
        tool: policy.tool,
        input,
        context,
        policy,
        status,
        decision,
        reason,
      });
    } catch (_) {
      return null;
    }
  }

  listPendingToolApprovals(limit = 20) {
    if (!this.storage || typeof this.storage.listPendingToolApprovals !== 'function') return [];
    return this.storage.listPendingToolApprovals(limit);
  }

  countPendingToolApprovals() {
    if (!this.storage || typeof this.storage.countPendingToolApprovals !== 'function') return 0;
    return this.storage.countPendingToolApprovals();
  }

  _chooseFollowUp(step, summary, state) {
    if (step.action === 'verify') {
      if (summary.status === 'bilinmiyor') return { action: 'dream', tool: 'dream', input: {} };
      return null;
    }
    if (step.action === 'ask') {
      if (!summary.text || summary.text === 'Bilmiyorum') return { action: 'dream', tool: 'dream', input: {} };
      if (state.objective === 'verify') return { action: 'verify', tool: 'verify', input: state.goal };
      if (state.objective === 'reason') return { action: 'reason', tool: 'reason', input: state.goal };
    }
    if (step.action === 'compare' && (!summary.text || summary.text === 'Bilmiyorum')) {
      return { action: 'dream', tool: 'dream', input: {} };
    }
    if (step.action === 'dream') {
      return null;
    }
    if (step.action === 'learn') {
      return { action: 'verify', tool: 'verify', input: state.goal };
    }
    return null;
  }

  _isRepeatFailure(step, state) {
    const signature = this._stepSignature(step, state);
    return Boolean(this._findRecentFailure(signature));
  }

  _isRetryableStepReport(report = {}) {
    const result = report.result || {};
    const rawError = String(result?.error?.message || result?.error?.code || result?.error || report.summary || '').toLowerCase();
    return /abort|timeout|fetch|network|econn|enotfound|etimedout|eai_again|503|502|504|429|temporarily|closed|ollama/.test(rawError);
  }

  _executeStepWithRetry(step, state, opts = {}) {
    const maxRetries = Number.isInteger(opts.stepRetries) ? Math.max(0, opts.stepRetries) : 2;
    let lastReport = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const report = this._executeStep({ ...step, attempt: attempt + 1 }, state, opts);
      lastReport = report;
      if (report.status !== 'error') return report;
      this._recordFailure(step, state, report.result, attempt + 1);
      if (!this._isRetryableStepReport(report) || attempt >= maxRetries) break;
    }
    return lastReport;
  }

  _executeStep(step, state, opts = {}) {
    this._emit('beforeTask', { step, state, opts });
    let result;
    const toolPolicy = evaluateToolPolicy({
      tool: step.tool,
      input: step.input,
      context: {
        goal: state.goal,
        objective: state.objective,
        action: step.action,
      },
      internalTools: ALLOWED_TOOLS,
    });

    if (toolPolicy.category !== 'internal') {
      const code = toolPolicy.blocked ? 'EXTERNAL_TOOL_BLOCKED' : 'EXTERNAL_TOOL_REVIEW_REQUIRED';
      result = {
        ok: false,
        type: 'agent',
        data: null,
        evidence: [],
        error: {
          code,
          message: toolPolicy.reasons[0] || `External tool ${toolPolicy.action} required.`,
        },
        meta: {
          blocked: true,
          allowedTools: [...ALLOWED_TOOLS],
          policy: toolPolicy,
        },
      };
    } else {
      switch (step.tool) {
        case 'learn':
          result = this.kernel.learn(step.input, opts.learnOpts || {});
          break;
        case 'ask':
          result = this.kernel.ask(step.input, opts.askOpts || {});
          break;
        case 'verify':
          result = this.kernel.verify(step.input, opts.verifyOpts || {});
          break;
        case 'reason':
          result = this.kernel.reason(stripQuestionMarks(step.input || state.goal), opts.reasonOpts || {});
          break;
        case 'compare': {
          const text = String(step.input || state.goal);
          const parts = text.split('|').map(s => s.trim()).filter(Boolean);
          if (parts.length >= 2) {
            result = this.kernel.compare(parts[0], parts[1], opts.compareOpts || {});
          } else {
            result = this.kernel.compare(firstWords(text, 2), firstWords(text.split(/\s+/).slice(2).join(' '), 2), opts.compareOpts || {});
          }
          break;
        }
        case 'dream':
          result = this.dream ? this.dream.dream(opts.dreamOpts || {}) : this.kernel.dream(opts.dreamOpts || {});
          break;
        default:
          result = {
            ok: false,
            type: 'agent',
            data: null,
            evidence: [],
            error: {
              code: 'UNSUPPORTED_TOOL',
              message: `Unsupported tool: ${String(step.tool || 'unknown')}`,
            },
            meta: {
              blocked: true,
              allowedTools: [...ALLOWED_TOOLS],
            },
          };
          break;
      }
    }

    const summary = this._extractAgentSummary(result);
    const blocked = result?.error?.code === 'UNSUPPORTED_TOOL' || result?.meta?.blocked === true;
    const stepReport = {
      id: step.id,
      action: step.action,
      tool: step.tool,
      input: step.input,
      rationale: step.rationale,
      status: blocked ? 'blocked' : (result?.ok === false ? 'error' : 'done'),
      summary: summary.text || '',
      result,
      policy: toolPolicy,
    };
    this._emit('afterTask', { step: stepReport, state, opts });
    return stepReport;
  }

  run(goal, opts = {}) {
    const planResult = this.plan(goal, opts);
    const freshPlan = planResult.data;
    const resumeCandidate = opts.resume === false ? null : this._findResumeRun(goal);
    const activePlan = resumeCandidate && resumeCandidate.plan ? resumeCandidate.plan : freshPlan;
    const state = resumeCandidate ? {
      goal: activePlan.goal,
      objective: activePlan.objective,
      selectedTools: [...(activePlan.selectedTools || [])],
      plan: cloneValue(activePlan),
      steps: Array.isArray(resumeCandidate.steps) ? cloneValue(resumeCandidate.steps) : [],
      evidence: Array.isArray(resumeCandidate.evidence) ? cloneValue(resumeCandidate.evidence) : [],
      status: 'running',
      notes: Array.isArray(resumeCandidate.notes) ? cloneValue(resumeCandidate.notes) : [],
      queuedSteps: Array.isArray(resumeCandidate.queuedSteps) && resumeCandidate.queuedSteps.length
        ? cloneValue(resumeCandidate.queuedSteps)
        : cloneValue(activePlan.steps || []),
      resumed: true,
      resumedFrom: resumeCandidate.id,
      startedAt: resumeCandidate.startedAt || nowIso(),
      progress: resumeCandidate.progress ? cloneValue(resumeCandidate.progress) : { stalledCount: 0, lastSummary: '' },
    } : {
      goal: freshPlan.goal,
      objective: freshPlan.objective,
      selectedTools: [...freshPlan.selectedTools],
      plan: cloneValue(freshPlan),
      steps: [],
      evidence: [],
      status: 'running',
      notes: [],
      queuedSteps: cloneValue(freshPlan.steps || []),
      resumed: false,
      resumedFrom: null,
      startedAt: nowIso(),
      progress: { stalledCount: 0, lastSummary: '' },
    };
    state.completedSteps = state.steps.length;
    state.remainingSteps = Array.isArray(state.queuedSteps) ? state.queuedSteps.length : 0;
    this._emit('beforeAgentRun', state);

    const queued = Array.isArray(state.queuedSteps) ? [...state.queuedSteps] : [];
    this._rememberRun(state);
    while (queued.length > 0 && state.steps.length < activePlan.maxSteps) {
      const step = queued.shift();
      const report = this._executeStepWithRetry(step, state, opts);
      state.steps.push(report);
      state.evidence.push(...this._collectEvidence([report.result]));
      this._updateToolStats(report.tool, report.status);
      state.notes.push({
        step: report.action,
        summary: report.summary,
      });

      const summary = this._extractAgentSummary(report.result);
      const previousSummary = state.progress?.lastSummary || '';
      const stalled = this._isStalledProgress(previousSummary, summary.text);
      state.progress = {
        stalledCount: stalled ? (state.progress?.stalledCount || 0) + 1 : 0,
        lastSummary: normalizeSummaryText(summary.text),
      };

      const followUp = this._chooseFollowUp(step, summary, state);
      const shouldForceDream =
        state.progress.stalledCount >= 2 &&
        state.steps.length < activePlan.maxSteps &&
        !queued.some(s => s.tool === 'dream');

      if (shouldForceDream) {
        queued.unshift({
          id: `dream-${state.steps.length + 1}`,
          action: 'dream',
          tool: 'dream',
          input: {},
          rationale: 'Progress stalled; switching to hypothesis mode.',
        });
      } else if (followUp && state.steps.length < activePlan.maxSteps) {
        const nextSignature = this._stepSignature(followUp, state);
        if (this._findRecentFailure(nextSignature)) {
          const fallback = followUp.action === 'dream' ? null : { action: 'dream', tool: 'dream', input: {}, rationale: 'Önceki aynı hata tekrarlandığı için güvenli fallback seçildi.' };
          if (fallback && !this._findRecentFailure(this._stepSignature(fallback, state))) {
            queued.unshift({
              id: `${fallback.action}-${state.steps.length + 1}`,
              action: fallback.action,
              tool: fallback.tool,
              input: fallback.input,
              rationale: fallback.rationale,
            });
          }
        } else {
          queued.unshift({
            id: `${followUp.action}-${state.steps.length + 1}`,
            action: followUp.action,
            tool: followUp.tool,
            input: followUp.input,
            rationale: 'Önceki adımın sonucu ek adım gerektirdi.',
          });
        }
      }
      state.queuedSteps = [...queued];
      state.completedSteps = state.steps.length;
      state.remainingSteps = queued.length;
      this._rememberRun(state);
    }

    const finalStep = state.steps[state.steps.length - 1];
    const finalSummary = finalStep ? this._extractAgentSummary(finalStep.result) : { text: '' };
    const finalAnswer = finalSummary.text || 'Ajan görevi tamamladı ancak kısa özet üretilemedi.';
    state.status = finalStep && finalStep.result && finalStep.result.ok === false ? 'blocked' : 'completed';
    state.finalSummary = buildFinalSummary({
      goal: state.goal,
      objective: activePlan.objective,
      status: state.status,
      steps: state.steps,
      evidence: state.evidence,
      finalAnswer,
      selectedTools: activePlan.selectedTools,
    });
    state.finalAnswer = state.finalSummary.conclusion || finalAnswer;
    state.completedSteps = state.steps.length;
    state.remainingSteps = queued.length;
    state.recommendations = this._buildRunRecommendations(state);
    state.nextAction = this._suggestNextAction(state);
    state.report = this._renderReport(state);
    state.memory = {
      path: this.memoryPath,
      goals: this.memory.goals.length,
      runs: this.memory.runs.length,
    };
    this.lastRun = state;
    this._rememberRun(state);
    this._emit('afterAgentRun', state);

    if (state.status === 'blocked') {
      return this._fail('agent', 'AGENT_BLOCKED', finalAnswer, state.evidence, {
        objective: activePlan.objective,
        selectedTools: activePlan.selectedTools,
        resumed: state.resumed,
        report: state.report,
      }, state);
    }

    return this._ok('agent', state, state.evidence, {
      objective: activePlan.objective,
      selectedTools: activePlan.selectedTools,
      resumed: state.resumed,
    });
  }

  _renderReport(state) {
    const stepLines = state.steps.map((step, index) => {
      const summary = step.summary ? ` - ${step.summary}` : '';
      return `${index + 1}. ${step.action} (${step.tool})${summary}`;
    });
    const finalSummary = state.finalSummary || buildFinalSummary(state);
    const recommendations = this._buildRunRecommendations(state);
    const recommendationLines = recommendations.items.map(item => `- ${item}`);
    const nextAction = state.nextAction || this._suggestNextAction(state);
    const nextActionLine = `${nextAction.action} -> ${nextAction.tool}: ${nextAction.reason}`;
    const toolHealthLines = recommendations.toolHealth.length
      ? recommendations.toolHealth.map(item => `- ${item.tool}: success=${item.success}, blocked=${item.blocked}, error=${item.error}`)
      : ['- henüz kullanım verisi yok'];
    return [
      `Hedef: ${state.goal}`,
      `Amaç: ${state.objective}`,
      `Durum: ${state.status}`,
      `Adım sayısı: ${state.completedSteps}`,
      `İlerleme: ${(state.progress && typeof state.progress.stalledCount === 'number') ? `stalled=${state.progress.stalledCount}` : 'unknown'}`,
      `Sonraki adim: ${nextActionLine}`,
      'Yargı özeti:',
      `- Mod: ${finalSummary.mode}`,
      'Bilinenler:',
      ...(finalSummary.knownFacts.length ? finalSummary.knownFacts.map(item => `- ${item}`) : ['- yok']),
      'Bilinmeyenler:',
      ...(finalSummary.unknowns.length ? finalSummary.unknowns.map(item => `- ${item}`) : ['- yok']),
      `- Sonuç: ${finalSummary.conclusion}`,
      'Takip soruları:',
      ...(finalSummary.nextQuestions.length ? finalSummary.nextQuestions.map(item => `- ${item}`) : ['- yok']),
      'Öneri:',
      ...recommendationLines,
      'Araç sağlığı:',
      ...toolHealthLines,
      ...stepLines,
      `Sonuç: ${state.finalAnswer}`,
    ].join('\n');
  }
}

module.exports = Agent;
