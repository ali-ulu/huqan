'use strict';

// The result envelope every default workflow tool returns (#2133).

const { normalizeConfidence, normalizeEvidence, normalizeError } = require('./workflow-values');

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeToolInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...input };
  }
  if (typeof input === 'string') {
    return { text: input };
  }
  return { value: input };
}

function buildEnvelope({ ok, tool, status, data, evidence = [], confidence, error = null, meta = {} }) {
  const normalizedEvidence = normalizeEvidence(evidence);
  return {
    ok: Boolean(ok),
    tool,
    status,
    data: cloneValue(data),
    output: cloneValue(data),
    evidence: normalizedEvidence,
    confidence: normalizeConfidence(confidence, ok ? 0.5 : 0),
    error: error ? normalizeError(error, ok ? 'ERROR' : (error.code || 'ERROR'), error.message || 'Tool execution failed.') : null,
    trace: [{
      phase: 'adapter',
      tool,
      status,
      evidenceCount: normalizedEvidence.length,
      confidence: normalizeConfidence(confidence, ok ? 0.5 : 0),
    }],
    errors: error ? [normalizeError(error, error.code || 'ERROR', error.message || 'Tool execution failed.')] : [],
    meta: {
      tool,
      adapter: 'workflow-tools',
      ...meta,
    },
  };
}

function resultFromKernel(tool, kernelResult, fallbackData = null, meta = {}) {
  const hasEnvelope = kernelResult && typeof kernelResult === 'object' && Object.prototype.hasOwnProperty.call(kernelResult, 'ok');
  const ok = hasEnvelope ? Boolean(kernelResult.ok) : true;
  const rawData = hasEnvelope
    ? (kernelResult.data !== undefined ? kernelResult.data : kernelResult)
    : (kernelResult !== undefined ? kernelResult : fallbackData);
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) && fallbackData && typeof fallbackData === 'object' && !Array.isArray(fallbackData)
    ? { ...cloneValue(fallbackData), ...cloneValue(rawData) }
    : cloneValue(rawData);
  const evidence = hasEnvelope ? (kernelResult.evidence || []) : [];
  const confidence = hasEnvelope
    ? (kernelResult.data && typeof kernelResult.data.confidence === 'number'
      ? kernelResult.data.confidence
      : kernelResult.confidence ?? fallbackData?.confidence ?? 0.5)
    : (fallbackData && typeof fallbackData.confidence === 'number' ? fallbackData.confidence : 0.5);

  return buildEnvelope({
    ok,
    tool,
    status: ok ? 'done' : 'error',
    data,
    evidence,
    confidence,
    error: hasEnvelope ? kernelResult.error : null,
    meta,
  });
}

module.exports = {
  cloneValue,
  normalizeToolInput,
  buildEnvelope,
  resultFromKernel,
};
