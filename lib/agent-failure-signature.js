'use strict';

const { lower } = require('./agent-memory-state');

function stepFailureSignature(step = {}, state = {}) {
  const tool = String(step.tool || '').trim();
  const action = String(step.action || '').trim();
  // Structured inputs such as dream's `{}` do not identify a goal. The
  // recorder and policy must use this same goal-scoped, normalized key.
  const rawInput = typeof step.input === 'string' && step.input.trim()
    ? step.input
    : state.goal || '';
  return `${tool}|${action}|${lower(rawInput)}`;
}

module.exports = { stepFailureSignature };
