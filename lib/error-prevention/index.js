'use strict';

const { ErrorPrevention } = require('./engine');
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
  normalizeAction,
};
