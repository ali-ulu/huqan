'use strict';

const crypto = require('node:crypto');

const READ_ONLY = [/^git status\b/, /^git diff\b/, /^git log\b/, /^ls\b/, /^pwd\b/, /^cat\b/, /^echo\b/];
const BLOCKED = [/^git push\b/, /^npm publish\b/, /^chmod\b/, /^sudo\b/, /\brm -rf\b/];
const COMPOSITION = />|>>|<|\||;|&&|`|\$\(|\$\{/;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function classifyCommand(command) {
  const cmd = String(command).trim();
  if (BLOCKED.some((re) => re.test(cmd))) return 'block';
  if (COMPOSITION.test(cmd)) return 'review';
  if (READ_ONLY.some((re) => re.test(cmd))) return 'allow';
  return 'review';
}

function toShellEvent({ agentId, runId, stepId, command, observedState } = {}) {
  if (!agentId || !runId || !stepId || !command) {
    throw new Error('agentId, runId, stepId and command are required');
  }
  return Object.freeze({
    schemaVersion: 'huqan.external-event.v1',
    agent_id: String(agentId),
    run_id: String(runId),
    step_id: String(stepId),
    action: 'shell.requested',
    target: `shell:${String(command).slice(0, 256)}`,
    input_hash: sha256Hex(`${agentId}:${runId}:${stepId}:${command}`),
    observed_state: String(observedState || 'shell action proposed, awaiting gate decision'),
    decision: classifyCommand(command),
    receipt_id: null,
  });
}

module.exports = { toShellEvent, classifyCommand };
