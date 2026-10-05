'use strict';

/**
 * Contract tests for the read-only candidate Action IR (#3476, L2).
 *
 * The point of these tests is the *contract*, not the guard: the IR composes
 * the L1 record (`common-semantic-ir`) and the shipped external-action
 * decision (`external-action-envelope` + `external-action-guard`) without
 * re-deriving either, keeps verification/policy/execution separate, and fails
 * closed -- no plan is authorized without a verified condition and an `allow`
 * policy decision. An unsafe or unknown plan can never produce an authorized
 * execution envelope, and the validator refuses a record that tries to forge
 * one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  ACTION_IR_VERSION,
  ACTION_IR_FIELDS,
  PLAN_SAFETY,
  buildActionIR,
  validateActionIR,
} = require('../lib/action-ir');
const { AGENT_IDENTITY_CARD_SCHEMA_VERSION } = require('../lib/external-action-identity');
const { evaluateExternalAction } = require('../lib/external-action-guard');
const { parseCommand } = require('../lib/command-parser');

const WORKSPACE_ROOT = process.cwd();
const NOW = '2026-01-01T12:00:00.000Z';
const nowOpt = () => NOW;
const OPTS = { now: nowOpt, requireSignedIdentityCard: false, cwd: WORKSPACE_ROOT, workspaceRoot: WORKSPACE_ROOT };

function card(overrides = {}) {
  return {
    schemaVersion: AGENT_IDENTITY_CARD_SCHEMA_VERSION,
    agentId: 'action-ir-agent',
    agentName: 'action-ir-agent',
    agentVersion: '1.0.0',
    ownerActorId: 'actor:test',
    workspaceId: 'default',
    capabilities: ['file_read', 'shell'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function action(overrides = {}) {
  return {
    invocationId: 'inv-1',
    agentName: 'action-ir-agent',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolName: 'Read',
    args: { file_path: path.join(WORKSPACE_ROOT, 'README.md') },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
    identity: card(),
    ...overrides,
  };
}

test('the record declares its version and every declared field', () => {
  const ir = buildActionIR({ text: 'read README', action: action() }, OPTS);
  assert.equal(ir.version, ACTION_IR_VERSION);
  for (const name of ACTION_IR_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(ir, name), `${name} must be present`);
    assert.ok(ir[name] && typeof ir[name] === 'object', `${name} must be a {status,value} entry`);
  }
  assert.deepEqual(validateActionIR(ir), { valid: true, errors: [] });
});

test('the shipped surfaces are carried through unchanged, not re-derived', () => {
  const text = 'neden hava sıcak';
  const input = { text, action: action() };
  const ir = buildActionIR(input, OPTS);

  // Plan intent is the L1 record's intent, which is the command-parser's output.
  assert.equal(ir.plan.status, 'present');
  const commanded = parseCommand(text);
  assert.equal(ir.plan.value.intent.name, commanded.command);

  // Policy is exactly what the guard returns for the same normalized action.
  const direct = evaluateExternalAction(action(), OPTS);
  assert.equal(ir.policy.value.decision, direct.decision);
  assert.equal(ir.policy.value.reason, direct.reason);
});

test('a verified read in the workspace is the one authorized case', () => {
  const ir = buildActionIR({ text: 'neden hava sıcak', action: action() }, OPTS);
  assert.equal(ir.verification.value.verified, true);
  assert.equal(ir.policy.value.decision, 'allow');
  assert.equal(ir.planSafety.value, PLAN_SAFETY.SAFE);
  assert.equal(ir.execution.value.authorized, true);
  assert.equal(ir.execution.value.reason, 'condition_verified_and_authorized');
});

test('an unsafe plan is never authorized, whatever the condition says', () => {
  const ir = buildActionIR(
    { text: 'clean up', action: action({ toolName: 'Bash', args: { command: 'rm -rf /' } }) },
    OPTS,
  );
  assert.equal(ir.policy.value.decision, 'block');
  assert.equal(ir.planSafety.value, PLAN_SAFETY.UNSAFE);
  assert.equal(ir.execution.value.authorized, false);
  assert.equal(ir.execution.value.reason, ir.policy.value.reason);
});

test('a plan needing human review is not authorized', () => {
  const ir = buildActionIR(
    { text: 'search tree', action: action({ toolName: 'Bash', args: { command: 'find . -exec ls {} ;' } }) },
    OPTS,
  );
  assert.equal(ir.policy.value.decision, 'review');
  assert.equal(ir.planSafety.value, PLAN_SAFETY.UNSAFE);
  assert.equal(ir.execution.value.authorized, false);
});

test('an unverified condition blocks authorization even when policy would allow', () => {
  // An unrecognized command leaves the L1 intent `unknown`; the guard would
  // allow the same read action, but the condition is not verified.
  const ir = buildActionIR({ text: 'zzz qqq wibble', action: action() }, OPTS);
  assert.equal(ir.verification.value.verified, false);
  assert.ok(ir.verification.value.checks.some((check) => check.name === 'plan_understood' && check.passed === false));
  assert.equal(ir.policy.value.decision, 'allow');
  assert.equal(ir.execution.value.authorized, false);
  assert.equal(ir.planSafety.value, PLAN_SAFETY.UNKNOWN);
});

test('a malformed action envelope is unknown, never authorized', () => {
  const ir = buildActionIR(
    { text: 'read README', action: { toolName: 'Read', args: { file_path: path.join(WORKSPACE_ROOT, 'README.md') } } },
    OPTS,
  );
  assert.equal(ir.planSafety.value, PLAN_SAFETY.UNKNOWN);
  assert.equal(ir.execution.value.authorized, false);
  assert.ok(ir.verification.value.checks.some((check) => check.name === 'envelope_well_formed' && check.passed === false));
});

test('a language the baseline cannot identify stays unknown and cannot widen policy', () => {
  const ir = buildActionIR({ text: 'audit receipts', action: action() }, OPTS);
  assert.equal(ir.language.status, 'unknown');
  assert.ok(ir.language.reason.length > 0);
  // The language is unknown but the plan is understood and the action's
  // condition is verified, so the policy core is unchanged: the same read
  // action still decides `allow`.
  assert.equal(ir.verification.value.verified, true);
  assert.equal(ir.policy.value.decision, 'allow');
});

test('empty input fails closed on every measured field', () => {
  const ir = buildActionIR({}, OPTS);
  assert.equal(ir.plan.status, 'unknown');
  assert.equal(ir.verification.status, 'unknown');
  assert.equal(ir.policy.status, 'unknown');
  assert.equal(ir.planSafety.status, 'unknown');
  assert.equal(ir.execution.status, 'present');
  assert.equal(ir.execution.value.authorized, false);
  assert.deepEqual(validateActionIR(ir), { valid: true, errors: [] });
});

test('the validator refuses a forged authorized execution envelope', () => {
  const ir = buildActionIR({ text: 'read README', action: action() }, OPTS);
  const forged = { ...ir, execution: { status: 'present', value: { ...ir.execution.value, authorized: true } }, policy: { status: 'present', value: { decision: 'block', reason: 'x' } } };
  const { valid, errors } = validateActionIR(forged);
  assert.equal(valid, false);
  assert.ok(errors.some((error) => /without an allow policy decision/.test(error)));
});

test('the validator refuses authorization for a plan that is not safe', () => {
  const ir = buildActionIR({ text: 'neden hava sıcak', action: action() }, OPTS);
  const forged = {
    ...ir,
    planSafety: { status: 'present', value: PLAN_SAFETY.UNKNOWN },
    execution: { status: 'present', value: { ...ir.execution.value, authorized: true } },
  };
  const { valid, errors } = validateActionIR(forged);
  assert.equal(valid, false);
  assert.ok(errors.some((error) => /not safe/.test(error)));
});

test('the validator rejects a record that hides a value behind unknown or drops a field', () => {
  const ir = buildActionIR({ text: 'read README', action: action() }, OPTS);
  const hidden = { ...ir, confidence: { status: 'unknown', value: 0.9, reason: 'x' } };
  assert.equal(validateActionIR(hidden).valid, false);

  const dropped = { ...ir };
  delete dropped.plan;
  const result = validateActionIR(dropped);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /^plan must be an object/.test(error)));
});

test('building the IR is read-only: an unsafe plan runs nothing', () => {
  const marker = path.join(WORKSPACE_ROOT, 'action-ir-should-not-exist.tmp');
  const ir = buildActionIR(
    { text: 'write marker', action: action({ toolName: 'Write', args: { file_path: marker, content: 'x' } }) },
    OPTS,
  );
  assert.equal(ir.execution.value.authorized, false);
  assert.equal(require('node:fs').existsSync(marker), false);
});

test('a secret-looking command is redacted in the plan and the execution envelope', () => {
  // Assembled at runtime so the fixture never contains a literal credential.
  const secret = ['sk', 'live', '0123456789abcdef'].join('-');
  const ir = buildActionIR(
    { text: 'run', action: action({ toolName: 'Bash', args: { command: `deploy ${secret}` } }) },
    OPTS,
  );
  assert.ok(!JSON.stringify(ir).includes(secret));
  assert.match(ir.execution.value.envelope.command, /REDACTED/);
});
