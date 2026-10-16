'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2182 (#2123): validateATPObject dispatched to per-type validators through a
// switch over ATP_OBJECT_TYPES, which grows whenever an ATP object type is
// added. The dispatch is now a frozen type-to-validator table. The first block
// pins today's behaviour and must be green before and after the change.

const { ATP_OBJECT_TYPES, validateATPObject } = require('../lib/atp-conformance');

describe('validateATPObject dispatch (unchanged)', () => {
  it('every ATP type reaches its own validator', () => {
    for (const type of Object.values(ATP_OBJECT_TYPES)) {
      const result = validateATPObject(type, {});
      assert.equal(result.type, type, `${type} was not handled by its own validator`);
      assert.ok(Array.isArray(result.errors) && Array.isArray(result.warnings));
      assert.ok(!result.errors.some((err) => err.code === 'INVALID_ATP_OBJECT'), `${type} fell through to unknown`);
    }
  });

  it('the type is trimmed before dispatch', () => {
    assert.equal(validateATPObject(`  ${ATP_OBJECT_TYPES.auditEvent}  `, {}).type, ATP_OBJECT_TYPES.auditEvent);
  });

  it('anything that is not an ATP type gets the unknown-type result', () => {
    for (const [input, reported] of [[undefined, 'unknown'], ['', 'unknown'], ['   ', 'unknown'], ['nope', 'nope'], ['constructor', 'constructor'], ['__proto__', '__proto__'], ['toString', 'toString'], ['Audit-Event', 'Audit-Event']]) {
      const result = validateATPObject(input, {});
      assert.deepEqual(result.errors, [{ code: 'INVALID_ATP_OBJECT', field: 'type', message: `Unknown ATP object type: ${input === undefined ? '' : String(input).trim()}` }], String(input));
      assert.equal(result.type, reported, String(input));
      assert.equal(result.ok, false);
    }
  });
});

describe('the dispatch is a registry (#2182)', () => {
  it('lib/atp-conformance.js no longer switches on the normalized type', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'atp-conformance.js'), 'utf8');
    assert.doesNotMatch(source, /switch\s*\(\s*normalizedType\s*\)/);
  });

  it('the architecture snapshot no longer sees a growing dispatch here', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'lib/atp-conformance.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('OCP')), JSON.stringify(row.signals));
  });
});
