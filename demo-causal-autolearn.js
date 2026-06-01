const Graph = require('./graph');
const { CausalSimulator } = require('./causalSimulator');
const { buildCausalSummary } = require('./finalizer');

const SCENARIO = Object.freeze({
  title: 'AXIOM v0.7 - What breaks if you do this?',
  action: 'autoLearn default true olursa ne bozulur?',
  nodeId: 'autoLearn_default_true',
  changeType: 'modify',
  maxDepth: 10,
});

function labelFor(graph, nodeId) {
  return graph && graph._nodes && graph._nodes[nodeId] ? graph._nodes[nodeId].label : nodeId;
}

function buildAutoLearnGraph() {
  const graph = new Graph({ noLoad: true });

  graph.addNode('autoLearn_default_true', 'autoLearn default true');
  graph.addNode('unsupported_llm_output', 'unsupported LLM output can enter graph');
  graph.addNode('graph_trust_degradation', 'graph trust degradation');
  graph.addNode('shield_claim_weakens', 'Shield claim weakens');
  graph.addNode('axiom_reliability_promise_damaged', 'AXIOM reliability promise is damaged');

  graph.addEdge('autoLearn_default_true', 'unsupported_llm_output', 'CAUSES', {
    strength: 0.98,
    confidence: 0.97,
    evidence: ['autoLearn-policy', 'graph-pollution'],
    source_ref: 'demo:autoLearn-default-true',
    created_at: '2026-06-01T00:00:01.000Z',
  });
  graph.addEdge('unsupported_llm_output', 'graph_trust_degradation', 'CAUSES', {
    strength: 0.97,
    confidence: 0.96,
    evidence: ['unsupported-output', 'trust-degradation'],
    source_ref: 'demo:unsupported-output',
    created_at: '2026-06-01T00:00:02.000Z',
  });
  graph.addEdge('graph_trust_degradation', 'shield_claim_weakens', 'CAUSES', {
    strength: 0.96,
    confidence: 0.95,
    evidence: ['shield-claim', 'trust-loss'],
    source_ref: 'demo:shield-claim',
    created_at: '2026-06-01T00:00:03.000Z',
  });
  graph.addEdge('shield_claim_weakens', 'axiom_reliability_promise_damaged', 'PREVENTS', {
    strength: 0.99,
    confidence: 0.98,
    evidence: ['reliability-promise', 'safety-guard'],
    source_ref: 'demo:reliability-promise',
    created_at: '2026-06-01T00:00:04.000Z',
  });

  return graph;
}

function pickPrimaryChain(chainDetails) {
  if (!Array.isArray(chainDetails) || chainDetails.length === 0) return [];
  return chainDetails.reduce((best, candidate) => {
    if (!Array.isArray(candidate)) return best;
    if (!Array.isArray(best) || candidate.length > best.length) return candidate;
    if (candidate.length < best.length) return best;
    const candidateKey = candidate.map(step => `${step.from}|${step.relation}|${step.to}`).join('>');
    const bestKey = best.map(step => `${step.from}|${step.relation}|${step.to}`).join('>');
    return candidateKey < bestKey ? candidate : best;
  }, []);
}

function formatChainLabels(graph, chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return 'No causal chain';
  }

  const labels = [labelFor(graph, chain[0].from)];
  for (const step of chain) {
    labels.push(labelFor(graph, step.to));
  }
  return labels.join(' -> ');
}

function formatRelationProfile(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return 'n/a';
  }
  return chain.map(step => step.relation).join(' -> ');
}

function formatEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return [];
  }

  return evidence.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return String(item);
    return item.description || item.value || item.type || JSON.stringify(item);
  });
}

function buildDisplayConclusion(riskLevel) {
  switch (riskLevel) {
    case 'critical':
      return 'Decision: Change is not recommended.';
    case 'high':
      return 'Decision: High risk; human approval is required.';
    case 'medium':
      return 'Decision: Apply carefully.';
    case 'low':
      return 'Decision: Low risk.';
    default:
      return 'Decision: Insufficient causal data.';
  }
}

function buildDisplayRecommendation(riskLevel) {
  switch (riskLevel) {
    case 'critical':
      return 'Change is not recommended.';
    case 'high':
      return 'Review alternatives before proceeding.';
    case 'medium':
      return 'Evaluate the trade-off before proceeding.';
    case 'low':
      return 'Proceed cautiously.';
    default:
      return 'Gather more causal evidence.';
  }
}

function buildDemoReport() {
  const graph = buildAutoLearnGraph();
  const simulator = new CausalSimulator(graph);
  const simulation = simulator.simulateChange({
    action: SCENARIO.action,
    nodeId: SCENARIO.nodeId,
    changeType: SCENARIO.changeType,
    maxDepth: SCENARIO.maxDepth,
  });
  const summary = buildCausalSummary(simulation);
  const primaryChain = pickPrimaryChain(simulation.causalChainDetails);
  const causalChain = formatChainLabels(graph, primaryChain);
  const relationProfile = formatRelationProfile(primaryChain);
  const affectedNodes = Array.isArray(summary.affectedNodes)
    ? summary.affectedNodes.map(node => node.label || node.nodeId).filter(Boolean)
    : [];
  const evidence = formatEvidence(summary.evidence);
  const conclusion = buildDisplayConclusion(summary.riskLevel);
  const recommendation = buildDisplayRecommendation(summary.riskLevel);

  const lines = [
    SCENARIO.title,
    `Input: ${SCENARIO.action}`,
    `Mode: ${summary.mode || 'causal'}`,
    `Causal chain: ${causalChain}`,
    `Relation profile: ${relationProfile}`,
    `Affected nodes: ${affectedNodes.length ? affectedNodes.join(', ') : 'None'}`,
    `Risk level: ${summary.riskLevel}`,
    `Conclusion: ${conclusion}`,
    `Recommendation: ${recommendation}`,
    `Next questions:`,
    ...((Array.isArray(summary.nextQuestions) && summary.nextQuestions.length > 0)
      ? summary.nextQuestions.map(question => `- ${question}`)
      : ['- None']),
    `Evidence: ${evidence.length ? evidence.join(', ') : 'None'}`,
  ];

  return {
    title: SCENARIO.title,
    input: SCENARIO.action,
    mode: summary.mode || 'causal',
    causalChain,
    relationProfile,
    affectedNodes,
    riskLevel: summary.riskLevel,
    conclusion,
    recommendation,
    nextQuestions: Array.isArray(summary.nextQuestions) ? [...summary.nextQuestions] : [],
    evidence,
    unknowns: Array.isArray(summary.unknowns) ? [...summary.unknowns] : [],
    finalizerSummary: summary,
    simulation,
    lines,
    text: lines.join('\n'),
  };
}

function formatDemoReport(report = buildDemoReport()) {
  return Array.isArray(report.lines) ? report.lines.join('\n') : '';
}

function runDemo({ print = true } = {}) {
  const report = buildDemoReport();
  const text = formatDemoReport(report);

  if (print) {
    console.log(text);
  }

  return { report, text };
}

if (require.main === module) {
  runDemo({ print: true });
}

module.exports = {
  buildAutoLearnGraph,
  buildDemoReport,
  formatDemoReport,
  runDemo,
};
