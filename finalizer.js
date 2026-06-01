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

// ─── Causal finalizer for v0.7 ───────────────────────────────────────────────

function normalizeCausalOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return null;
  return {
    chain: Array.isArray(outcome.chain) ? outcome.chain.map(e => ({
      from: e.from || '',
      to: e.to || '',
      relation: e.relation || '',
      strength: typeof e.strength === 'number' ? e.strength : 0.5,
      confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
    })) : [],
    impact: typeof outcome.impact === 'number' ? outcome.impact : 0.5,
    confidence: typeof outcome.confidence === 'number' ? outcome.confidence : 0.5,
    description: normalizeText(outcome.description || ''),
  };
}

function normalizeCausalRisk(risk) {
  if (!risk || typeof risk !== 'object') return null;
  return {
    chain: Array.isArray(risk.chain) ? risk.chain : [],
    severity: risk.severity === 'critical'
      ? 'critical'
      : (risk.severity === 'high'
        ? 'high'
        : (risk.severity === 'low'
          ? 'low'
          : (risk.severity === 'unknown'
            ? 'unknown'
            : 'medium'))),
    description: normalizeText(risk.description || ''),
  };
}

function normalizeCausalEvidenceItem(item) {
  if (item === undefined || item === null) return null;
  if (typeof item === 'string') {
    return { type: 'text', value: normalizeText(item) };
  }
  if (typeof item !== 'object') {
    return { type: 'value', value: item };
  }
  const normalized = cloneValue(item);
  if (Object.prototype.hasOwnProperty.call(normalized, 'description')) {
    normalized.description = normalizeText(normalized.description || '');
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'value')) {
    normalized.value = extractText(normalized.value) || normalized.value;
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'confidence')) {
    const num = Number(normalized.confidence);
    normalized.confidence = Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
  }
  return normalized;
}

function normalizeCausalEvidence(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return dedupeStable(items.map(normalizeCausalEvidenceItem).filter(Boolean));
}

function normalizeAffectedNode(node) {
  if (!node || typeof node !== 'object') return null;
  return {
    nodeId: normalizeText(node.nodeId || node.id || ''),
    label: normalizeText(node.label || node.nodeId || node.id || ''),
    relation: normalizeText(node.relation || ''),
    effect: normalizeText(node.effect || ''),
    impact: typeof node.impact === 'number' ? Math.max(0, Math.min(1, node.impact)) : 0,
    confidence: typeof node.confidence === 'number' ? Math.max(0, Math.min(1, node.confidence)) : 0,
    severity: node.severity === 'critical'
      ? 'critical'
      : node.severity === 'high'
        ? 'high'
        : node.severity === 'medium'
          ? 'medium'
          : node.severity === 'low'
            ? 'low'
            : 'unknown',
    path: Array.isArray(node.path) ? dedupeStable(node.path.map(step => normalizeText(step)).filter(Boolean)) : [],
  };
}

function normalizeCausalChain(chain) {
  if (!Array.isArray(chain)) return [];
  return chain.map(step => {
    if (!step || typeof step !== 'object') return null;
    return {
      from: normalizeText(step.from || ''),
      to: normalizeText(step.to || ''),
      relation: normalizeText(step.relation || ''),
      strength: typeof step.strength === 'number' ? Math.max(0, Math.min(1, step.strength)) : 0.5,
      confidence: typeof step.confidence === 'number' ? Math.max(0, Math.min(1, step.confidence)) : 0.5,
      source: normalizeText(step.source || 'manual'),
      source_ref: normalizeText(step.source_ref || ''),
      evidence: normalizeEvidence(step.evidence),
      evidence_type: normalizeText(step.evidence_type || ''),
      created_at: normalizeText(step.created_at || ''),
      updated_at: normalizeText(step.updated_at || ''),
    };
  }).filter(Boolean);
}

function deriveCausalRiskLevel(risks, confidence = 0, causalChains = 0, evidence = []) {
  if (!Array.isArray(risks) || risks.length === 0) {
    if (causalChains === 0 || !Array.isArray(evidence) || evidence.length === 0) {
      return 'unknown';
    }
    return confidence >= 0.75 ? 'low' : 'unknown';
  }

  if (risks.some(r => r.severity === 'critical')) return 'critical';
  if (risks.some(r => r.severity === 'high')) return 'high';
  if (risks.some(r => r.severity === 'medium')) return 'medium';
  if (risks.some(r => r.severity === 'low')) return 'low';
  return 'unknown';
}

function causalRiskMessage(riskLevel) {
  switch (riskLevel) {
    case 'critical':
      return 'Değişiklik önerilmiyor.';
    case 'high':
      return 'Yüksek risk; insan onayı gerekir.';
    case 'medium':
      return 'Dikkatli uygulanmalı.';
    case 'low':
      return 'Düşük risk.';
    default:
      return 'Yetersiz causal veri.';
  }
}

function deriveCausalConclusion({ riskLevel, recommendation, confidence, causalChains }) {
  const head = `Karar: ${causalRiskMessage(riskLevel)}`;
  const recommendationText = recommendation ? ` Öneri: ${normalizeText(recommendation)}` : '';
  const confidenceText = ` Confidence: ${(Math.max(0, Math.min(1, confidence || 0)) * 100).toFixed(1)}%.`;
  const chainText = causalChains > 0 ? ` Causal chain count: ${causalChains}.` : ' Causal chain yok.';
  return `${head}${recommendationText}${confidenceText}${chainText}`.trim();
}

function deriveCausalNextQuestions({ unknowns, riskLevel }) {
  const questionSet = [];
  for (const unknown of unknowns) {
    const text = normalizeText(unknown);
    if (!text) continue;
    questionSet.push(/\?$/.test(text) ? text : `${text}?`);
  }

  if (riskLevel === 'critical' || riskLevel === 'high') {
    questionSet.push('Bu riski azaltmak için hangi alternatifler var?');
    questionSet.push('İnsan onayı veya ek kanıt gerekiyor mu?');
  } else if (riskLevel === 'medium') {
    questionSet.push('Bu kararı güvenli hale getirmek için hangi ek veri lazım?');
  } else if (riskLevel === 'unknown' && questionSet.length === 0) {
    questionSet.push('Bu causal zincir için hangi kanıt eksik?');
  }

  if (questionSet.length === 0) {
    questionSet.push('Bu sonuç hangi ek gözlemlerle doğrulanabilir?');
  }

  return dedupeStable(questionSet);
}

function buildCausalSummary(simulationResult = {}) {
  if (!simulationResult.ok) {
    return {
      ok: false,
      error: simulationResult.error || 'Simulation failed',
      outcomes: [],
      risks: [],
      summary: '',
    };
  }

  const outcomes = Array.isArray(simulationResult.outcomes)
    ? simulationResult.outcomes.map(normalizeCausalOutcome).filter(Boolean)
    : [];

  const risks = Array.isArray(simulationResult.risks)
    ? simulationResult.risks.map(normalizeCausalRisk).filter(Boolean)
    : [];

  const confidence = typeof simulationResult.confidence === 'number' ? simulationResult.confidence : 0;
  const causalChains = typeof simulationResult.causalChains === 'number' ? simulationResult.causalChains : 0;
  const isCausalMode =
    simulationResult.mode === 'causal' ||
    Array.isArray(simulationResult.affectedNodes) ||
    Array.isArray(simulationResult.unknowns) ||
    Array.isArray(simulationResult.traversal?.loops) ||
    Object.prototype.hasOwnProperty.call(simulationResult, 'riskLevel');

  const summary = simulationResult.summary || 
    `Simulation found ${outcomes.length} outcome(s) with ${risks.length} risk(s). Confidence: ${(confidence * 100).toFixed(1)}%`;

  if (!isCausalMode) {
    return {
      ok: true,
      action: normalizeText(simulationResult.action || ''),
      nodeId: simulationResult.nodeId || '',
      changeType: simulationResult.changeType || 'unknown',
      outcomes,
      risks,
      confidence,
      causalChains,
      summary,
      recommendation: deriveCausalRecommendation(risks, confidence),
    };
  }

  const affectedNodes = Array.isArray(simulationResult.affectedNodes)
    ? simulationResult.affectedNodes.map(normalizeAffectedNode).filter(Boolean)
    : [];
  const evidence = normalizeCausalEvidence(simulationResult.evidence);
  const unknowns = dedupeStable(
    (Array.isArray(simulationResult.unknowns) ? simulationResult.unknowns : simulationResult.unknowns ? [simulationResult.unknowns] : [])
      .map(item => extractText(item) || normalizeText(typeof item === 'string' ? item : JSON.stringify(item)))
      .filter(Boolean)
  );
  const recommendation = normalizeText(
    simulationResult.recommendation || deriveCausalRecommendation(risks, confidence)
  );
  const riskLevel = deriveCausalRiskLevel(risks, confidence, causalChains, evidence);
  const conclusion = deriveCausalConclusion({
    riskLevel,
    recommendation,
    confidence,
    causalChains,
  });
  const nextQuestions = deriveCausalNextQuestions({
    unknowns,
    riskLevel,
  });
  const input = simulationResult.input && typeof simulationResult.input === 'object'
    ? cloneValue(simulationResult.input)
    : {
        action: normalizeText(simulationResult.action || ''),
        nodeId: simulationResult.nodeId || '',
        changeType: simulationResult.changeType || 'unknown',
        newState: typeof simulationResult.newState === 'undefined' ? null : cloneValue(simulationResult.newState),
      };

  return {
    ok: true,
    mode: 'causal',
    input,
    action: normalizeText(simulationResult.action || ''),
    nodeId: simulationResult.nodeId || '',
    changeType: simulationResult.changeType || 'unknown',
    conclusion,
    riskLevel,
    outcomes,
    risks,
    confidence,
    causalChains,
    affectedNodes,
    evidence,
    unknowns,
    recommendation,
    nextQuestions,
    summary,
    traversal: simulationResult.traversal && typeof simulationResult.traversal === 'object'
      ? cloneValue(simulationResult.traversal)
      : undefined,
  };
}

function deriveCausalRecommendation(risks, confidence) {
  if (risks.length === 0) {
    if (confidence > 0.7) {
      return 'Değişiklik güvenli görünüyor, yüksek confidence ile ilerlenebilir.';
    }
    return 'Risk yok ancak confidence düşük, daha fazla kanıt gerekli.';
  }

  const criticalRisks = risks.filter(r => r.severity === 'critical');
  if (criticalRisks.length > 0) {
    return `KRİTİK: ${criticalRisks.length} kritik risk tespit edildi. Değişiklik önerilmiyor.`;
  }

  const highRisks = risks.filter(r => r.severity === 'high');
  if (highRisks.length > 0) {
    return `YÜKSEK RİSK: ${highRisks.length} yüksek risk tespit edildi. Dikkatli ilerleyin veya alternatif değerlendirin.`;
  }

  return `${risks.length} risk tespit edildi. Riskleri değerlendirip ilerleyin.`;
}

module.exports = {
  buildFinalSummary,
  buildCausalSummary,
  deriveCausalRecommendation,
  cleanFactText,
  deriveMode,
  extractText,
  normalizeEvidence,
  normalizeText,
};
