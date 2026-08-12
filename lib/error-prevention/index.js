'use strict';

const { ErrorPrevention } = require('./engine');
const { mergeWithUpstreamVerdict } = require('./decision');
const { buildActionFingerprint, buildFailureFingerprint, normalizeAction } = require('./fingerprint');
const { classifyFailureTrust } = require('./trust');

function createErrorPrevention(memoryStore, options = {}) {
  return new ErrorPrevention(memoryStore, options);
}

module.exports = {
  ErrorPrevention,
  buildActionFingerprint,
  buildFailureFingerprint,
  classifyFailureTrust,
  createErrorPrevention,
  mergeWithUpstreamVerdict,
  normalizeAction,
};
