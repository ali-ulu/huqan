const { toCanonicalVerifyStatus } = require('./verify-status-vocabulary');

function normalizeCheck(result) {
  const data = result && typeof result === 'object' && result.data && typeof result.data === 'object'
    ? result.data
    : result;

  // Reader accepts both vocabularies (RFC-001 compatibility rule): a check may
  // arrive from the kernel already canonical, from the API boundary, or from a
  // caller still holding a legacy value. Normalized to canonical, which is now
  // what the kernel itself produces.
  const status = toCanonicalVerifyStatus(data?.status);
  const confidence = Number.isFinite(data?.confidence) ? data.confidence : 0;

  return {
    status,
    confidence,
    raw: result,
  };
}

function classifyLlmSor(huqanCheck, llmCheck) {
  const huqanStatus = normalizeCheck(huqanCheck).status;
  const answerStatus = normalizeCheck(llmCheck).status;

  if (huqanStatus === 'contradicted' || answerStatus === 'contradicted') {
    return 'contradicted';
  }

  if (answerStatus === 'verified') {
    return 'graph-backed';
  }

  if (huqanStatus === 'verified') {
    return 'llm-assisted';
  }

  return 'unsupported';
}

function buildShieldMeta(label, huqanCheck, llmCheck, autoLearn) {
  const huqan = normalizeCheck(huqanCheck);
  const answer = normalizeCheck(llmCheck);
  const baseConfidence = Math.max(huqan.confidence || 0, answer.confidence || 0);
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
  // RFC-001 decision 7: the reader accepts both spellings. `axiomCheck` is the
  // AXIOM-era name and stays accepted; `huqanCheck` is canonical and wins when
  // both are supplied.
  huqanCheck,
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
  const suppliedCheck = huqanCheck !== undefined ? huqanCheck : axiomCheck;
  const huqan = normalizeCheck(suppliedCheck || kernel.verify(question || '', verifyOpts));
  const answer = normalizeCheck(llmCheck || kernel.verify(llmTextStr, verifyOpts));
  const label = classifyLlmSor(huqan, answer);
  const shield = buildShieldMeta(label, huqan, answer, autoLearn);
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
  }

  return {
    label,
    shield,
    huqanCheck: huqan,
    // Emitted alongside the canonical name, not instead of it: this field is
    // part of the /llm-sor response body, so dropping it would break a caller
    // that already reads it. Removal needs its own announced breaking release.
    axiomCheck: huqan,
    llmCheck: answer,
    partialVerification,
    learnResult,
  };
}

/**
 * The question-check fields for an /llm-sor response body.
 *
 * Both names carry the same value. `huqanCheck` is canonical; `axiomCheck` is
 * the AXIOM-era name and is emitted alongside it, not instead of it, so a
 * caller already reading it keeps working. Removing it needs its own announced
 * breaking release, per RFC-001.
 *
 * A helper rather than two inline properties because server.js sits on the
 * file-size ratchet in scripts/check-file-size.js and may not grow.
 */
function llmSorCheckFields(check) {
  return { huqanCheck: check, axiomCheck: check };
}

module.exports = {
  llmSorCheckFields,
  normalizeCheck,
  classifyLlmSor,
  evaluateLlmSor,
};
