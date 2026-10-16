'use strict';

/**
 * validateMemoryEvolution must fail closed on records that are not valid
 * records.
 *
 * It used to call validateMemoryRecord on both sides purely for effect and
 * throw the results away. Two empty objects therefore reached ok:true: with no
 * memoryId on either side, neither the IMMUTABLE_CONTENT nor the
 * SUPERCEDES_REQUIRED branch can fire, so nothing was left to object.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMemoryEvolution, validateMemoryRecord } = require('../lib/memory-schema');

function baseProvenance() {
  return {
    provenanceId: 'prov-1',
    sourceRef: 'doc://source/1',
    sourceTitle: 'Source 1',
    sourceType: 'document',
    actor: 'system',
    timestamp: '2026-06-03T00:00:00.000Z',
    confidence: 0.9,
    workspaceId: 'workspace-a',
    trustPolicyVersion: '0.9.0',
  };
}

function baseRecord(overrides = {}) {
  return {
    memoryId: 'mem-1',
    workspaceId: 'workspace-a',
    content: { text: 'Kedi hayvandir' },
    createdAt: '2026-06-03T00:00:00.000Z',
    provenance: baseProvenance(),
    trustPolicyVersion: '0.9.0',
    ...overrides,
  };
}

test('two empty objects are not a valid evolution', () => {
  const evolution = validateMemoryEvolution({}, {});

  assert.equal(evolution.ok, false, 'empty records must not pass evolution validation');
  assert.ok(evolution.errors.length > 0);
});

test('evolution errors say which side produced them', () => {
  const evolution = validateMemoryEvolution({}, baseRecord());

  assert.equal(evolution.ok, false);
  // Record-level findings are attributed to a side; the evolution-level checks
  // (IMMUTABLE_CONTENT / SUPERCEDES_REQUIRED) are about the pair, so they keep
  // their own bare field names.
  const recordLevel = evolution.errors.filter((error) => !['IMMUTABLE_CONTENT', 'SUPERCEDES_REQUIRED'].includes(error.code));
  assert.ok(recordLevel.length > 0, 'the empty side must produce record-level errors');
  assert.ok(
    recordLevel.every((error) => /^previous(\.|$)/.test(error.field)),
    `only the invalid side should be blamed, got ${JSON.stringify(recordLevel.map((e) => e.field))}`,
  );
});

test('every record-level error is carried into the evolution result', () => {
  const broken = { memoryId: 'mem-1' };
  const recordErrors = validateMemoryRecord(broken).errors;
  assert.ok(recordErrors.length > 0, 'the fixture must be an invalid record');

  const evolution = validateMemoryEvolution(broken, broken);

  for (const error of recordErrors) {
    assert.ok(
      evolution.errors.some((e) => e.code === error.code && e.field === `previous.${error.field}`),
      `evolution result is missing previous.${error.field} (${error.code})`,
    );
  }
});

test('a valid unchanged pair still validates', () => {
  const evolution = validateMemoryEvolution(baseRecord(), baseRecord());

  assert.equal(evolution.ok, true, JSON.stringify(evolution.errors, null, 2));
});

test('a valid supersede chain still validates', () => {
  const evolution = validateMemoryEvolution(
    baseRecord(),
    baseRecord({ memoryId: 'mem-2', content: { text: 'Kedi memelidir' }, supersedesMemoryId: 'mem-1' }),
  );

  assert.equal(evolution.ok, true, JSON.stringify(evolution.errors, null, 2));
});
