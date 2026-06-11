const INTERNAL_TOOLS = new Set(['learn', 'ask', 'verify', 'reason', 'compare', 'dream']);
const DEFAULT_SANDBOX = Object.freeze({
  runner: 'node:vm',
  timeoutMs: 150,
  codeGeneration: 'disabled',
});

const EXTERNAL_BLOCK_PATTERNS = [
  /\b(shell|cmd|powershell|bash|sh|exec|eval|python|node|curl|wget)\b/i,
  /\b(delete|remove|rm|drop|destroy|format|shutdown|reboot|kill|wipe|truncate)\b/i,
  /\b(overwrite|replace all|erase all|nuke)\b/i,
];

const EXTERNAL_REVIEW_PATTERNS = [
  /\b(browser|open|fetch|request|http|https|api|url|download|upload|file|filesystem)\b/i,
  /\b(read|write|save|commit|push|install|search)\b/i,
];

const INJECTION_PATTERNS = [
  /\b(ignore|bypass|override|forget)\b.*\b(system|developer|policy|instruction)\b/i,
  /\b(system prompt|developer message|hidden command|secret instruction)\b/i,
];

function normalizeToolName(tool) {
  return String(tool || '').trim().toLowerCase();
}

function matchesAny(text, patterns = []) {
  const value = String(text || '');
  return patterns.some(pattern => pattern.test(value));
}

function clampRiskScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function scoreRisk({ blocked, review, input = '', tool = '' } = {}) {
  let score = 0;
  if (blocked) score += 70;
  if (review) score += 35;
  if (matchesAny(input, INJECTION_PATTERNS)) score += 20;
  if (matchesAny(tool, EXTERNAL_BLOCK_PATTERNS)) score += 15;
  if (matchesAny(input, EXTERNAL_BLOCK_PATTERNS)) score += 15;
  if (matchesAny(tool, EXTERNAL_REVIEW_PATTERNS)) score += 8;
  if (matchesAny(input, EXTERNAL_REVIEW_PATTERNS)) score += 8;
  return clampRiskScore(score);
}

function buildReasons({ category, tool, input, context, blocked, review }) {
  const reasons = [];
  if (category === 'internal') {
    reasons.push('Internal AXIOM tool.');
    return reasons;
  }
  reasons.push(`External tool request: ${tool || 'unknown'}.`);
  if (blocked && !review && !matchesAny(tool, EXTERNAL_BLOCK_PATTERNS) && !matchesAny(input, [...EXTERNAL_BLOCK_PATTERNS, ...INJECTION_PATTERNS])) {
    reasons.push('Unknown external tools are fail-closed by default.');
  } else if (blocked) {
    reasons.push('The requested tool or input looks destructive or executable.');
  } else if (review) {
    reasons.push('External execution requires explicit approval or a sandboxed runner.');
  }
  if (matchesAny(input, INJECTION_PATTERNS)) {
    reasons.push('Input contains prompt-injection style language.');
  }
  if (context && context.goal) {
    reasons.push(`Goal context: ${String(context.goal).slice(0, 120)}`);
  }
  return reasons;
}

function evaluateToolPolicy({ tool, input = '', context = {}, internalTools = INTERNAL_TOOLS } = {}) {
  const normalizedTool = normalizeToolName(tool);
  const normalizedInput = String(input || '');
  const internalSet = internalTools instanceof Set ? internalTools : new Set(Array.isArray(internalTools) ? internalTools : []);

  if (internalSet.has(normalizedTool)) {
    return {
      tool: normalizedTool,
      category: 'internal',
      action: 'allow',
      approval: 'auto',
      blocked: false,
      requiresApproval: false,
      review: false,
      riskScore: 0,
      confidence: 1,
      labels: ['internal-tool'],
      reasons: ['Internal AXIOM tool.'],
      suggestedNextStep: 'No additional action required.',
      source: 'toolPolicy',
      executionMode: 'direct',
      sandbox: null,
    };
  }

  const explicitlyBlocked = matchesAny(normalizedTool, EXTERNAL_BLOCK_PATTERNS) || matchesAny(normalizedInput, [...EXTERNAL_BLOCK_PATTERNS, ...INJECTION_PATTERNS]);
  const explicitlyReviewable = matchesAny(normalizedTool, EXTERNAL_REVIEW_PATTERNS) || matchesAny(normalizedInput, EXTERNAL_REVIEW_PATTERNS);
  const blocked = explicitlyBlocked || !explicitlyReviewable;
  const review = !blocked && explicitlyReviewable;
  const action = blocked ? 'block' : 'review';
  const labels = ['external-tool'];
  if (blocked) labels.push('blocked');
  if (review) labels.push('requires-approval');
  if (!explicitlyBlocked && !explicitlyReviewable) labels.push('unknown-tool-blocked');
  if (matchesAny(normalizedInput, INJECTION_PATTERNS)) labels.push('prompt-injection-risk');
  if (matchesAny(normalizedTool, EXTERNAL_BLOCK_PATTERNS)) labels.push('destructive');
  const approval = blocked ? 'blocked' : 'review';
  const riskScore = scoreRisk({ blocked, review, input: normalizedInput, tool: normalizedTool });

  return {
    tool: normalizedTool,
    category: 'external',
    action,
    approval,
    blocked,
    requiresApproval: !blocked,
    review: action === 'review',
    riskScore,
    confidence: blocked ? 0.96 : 0.78,
    labels,
    reasons: buildReasons({ category: 'external', tool: normalizedTool, input: normalizedInput, context, blocked, review }),
    suggestedNextStep: blocked
      ? 'Refine the request or use a safe internal AXIOM tool.'
      : 'Ask for approval or route through a sandboxed executor.',
    source: 'toolPolicy',
    context: context && typeof context === 'object' ? { ...context } : {},
    executionMode: blocked ? 'blocked' : 'sandbox',
    sandbox: blocked ? null : { ...DEFAULT_SANDBOX },
  };
}

module.exports = {
  INTERNAL_TOOLS,
  evaluateToolPolicy,
};
