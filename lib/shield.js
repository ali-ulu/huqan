function normalizeCheck(result) {
  const data = result && typeof result === 'object' && result.data && typeof result.data === 'object'
    ? result.data
    : result;

  const status = typeof data?.status === 'string' ? data.status : 'bilinmiyor';
  const confidence = Number.isFinite(data?.confidence) ? data.confidence : 0;

  return {
    status,
    confidence,
    raw: result,
  };
}

function classifyLlmSor(axiomCheck, llmCheck) {
  const axiomStatus = normalizeCheck(axiomCheck).status;
  const answerStatus = normalizeCheck(llmCheck).status;

  if (axiomStatus === 'celiski' || answerStatus === 'celiski') {
    return 'contradicted';
  }

  if (answerStatus === 'dogrulandi') {
    return 'graph-backed';
  }

  if (axiomStatus === 'dogrulandi') {
    return 'llm-assisted';
  }

  return 'unsupported';
}

function buildShieldMeta(label, axiomCheck, llmCheck, autoLearn) {
  const axiom = normalizeCheck(axiomCheck);
  const answer = normalizeCheck(llmCheck);
  const baseConfidence = Math.max(axiom.confidence || 0, answer.confidence || 0);
  let confidence = baseConfidence;
  let source = 'parsed';

  if (label === 'graph-backed') {
    confidence = Math.max(confidence, 0.8);
    source = 'graph';
  } else if (label === 'llm-assisted') {
    confidence = Math.max(0.35, confidence * 0.6);
    source = 'llm';
  } else if (label === 'contradicted') {
    confidence = Math.max(confidence, 0.7);
    source = 'graph';
  }

  const shouldLearn = Boolean(autoLearn) && label !== 'unsupported' && label !== 'contradicted';

  return {
    label,
    source,
    confidence,
    autoLearn: Boolean(autoLearn),
    shouldLearn,
  };
}

function evaluateLlmSor({
  kernel,
  question,
  llmText,
  axiomCheck,
  llmCheck,
  autoLearn = false,
  maxSentences = 15,
  workspaceId = 'default',
}) {
  if (!kernel || typeof kernel.verify !== 'function') {
    throw new Error('kernel.verify gerekli');
  }

  const llmTextStr = String(llmText || '');
  const totalLength = llmTextStr.length;
  const verifyOpts = workspaceId ? { workspaceId } : {};
  const axiom = normalizeCheck(axiomCheck || kernel.verify(question || '', verifyOpts));
  const answer = normalizeCheck(llmCheck || kernel.verify(llmTextStr, verifyOpts));
  const label = classifyLlmSor(axiom, answer);
  const shield = buildShieldMeta(label, axiom, answer, autoLearn);
  const partialVerification = totalLength > 300
    ? { verifiedPrefix: 300, totalLength, fullTextVerified: true }
    : null;

  let learnResult = null;
  if (shield.shouldLearn && typeof kernel.learnFromLLM === 'function' && llmText) {
    const learnOpts = {
      skipConflicts: true,
      maxSentences,
      source: shield.source,
      confidence: shield.confidence,
      workspaceId,
    };
    try {
      learnResult = kernel.learnFromLLM(llmText, learnOpts);
    } catch (err) {
      learnResult = {
        ok: false,
        error: {
          code: 'LEARN_FAILED',
          message: err && err.message ? err.message : String(err),
        },
      };
    }
    if (
      learnResult &&
      learnResult.ok !== false &&
      typeof learnResult.learned === 'number' &&
      learnResult.learned > 0
    ) {
      const save = kernel.graph && kernel.graph.save;
      if (typeof save === 'function') {
        save.call(kernel.graph);
      }
    }
  }

  return {
    label,
    shield,
    axiomCheck: axiom,
    llmCheck: answer,
    partialVerification,
    learnResult,
  };
}

module.exports = {
  normalizeCheck,
  classifyLlmSor,
  evaluateLlmSor,
};
