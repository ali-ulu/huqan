// The final summary of an agent run: mode, conclusion and next questions from
// the steps' known facts and unknowns. Moved out of finalizer.js (#2170).

const { cleanFactText, dedupeStable, extractText, foldText, isContradictionText, isUnknownText, normalizeEvidence, normalizeText } = require('./finalizer-text');

function isLLMTool(step = {}) {
  const tool = foldText(step.tool || step.action || '');
  const source = foldText(step?.data?.source || step?.output?.source || step?.result?.data?.source || '');
  return /(llm|gpt|openai|assistant)/.test(tool) || /(llm|gpt|openai|assistant)/.test(source);
}

function collectStepTexts(step = {}) {
  const texts = [
    extractText(step.summary),
    extractText(step.output),
    extractText(step.result),
    extractText(step.data),
  ];
  if (step.error) {
    if (typeof step.error === 'string') {
      texts.push(normalizeText(step.error));
    } else {
      texts.push(extractText(step.error.message || step.error.code || ''));
    }
  }
  return texts.filter(Boolean).map(cleanFactText).filter(Boolean);
}

function deriveMode({ run, knownFacts, unknowns, steps }) {
  const status = foldText(run.status || '');
  const contradiction = status === 'blocked'
    || steps.some(step => isContradictionText(step.summary) || isContradictionText(step.error?.message || '') || isContradictionText(step.error?.code || ''));
  if (contradiction) return 'contradicted';

  const llmAssisted = steps.some(step => isLLMTool(step));
  if (llmAssisted && knownFacts.length > 0) return 'llm-assisted';

  if (knownFacts.length > 0 && unknowns.length === 0) return 'graph-backed';
  return 'insufficient-data';
}

function deriveConclusion({ mode, knownFacts, unknowns, run }) {
  if (mode === 'contradicted') {
    return 'This result contradicts the graph.';
  }
  if (mode === 'llm-assisted') {
    return 'The LLM-assisted output is partially supported by the graph.';
  }
  if (!knownFacts.length && unknowns.length) {
    return 'Mevcut bilgi yetersiz.';
  }
  if (knownFacts.length && unknowns.length) {
    return 'The known facts diverged, and some questions remain open.';
  }
  if (knownFacts.length) {
    return 'The known facts are supported by the graph.';
  }
  if (run.finalAnswer) {
    return normalizeText(run.finalAnswer);
  }
  return 'Mevcut bilgi yetersiz.';
}

function deriveNextQuestions(unknowns, goal, objective) {
  const questionSet = [];
  for (const unknown of unknowns) {
    const candidate = normalizeText(unknown).replace(/[.。!]+$/g, '');
    if (!candidate) continue;
    const question = /\?$/.test(candidate) ? candidate : `${candidate}?`;
    questionSet.push(question);
  }

  if (!questionSet.length) {
    if (objective === 'compare' && goal) {
      questionSet.push(`Which side of the comparison is missing?`);
    } else if (objective === 'reason' && goal) {
      questionSet.push(`What additional evidence does this result need?`);
    }
  }

  return dedupeStable(questionSet);
}

function buildFinalSummary(run = {}) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const evidence = dedupeStable(normalizeEvidence(run.evidence));
  const knownFacts = [];
  const unknowns = [];

  for (const step of steps) {
    const texts = collectStepTexts(step);
    const bestText = texts.find(Boolean) || '';

    if (texts.some(isContradictionText) || foldText(step.status || '') === 'blocked') {
      if (bestText) unknowns.push(bestText);
      continue;
    }

    if (texts.some(isUnknownText) || foldText(step.status || '') === 'error' || foldText(step.status || '') === 'review') {
      if (bestText) unknowns.push(bestText);
      continue;
    }

    if (bestText) {
      knownFacts.push(bestText);
    }
  }

  const dedupKnownFacts = dedupeStable(knownFacts);
  const dedupUnknowns = dedupeStable(unknowns);
  const mode = deriveMode({ run, knownFacts: dedupKnownFacts, unknowns: dedupUnknowns, steps });
  const conclusion = deriveConclusion({
    mode,
    knownFacts: dedupKnownFacts,
    unknowns: dedupUnknowns,
    run,
  });
  const nextQuestions = deriveNextQuestions(dedupUnknowns, run.goal, run.objective);

  return {
    mode,
    knownFacts: dedupKnownFacts,
    unknowns: dedupUnknowns,
    evidence,
    conclusion,
    nextQuestions,
  };
}

// ─── Causal finalizer for v0.7 ───────────────────────────────────────────────

module.exports = { buildFinalSummary, deriveMode };
