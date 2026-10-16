'use strict';

/**
 * V5-C3 — Bounded A2A Trust Evidence: schema and fixtures.
 *
 * Controlling pack:
 * docs/task-packs/v5-c3-a2a-trust-evidence-authorization.md
 *
 * Thesis under test: HUQAN does not standardize how agents delegate work, it
 * standardizes evidence for comparing delegated intent with observed execution.
 * Every assertion below defends one of the four separable sections, the
 * requestedOutput/observedOutcome split, or the forbidden scope.
 *
 * Reconciliation is evaluated here from the fixture's own delegation and
 * observation sections rather than trusted from its `reconciliation` block, so
 * a fixture cannot pass by simply asserting its own verdict.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CANONICAL_VERDICTS } = require('../lib/verdict/action-verdict');

const SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'v5', 'a2a-trust-evidence.schema.json');
const IDENTITY_SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'v5', 'agent-identity.schema.json');
const FIXTURES = path.join(__dirname, 'fixtures', 'v5', 'a2a-trust-evidence');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const schema = readJson(SCHEMA_PATH);
const identitySchema = readJson(IDENTITY_SCHEMA_PATH);
const fixture = (name) => readJson(path.join(FIXTURES, name));

// --- a JSON Schema subset covering exactly what this schema uses ------------
// No validator dependency is added; the pack forbids one.

function validate(value, node, root, at = '') {
  const errors = [];
  if (node.$ref) {
    const target = node.$ref.replace(/^#\//, '').split('/').reduce((n, k) => n[k], root);
    return validate(value, target, root, at);
  }
  const types = Array.isArray(node.type) ? node.type : (node.type ? [node.type] : []);
  const matches = (t) => (
    (t === 'object' && value && typeof value === 'object' && !Array.isArray(value))
    || (t === 'array' && Array.isArray(value))
    || (t === 'string' && typeof value === 'string')
    || (t === 'number' && typeof value === 'number')
    || (t === 'integer' && Number.isInteger(value))
    || (t === 'null' && value === null)
  );
  if (types.length && !types.some(matches)) return [`${at || '<root>'}: expected ${types.join('|')}`];

  if (node.const !== undefined && value !== node.const) errors.push(`${at}: must equal ${node.const}`);
  if (node.enum && !node.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${at}: too short`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${at}: pattern mismatch`);
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${at}: too few items`);
    if (node.items) value.forEach((v, i) => errors.push(...validate(v, node.items, root, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of node.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) errors.push(`${at}: missing "${req}"`);
    }
    if (node.additionalProperties === false && node.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(node.properties, key)) errors.push(`${at}: unexpected "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(node.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validate(value[key], sub, root, at ? `${at}.${key}` : key));
      }
    }
  }
  return errors;
}

const validateEnvelope = (env) => validate(env, schema, schema);

// --- reconciliation, derived rather than trusted ---------------------------

function reconcile(env) {
  const reasons = [];
  const d = env.delegation;
  const o = env.observation;
  const e = env.evidence;

  const scopeMatch = d.delegationScope.includes(o.observedAction.capability) ? 'pass' : 'fail';
  if (scopeMatch === 'fail') reasons.push('scope_exceeded');

  let requestedVsObservedMatch;
  if (o.observedOutcome.status === 'unknown') {
    requestedVsObservedMatch = 'unknown';
    reasons.push('observation_unknown');
  } else {
    const sameCapability = d.requestedAction.capability === o.observedAction.capability;
    const sameTarget = d.requestedAction.target === o.observedAction.target;
    const completed = o.observedOutcome.status === 'observed_completed';
    const effectMatches = o.effectSummary === d.requestedOutput.expectedEffectSummary;
    requestedVsObservedMatch = (sameCapability && sameTarget && completed && effectMatches) ? 'pass' : 'fail';
    if (requestedVsObservedMatch === 'fail' && scopeMatch === 'pass') reasons.push('requested_output_mismatch');
  }

  const chain = d.delegationChain;
  const chainOk = chain.length >= 2
    && chain[0] === d.sourceAgent.agentId
    && chain[chain.length - 1] === d.targetAgent.agentId;
  const delegationChainValid = chainOk ? 'pass' : 'fail';
  if (!chainOk) reasons.push('delegation_chain_broken');

  const withinExpiry = (d.expiresAt === null || Date.parse(o.observedAt) <= Date.parse(d.expiresAt))
    ? 'pass' : 'fail';
  if (withinExpiry === 'fail') reasons.push('delegation_expired');

  const evidenceSufficient = (e.evidenceRefs.length > 0 && e.trustReceipt !== null) ? 'pass' : 'fail';
  if (evidenceSufficient === 'fail') reasons.push('evidence_missing');

  const checks = [scopeMatch, requestedVsObservedMatch, delegationChainValid, withinExpiry, evidenceSufficient];
  let verdict = 'allow';
  if (checks.includes('fail')) verdict = 'block';
  if (verdict === 'allow' && checks.includes('unknown')) verdict = 'review';
  // A mismatch that is not a boundary violation is reviewable, not a block.
  if (verdict === 'block' && reasons.length === 1 && reasons[0] === 'requested_output_mismatch') verdict = 'review';

  return {
    scopeMatch,
    requestedVsObservedMatch,
    delegationChainValid,
    withinExpiry,
    evidenceSufficient,
    verdict,
    reasonCodes: reasons.length ? reasons : ['ok'],
  };
}

describe('V5-C3: the four sections stay separable', () => {
  it('the envelope requires all four sections and nothing else at the top', () => {
    for (const section of ['delegation', 'observation', 'evidence', 'reconciliation']) {
      assert.ok(schema.required.includes(section), `${section} must be required`);
      assert.ok(schema.properties[section], `${section} must be a top-level section`);
    }
    assert.equal(schema.additionalProperties, false);
  });

  it('requestedOutput and observedOutcome are separate required fields', () => {
    const delegation = schema.properties.delegation;
    const observation = schema.properties.observation;
    assert.ok(delegation.required.includes('requestedOutput'));
    assert.ok(observation.required.includes('observedOutcome'));
    // The failure mode this gate exists to prevent: one merged `output` field.
    assert.equal(delegation.properties.output, undefined);
    assert.equal(observation.properties.output, undefined);
    assert.equal(schema.properties.output, undefined);
  });

  it('observedOutcome can represent unknown, and unknown is not a pass', () => {
    const status = schema.properties.observation.properties.observedOutcome.properties.status;
    assert.ok(status.enum.includes('unknown'));
    assert.deepEqual(schema.$defs.checkResult.enum, ['pass', 'fail', 'unknown']);
  });

  it('identity, scope, chain and expiry are referenced, not re-modelled', () => {
    const agentRef = schema.$defs.agentRef;
    assert.deepEqual(agentRef.required, ['agentId', 'identityRef']);
    // agent-identity owns these; the envelope must not redeclare them.
    for (const owned of ['allowed_tools', 'allowed_memory_scopes', 'risk_tier', 'trust_tier',
      'revoked_at', 'parent_agent_id', 'verification_status']) {
      assert.ok(identitySchema.properties[owned], `${owned} should exist in agent-identity`);
      assert.equal(agentRef.properties[owned], undefined, `${owned} must not be re-modelled in agentRef`);
    }
    assert.match(agentRef.properties.identityRef.description, /agent-identity\.schema\.json/);
  });

  it('the canonical verdict vocabulary is reused, not re-declared', () => {
    assert.deepEqual(
      schema.properties.reconciliation.properties.verdict.enum,
      CANONICAL_VERDICTS,
    );
  });
});

describe('V5-C3: forbidden scope stays out of the schema', () => {
  // Checked against declared property names and enum values, not raw text: the
  // document legitimately contains "https://" in $id and $schema.
  function collectKeys(node, acc = new Set()) {
    if (Array.isArray(node)) { node.forEach((n) => collectKeys(n, acc)); return acc; }
    if (!node || typeof node !== 'object') return acc;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object') {
        Object.keys(value).forEach((k) => acc.add(k.toLowerCase()));
      }
      collectKeys(value, acc);
    }
    return acc;
  }

  function collectEnums(node, acc = new Set()) {
    if (Array.isArray(node)) { node.forEach((n) => collectEnums(n, acc)); return acc; }
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node.enum)) node.enum.forEach((v) => acc.add(String(v).toLowerCase()));
    Object.values(node).forEach((v) => collectEnums(v, acc));
    return acc;
  }

  const keys = collectKeys(schema);
  const enums = collectEnums(schema);

  it('declares no discovery, routing, advertisement or transport field', () => {
    const forbiddenKeys = [
      'discovery', 'discover', 'route', 'routing', 'address', 'endpoint',
      'transport', 'protocol', 'retry', 'retries', 'timeout', 'callback',
      'capabilities', 'advertisement', 'advertise', 'subscribe', 'topic',
    ];
    for (const key of forbiddenKeys) {
      assert.equal(keys.has(key), false, `forbidden field declared: ${key}`);
    }
  });

  it('declares no generic task lifecycle state', () => {
    for (const state of ['queued', 'running', 'cancelled', 'canceled', 'pending', 'scheduled', 'retrying']) {
      assert.equal(enums.has(state), false, `forbidden lifecycle state: ${state}`);
    }
  });

  it('the action descriptor carries no lifecycle state', () => {
    assert.deepEqual(Object.keys(schema.$defs.actionDescriptor.properties).sort(),
      ['capability', 'parameters', 'target']);
  });
});

describe('V5-C3: the valid fixture reconciles to allow', () => {
  const env = fixture('valid.complete.json');

  it('matches the schema', () => {
    assert.deepEqual(validateEnvelope(env), []);
  });

  it('derived reconciliation agrees with the recorded one', () => {
    assert.deepEqual(reconcile(env), env.reconciliation);
  });

  it('records who observed, and that it was not the executing agent', () => {
    assert.equal(env.observation.observedBy.observerRelation, 'third_party_observed');
  });
});

describe('V5-C3: every negative fixture fails closed with a specific reason', () => {
  const cases = [
    ['invalid.scope_exceeded.json', 'scope_exceeded', 'block'],
    ['invalid.requested_vs_observed_mismatch.json', 'requested_output_mismatch', 'review'],
    ['invalid.unknown_outcome.json', 'observation_unknown', 'review'],
    ['invalid.missing_evidence.json', 'evidence_missing', 'block'],
    ['invalid.expired_delegation.json', 'delegation_expired', 'block'],
    ['invalid.broken_delegation_chain.json', 'delegation_chain_broken', 'block'],
  ];

  for (const [name, reason, expectedVerdict] of cases) {
    it(`${name} -> ${reason} / ${expectedVerdict}`, () => {
      const env = fixture(name);
      assert.deepEqual(validateEnvelope(env), [], 'a negative fixture must still be schema-valid');

      const derived = reconcile(env);
      assert.ok(derived.reasonCodes.includes(reason), `expected ${reason}, got ${derived.reasonCodes}`);
      assert.equal(derived.verdict, expectedVerdict);
      assert.notEqual(derived.verdict, 'allow', 'must fail closed, never allow');
      assert.deepEqual(derived, env.reconciliation,
        'the recorded reconciliation must match what the sections actually imply');
    });
  }

  it('no negative fixture merely warns', () => {
    for (const [name] of cases) {
      const derived = reconcile(fixture(name));
      assert.ok(['block', 'review'].includes(derived.verdict));
      assert.ok(!derived.reasonCodes.includes('ok'));
    }
  });

  it('an unknown observation never reconciles to allow', () => {
    const env = fixture('invalid.unknown_outcome.json');
    assert.equal(env.observation.observedOutcome.status, 'unknown');
    assert.equal(env.observation.observedOutcome.unknownReason, 'contradictory_evidence');
    assert.notEqual(reconcile(env).verdict, 'allow');
  });
});

describe('V5-C3: falsification — is the envelope still meaningful without observation?', () => {
  const stripped = fixture('falsification.observation_and_evidence_removed.json');

  it('the stripped form is retained as a fixture', () => {
    assert.ok(stripped.delegation, 'it keeps the delegation section');
    assert.equal(stripped.observation, undefined);
    assert.equal(stripped.evidence, undefined);
    assert.equal(stripped.reconciliation, undefined);
  });

  it('it is rejected by the schema, so it is not a viable artifact', () => {
    const errors = validateEnvelope(stripped);
    assert.notDeepEqual(errors, [], 'removing observation and evidence must invalidate the envelope');
    for (const missing of ['observation', 'evidence', 'reconciliation']) {
      assert.ok(errors.some((e) => e.includes(`missing "${missing}"`)), `should report missing ${missing}`);
    }
  });

  it('what remains is an ordinary delegation request, which is the failure mode', () => {
    // If this were still a distinct HUQAN artifact, the schema would be too
    // general and the correct outcome would be BLOCKED_GAP. It is not: with
    // observation and evidence gone, nothing distinguishes it from the
    // delegation formats this gate deliberately does not compete with.
    assert.deepEqual(Object.keys(stripped).sort(),
      ['delegation', 'envelopeId', 'recordedAt', 'schemaVersion']);
    assert.equal(reconcileIsPossible(stripped), false);
  });
});

function reconcileIsPossible(env) {
  return Boolean(env.observation && env.evidence);
}
