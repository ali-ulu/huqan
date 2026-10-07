'use strict';

/**
 * Characterisation tests for the KnowledgeObject schema (#3470, K0).
 *
 * Pinned here: every kind validates with the nine required fields; the schema
 * reuses the memory schema's provenance check, status list and version compare
 * rather than defining its own; and a learned policy or capability is refused,
 * both on its own and as a version step over an authored one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AUTHORITY_KINDS,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_OBJECT_TYPE,
  validateKnowledgeObject,
  validateKnowledgeSupersession,
} = require('../lib/memory-knowledge-object');
const { MEMORY_STATUSES } = require('../lib/memory-schema');
const { ARTIFACT_TYPES } = require('../lib/experience/reflective-promotion');

const NOW = '2026-10-06T12:00:00.000Z';

function provenance(overrides = {}) {
  return {
    provenanceId: 'prov-1',
    sourceRef: 'doc://source',
    sourceTitle: 'Source',
    sourceType: 'document',
    actor: 'operator',
    timestamp: NOW,
    workspaceId: 'ws-1',
    trustPolicyVersion: 'v1',
    confidence: 0.9,
    ...overrides,
  };
}

function knowledge(overrides = {}) {
  return {
    knowledgeId: 'ko-1',
    kind: 'fact',
    origin: 'authored',
    version: '1.0.0',
    workspaceId: 'ws-1',
    content: { statement: 'water boils at 100C at sea level' },
    provenance: provenance(),
    dependencies: [],
    confidence: 0.8,
    scope: { workspaceId: 'ws-1' },
    status: 'active',
    supersedes: null,
    receipt: { receiptId: 'rcpt-1' },
    ...overrides,
  };
}

function codes(outcome) {
  return outcome.errors.map((e) => `${e.code}:${e.field}`);
}

test('the seven kinds are fixed and policy/capability are the authority kinds', () => {
  assert.deepEqual([...KNOWLEDGE_KINDS], ['fact', 'rule', 'procedure', 'policy', 'capability', 'model', 'hypothesis']);
  assert.deepEqual([...AUTHORITY_KINDS], ['policy', 'capability']);
  // The I5 reflective loop only promotes learned procedures, rules and models;
  // none of its artifact types may be an authority kind.
  assert.deepEqual(ARTIFACT_TYPES.filter((t) => AUTHORITY_KINDS.includes(t)), []);
  assert.ok(ARTIFACT_TYPES.every((t) => KNOWLEDGE_KINDS.includes(t)));
});

for (const kind of KNOWLEDGE_KINDS) {
  test(`an authored ${kind} with all fields validates`, () => {
    const outcome = validateKnowledgeObject(knowledge({ kind }));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
    assert.equal(outcome.type, KNOWLEDGE_OBJECT_TYPE);
  });
}

for (const kind of KNOWLEDGE_KINDS.filter((k) => !AUTHORITY_KINDS.includes(k))) {
  test(`a learned ${kind} is allowed, even without a receipt`, () => {
    const outcome = validateKnowledgeObject(knowledge({ kind, origin: 'learned', receipt: null }));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  });
}

for (const kind of AUTHORITY_KINDS) {
  test(`a learned ${kind} is refused as authority expansion`, () => {
    const outcome = validateKnowledgeObject(knowledge({ kind, origin: 'learned' }));
    assert.equal(outcome.ok, false);
    assert.deepEqual(codes(outcome), ['AUTHORITY_EXPANSION_REFUSED:origin']);
  });

  test(`an active ${kind} without a receipt is refused; a superseded one is not`, () => {
    assert.deepEqual(codes(validateKnowledgeObject(knowledge({ kind, receipt: null }))), ['AUTHORITY_RECEIPT_REQUIRED:receipt']);
    assert.equal(validateKnowledgeObject(knowledge({ kind, receipt: null, status: 'superseded' })).ok, true);
  });
}

test('each of the nine required fields is enforced', () => {
  const required = ['knowledgeId', 'version', 'provenance', 'dependencies', 'confidence', 'scope', 'status', 'receipt', 'kind'];
  for (const field of required) {
    const object = knowledge();
    delete object[field];
    const outcome = validateKnowledgeObject(object);
    assert.equal(outcome.ok, false, `${field} should be required`);
    assert.ok(outcome.errors.some((e) => e.field === field), `${field}: ${JSON.stringify(outcome.errors)}`);
  }
  // supersedes is the one optional slot: absent and null both mean "first version".
  const first = knowledge();
  delete first.supersedes;
  assert.equal(validateKnowledgeObject(first).ok, true);
});

test('provenance goes through the memory schema check', () => {
  const outcome = validateKnowledgeObject(knowledge({ provenance: provenance({ sourceRef: '', confidence: 2 }) }));
  assert.deepEqual(codes(outcome).sort(), ['VALIDATION_ERROR:provenance.confidence', 'VALIDATION_ERROR:provenance.sourceRef']);
});

test('status reuses the memory status list', () => {
  for (const status of MEMORY_STATUSES) {
    assert.equal(validateKnowledgeObject(knowledge({ status })).ok, true, status);
  }
  assert.deepEqual(codes(validateKnowledgeObject(knowledge({ status: 'promoted' }))), ['VALIDATION_ERROR:status']);
});

test('field-level shape errors are reported per field', () => {
  const cases = [
    [{ version: '1.0' }, 'VALIDATION_ERROR:version'],
    [{ confidence: Number.NaN }, 'VALIDATION_ERROR:confidence'],
    [{ confidence: 1.01 }, 'VALIDATION_ERROR:confidence'],
    [{ origin: 'inferred' }, 'VALIDATION_ERROR:origin'],
    [{ kind: 'belief' }, 'VALIDATION_ERROR:kind'],
    [{ content: null }, 'VALIDATION_ERROR:content'],
    [{ scope: { workspaceId: 'ws-2' } }, 'VALIDATION_ERROR:scope.workspaceId'],
    [{ dependencies: [{ knowledgeId: 'ko-1', version: '1.0.0' }] }, 'VALIDATION_ERROR:dependencies[0]'],
    [{ dependencies: [{ knowledgeId: 'ko-2' }] }, 'VALIDATION_ERROR:dependencies[0].version'],
    [{ receipt: 'rcpt-1' }, 'VALIDATION_ERROR:receipt'],
    [{ receipt: {} }, 'VALIDATION_ERROR:receipt.receiptId'],
    [{ supersedes: { knowledgeId: 'ko-1', version: '1.0.0' } }, 'VALIDATION_ERROR:supersedes.version'],
    [{ version: '2.0.0', supersedes: { knowledgeId: 'ko-2', version: '1.0.0' } }, 'VALIDATION_ERROR:supersedes.knowledgeId'],
  ];
  for (const [overrides, expected] of cases) {
    assert.deepEqual(codes(validateKnowledgeObject(knowledge(overrides))), [expected], JSON.stringify(overrides));
  }
  assert.deepEqual(codes(validateKnowledgeObject(null)), ['INVALID_KNOWLEDGE_OBJECT:']);
  // content must survive JSON unchanged, not merely stringify without throwing.
  for (const content of [{ n: 10n }, () => 1, { f: () => 1 }, { n: Infinity }, [Number.NaN], { u: undefined }, new Date(NOW),
    new Array(1), Object.assign(new Array(3), { 0: 1, 2: 3 }), { [Symbol('s')]: 1 }, Object.defineProperty({}, 'hidden', { value: 1 }),
    Object.defineProperty({}, 'g', { get: () => 1, enumerable: true })]) {
    assert.deepEqual(codes(validateKnowledgeObject(knowledge({ content }))), ['VALIDATION_ERROR:content'], String(content));
  }
  for (const content of ['text', 0, false, [1, 'a', null], { nested: { list: [1.5, true] } }]) {
    assert.equal(validateKnowledgeObject(knowledge({ content })).ok, true, JSON.stringify(content));
  }
});

test('a dependency on another object validates', () => {
  const outcome = validateKnowledgeObject(knowledge({ kind: 'rule', dependencies: [{ knowledgeId: 'ko-2', version: '2.1.0' }] }));
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
});

test('a version step keeps id, kind, workspace and origin and moves forward', () => {
  const v1 = knowledge({ kind: 'procedure', origin: 'learned', receipt: null, status: 'superseded' });
  const v2 = knowledge({ kind: 'procedure', origin: 'learned', receipt: null, version: '1.1.0', supersedes: { knowledgeId: 'ko-1', version: '1.0.0' } });
  assert.equal(validateKnowledgeSupersession(v1, v2).ok, true);

  assert.deepEqual(codes(validateKnowledgeSupersession(v1, { ...v2, kind: 'model' })), ['SUPERSESSION_MISMATCH:kind']);
  assert.deepEqual(codes(validateKnowledgeSupersession(v1, { ...v2, origin: 'authored' })), ['SUPERSESSION_MISMATCH:origin']);
  assert.deepEqual(codes(validateKnowledgeSupersession(v1, { ...v2, supersedes: { knowledgeId: 'ko-1', version: '0.9.0' } })),
    ['SUPERSESSION_MISMATCH:supersedes']);
  assert.deepEqual(codes(validateKnowledgeSupersession(v1, { ...v2, supersedes: null })), ['SUPERSESSION_MISMATCH:supersedes']);
  // Going backwards is refused by next's own supersedes check.
  const backwards = validateKnowledgeSupersession({ ...v1, version: '2.0.0' }, { ...v2, supersedes: { knowledgeId: 'ko-1', version: '2.0.0' } });
  assert.deepEqual(codes(backwards), ['INVALID_NEXT:next']);
  assert.deepEqual(codes(backwards.next), ['VALIDATION_ERROR:supersedes.version']);
});

test('learning cannot supersede an authored policy or capability', () => {
  for (const kind of AUTHORITY_KINDS) {
    const authored = knowledge({ kind, status: 'superseded' });
    const learned = knowledge({ kind, origin: 'learned', version: '1.1.0', supersedes: { knowledgeId: 'ko-1', version: '1.0.0' } });
    const outcome = validateKnowledgeSupersession(authored, learned);
    assert.equal(outcome.ok, false);
    assert.deepEqual(codes(outcome), ['INVALID_NEXT:next']);
    assert.deepEqual(codes(outcome.next), ['AUTHORITY_EXPANSION_REFUSED:origin']);

    // A learned procedure cannot be relabelled into an authority kind either.
    const procedure = knowledge({ kind: 'procedure', origin: 'learned', receipt: null, status: 'superseded' });
    const relabelled = knowledge({ kind, version: '1.1.0', supersedes: { knowledgeId: 'ko-1', version: '1.0.0' } });
    assert.deepEqual(codes(validateKnowledgeSupersession(procedure, relabelled)).sort(),
      ['AUTHORITY_EXPANSION_REFUSED:origin', 'SUPERSESSION_MISMATCH:kind']);
  }
});

test('an authored policy can be superseded by a newer authored, receipted version', () => {
  const v1 = knowledge({ kind: 'policy', status: 'superseded' });
  const v2 = knowledge({ kind: 'policy', version: '2.0.0', supersedes: { knowledgeId: 'ko-1', version: '1.0.0' }, receipt: { receiptId: 'rcpt-2' } });
  assert.equal(validateKnowledgeSupersession(v1, v2).ok, true);
});
