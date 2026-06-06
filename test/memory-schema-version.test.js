'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MEMORY_SCHEMA_VERSIONS,
  compareSemver,
  validateSchemaVersion,
  validateMemoryRecord,
  validateMemoryEvent,
  validateMemoryLink,
} = require('../lib/memory-schema');

function freshProvenance() {
  return {
    provenanceId: 'p-1',
    sourceRef: 'r',
    sourceTitle: 't',
    sourceType: 'api',
    actor: 'tester',
    timestamp: '2026-06-05T12:00:00.000Z',
    workspaceId: 'default',
    trustPolicyVersion: '1.0.0',
    confidence: 1.0,
  };
}

function freshRecord(extra) {
  return Object.assign({
    memoryId: 'm-1',
    workspaceId: 'default',
    content: { data: 'x' },
    createdAt: '2026-06-05T12:00:00.000Z',
    provenance: freshProvenance(),
    trustPolicyVersion: '1.0.0',
  }, extra || {});
}

function freshEvent(extra) {
  return Object.assign({
    eventId: 'e-1',
    eventType: 'CREATED',
    memoryId: 'm-1',
    workspaceId: 'default',
    createdAt: '2026-06-05T12:00:00.000Z',
    actor: 'tester',
    provenance: freshProvenance(),
    trustPolicyVersion: '1.0.0',
    details: { action: 'store' },
  }, extra || {});
}

function freshLink(extra) {
  return Object.assign({
    linkId: 'l-1',
    relation: 'supports',
    fromMemoryId: 'm-1',
    toMemoryId: 'm-2',
    workspaceId: 'default',
    createdAt: '2026-06-05T12:00:00.000Z',
    provenance: freshProvenance(),
    trustPolicyVersion: '1.0.0',
  }, extra || {});
}

describe('PR-S5 memory schema versioning', () => {
  describe('MEMORY_SCHEMA_VERSIONS constants', () => {
    it('exposes known versions for all four object types', () => {
      assert.strictEqual(MEMORY_SCHEMA_VERSIONS.memoryRecord, '1.0.0');
      assert.strictEqual(MEMORY_SCHEMA_VERSIONS.memoryEvent, '1.0.0');
      assert.strictEqual(MEMORY_SCHEMA_VERSIONS.memoryLink, '1.0.0');
      assert.strictEqual(MEMORY_SCHEMA_VERSIONS.memoryPackage, '1.0.0');
    });
  });

  describe('compareSemver (no npm dependency)', () => {
    it('returns 0 for equal versions', () => {
      assert.strictEqual(compareSemver('1.0.0', '1.0.0'), 0);
      assert.strictEqual(compareSemver('2.1.3', '2.1.3'), 0);
    });
    it('returns -1 when a < b', () => {
      assert.strictEqual(compareSemver('1.0.0', '1.0.1'), -1);
      assert.strictEqual(compareSemver('1.0.0', '2.0.0'), -1);
    });
    it('returns 1 when a > b', () => {
      assert.strictEqual(compareSemver('1.0.1', '1.0.0'), 1);
      assert.strictEqual(compareSemver('2.0.0', '1.9.9'), 1);
    });
    it('pads missing components with 0', () => {
      assert.strictEqual(compareSemver('1.0', '1.0.0'), 0);
      assert.strictEqual(compareSemver('1', '1.0.0'), 0);
    });
  });

  describe('validateSchemaVersion (A1 + B1)', () => {
    it('missing -> warning, OK (A1)', () => {
      const errors = [];
      const warnings = [];
      const ok = validateSchemaVersion(undefined, errors, warnings, 'memoryRecord');
      assert.strictEqual(ok, true);
      assert.strictEqual(errors.length, 0);
      assert.strictEqual(warnings.length, 1);
      assert.strictEqual(warnings[0].code, 'SCHEMA_VERSION_MISSING');
      assert.strictEqual(warnings[0].field, 'schemaVersion');
    });

    it('null -> warning, OK (A1)', () => {
      const errors = [];
      const warnings = [];
      const ok = validateSchemaVersion(null, errors, warnings, 'memoryEvent');
      assert.strictEqual(ok, true);
      assert.strictEqual(errors.length, 0);
      assert.strictEqual(warnings.length, 1);
    });

    it('known version -> no warnings, OK', () => {
      const errors = [];
      const warnings = [];
      const ok = validateSchemaVersion('1.0.0', errors, warnings, 'memoryLink');
      assert.strictEqual(ok, true);
      assert.strictEqual(errors.length, 0);
      assert.strictEqual(warnings.length, 0);
    });

    it('older version -> SCHEMA_VERSION_OLDER warning, OK (no fail)', () => {
      const errors = [];
      const warnings = [];
      const ok = validateSchemaVersion('0.9.0', errors, warnings, 'memoryRecord');
      assert.strictEqual(ok, true);
      assert.strictEqual(errors.length, 0);
      assert.strictEqual(warnings.length, 1);
      assert.strictEqual(warnings[0].code, 'SCHEMA_VERSION_OLDER');
    });

    it('newer version -> SCHEMA_VERSION_NEWER warning, OK (B1, no fail)', () => {
      const errors = [];
      const warnings = [];
      const ok = validateSchemaVersion('2.0.0', errors, warnings, 'memoryRecord');
      assert.strictEqual(ok, true);
      assert.strictEqual(errors.length, 0);
      assert.strictEqual(warnings.length, 1);
      assert.strictEqual(warnings[0].code, 'SCHEMA_VERSION_NEWER');
    });

    it('invalid (non-string) -> error, FAIL', () => {
      const errors = [];
      const warnings = [];
      const ok = validateSchemaVersion(123, errors, warnings, 'memoryRecord');
      assert.strictEqual(ok, false);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].code, 'VALIDATION_ERROR');
      assert.strictEqual(errors[0].field, 'schemaVersion');
    });

    it('invalid (whitespace) -> error, FAIL', () => {
      const errors = [];
      const warnings = [];
      const ok = validateSchemaVersion('   ', errors, warnings, 'memoryRecord');
      assert.strictEqual(ok, false);
      assert.strictEqual(errors.length, 1);
    });
  });

  describe('validateMemoryRecord integrates schema version', () => {
    it('record without schemaVersion -> ok=true, MISSING warning (backward compat)', () => {
      const r = freshRecord();
      const res = validateMemoryRecord(r);
      assert.strictEqual(res.ok, true,
        `expected ok=true, got errors: ${JSON.stringify(res.errors)}`);
      assert.ok(res.warnings.some((w) => w.code === 'SCHEMA_VERSION_MISSING'),
        'expected SCHEMA_VERSION_MISSING warning');
    });

    it('record with known schemaVersion -> ok=true, no version warning', () => {
      const r = freshRecord({ schemaVersion: '1.0.0' });
      const res = validateMemoryRecord(r);
      assert.strictEqual(res.ok, true);
      assert.ok(!res.warnings.some((w) => w.code && w.code.startsWith('SCHEMA_VERSION')),
        'expected no SCHEMA_VERSION warnings');
    });

    it('record with older schemaVersion -> ok=true, OLDER warning (no fail)', () => {
      const r = freshRecord({ schemaVersion: '0.9.0' });
      const res = validateMemoryRecord(r);
      assert.strictEqual(res.ok, true);
      assert.ok(res.warnings.some((w) => w.code === 'SCHEMA_VERSION_OLDER'));
    });

    it('record with newer schemaVersion -> ok=true, NEWER warning (no fail)', () => {
      const r = freshRecord({ schemaVersion: '2.0.0' });
      const res = validateMemoryRecord(r);
      assert.strictEqual(res.ok, true);
      assert.ok(res.warnings.some((w) => w.code === 'SCHEMA_VERSION_NEWER'));
    });

    it('record with invalid schemaVersion -> ok=false (FAIL)', () => {
      const r = freshRecord({ schemaVersion: 123 });
      const res = validateMemoryRecord(r);
      assert.strictEqual(res.ok, false);
      assert.ok(res.errors.some((e) => e.field === 'schemaVersion'));
    });
  });

  describe('validateMemoryEvent integrates schema version', () => {
    it('event without schemaVersion -> ok=true, MISSING warning', () => {
      const e = freshEvent();
      const res = validateMemoryEvent(e);
      assert.strictEqual(res.ok, true);
      assert.ok(res.warnings.some((w) => w.code === 'SCHEMA_VERSION_MISSING'));
    });

    it('event with known schemaVersion -> ok=true, no version warning', () => {
      const e = freshEvent({ schemaVersion: '1.0.0' });
      const res = validateMemoryEvent(e);
      assert.strictEqual(res.ok, true);
      assert.ok(!res.warnings.some((w) => w.code && w.code.startsWith('SCHEMA_VERSION')));
    });
  });

  describe('validateMemoryLink integrates schema version', () => {
    it('link without schemaVersion -> ok=true, MISSING warning', () => {
      const l = freshLink();
      const res = validateMemoryLink(l);
      assert.strictEqual(res.ok, true);
      assert.ok(res.warnings.some((w) => w.code === 'SCHEMA_VERSION_MISSING'));
    });

    it('link with known schemaVersion -> ok=true, no version warning', () => {
      const l = freshLink({ schemaVersion: '1.0.0' });
      const res = validateMemoryLink(l);
      assert.strictEqual(res.ok, true);
      assert.ok(!res.warnings.some((w) => w.code && w.code.startsWith('SCHEMA_VERSION')));
    });
  });

  describe('roundtrip: pre-PR-S5 record (no schemaVersion) survives validate', () => {
    it('record lacking schemaVersion validates ok=true with MISSING warning', () => {
      // Simulates a record written by an AXIOM build before PR-S5.
      const oldRecord = freshRecord();
      delete oldRecord.schemaVersion;
      const res = validateMemoryRecord(oldRecord);
      assert.strictEqual(res.ok, true,
        'pre-PR-S5 records must continue to validate');
      assert.ok(res.warnings.some((w) => w.code === 'SCHEMA_VERSION_MISSING'));
    });
  });
});
