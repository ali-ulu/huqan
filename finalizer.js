function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return normalizeText(value);
  if (typeof value !== 'object') return normalizeText(value);
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
    const text = extractText(candidate);
    if (text) return text;
  }
  return '';
}

function normalizeEvidenceItem(item) {
  if (item === undefined || item === null) return null;
  if (typeof item === 'string') {
    return { type: 'text', value: normalizeText(item) };
  }
  if (typeof item !== 'object') {
    return { type: 'value', value: item };
  }
  const normalized = cloneValue(item);
  if (Object.prototype.hasOwnProperty.call(normalized, 'value')) {
    normalized.value = extractText(normalized.value) || normalized.value;
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'confidence')) {
    const num = Number(normalized.confidence);
    normalized.confidence = Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
  }
  return normalized;
}

function normalizeEvidence(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(normalizeEvidenceItem).filter(Boolean);
}

function stableKey(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `str:${foldText(value)}`;
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  return `obj:${JSON.stringify(value)}`;
}

function dedupeStable(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = stableKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function cleanFactText(text) {
  const value = normalizeText(text);
  if (!value) return '';
  return value
    .replace(/^(ask|verify|reason|dream|compare|learn|plan|summary|result|analysis)\s*[:\-]\s*/i, '')
    .replace(/^[\-•\u2022]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUnknownText(text) {
  const value = foldText(text);
  return /(bilinmiyor|bilmiyorum|unknown|insufficient|yetersiz|no data|not enough|belirsiz|unclear)/.test(value);
}

function isContradictionText(text) {
  const value = foldText(text);
  return /(celiski|celik|contradict|conflict|blocked)/.test(value);
}

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
    return 'Bu sonuç graf ile çelişiyor.';
  }
  if (mode === 'llm-assisted') {
    return 'LLM destekli çıktı graf ile kısmen desteklendi.';
  }
  if (!knownFacts.length && unknowns.length) {
    return 'Mevcut bilgi yetersiz.';
  }
  if (knownFacts.length && unknowns.length) {
    return 'Bilinenler ayrıldı, ancak bazı sorular açık kaldı.';
  }
  if (knownFacts.length) {
    return 'Bilinenler graf tarafından destekleniyor.';
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
      questionSet.push(`Karşılaştırma için eksik taraf nedir?`);
    } else if (objective === 'reason' && goal) {
      questionSet.push(`Bu sonuç için hangi ek kanıt gerekli?`);
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

module.exports = {
  buildFinalSummary,
  cleanFactText,
  deriveMode,
  extractText,
  normalizeEvidence,
  normalizeText,
};
