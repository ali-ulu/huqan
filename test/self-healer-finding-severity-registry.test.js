'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

// #2274 (#2123): classifyFindingSeverity mapped `input.kind` to a default
// severity through a switch that repeated FINDING_KINDS case by case, so adding
// a finding kind meant editing two lists and one could be forgotten. The
// mapping is now one frozen table and FINDING_KINDS is derived from it.
// The first block pins today's behaviour and must be green before and after.

const schema = require('../lib/self-healer/finding-schema');

describe('classifyFindingSeverity behaviour (unchanged)', () => {
  const expected = {
    bug: 'medium',
    security: 'high',
    flaky_test: 'low',
    stale_docs: 'info',
    unsafe_pattern: 'high',
    release_hygiene: 'low',
  };

  it('maps every finding kind to its default severity', () => {
    for (const [kind, severity] of Object.entries(expected)) {
      assert.equal(schema.classifyFindingSeverity({ kind }), severity, kind);
    }
  });

  it('keeps the finding kinds, in order', () => {
    assert.deepEqual([...schema.FINDING_KINDS], ['bug', 'security', 'flaky_test', 'stale_docs', 'unsafe_pattern', 'release_hygiene']);
    assert.ok(Object.isFrozen(schema.FINDING_KINDS));
  });

  it('an explicit valid severity wins over the kind', () => {
    assert.equal(schema.classifyFindingSeverity({ kind: 'stale_docs', severity: 'critical' }), 'critical');
    assert.equal(schema.classifyFindingSeverity({ kind: 'security', severity: 'nuclear' }), 'high', 'an invalid severity is ignored');
  });

  it('anything that is not a known kind string falls back to medium', () => {
    for (const kind of [undefined, '', 'not-real', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 7, null, {}, new String('security')]) {
      assert.equal(schema.classifyFindingSeverity({ kind }), 'medium', String(kind));
    }
    assert.equal(schema.classifyFindingSeverity(), 'medium');
  });

  it('createFinding still derives the severity from the kind', () => {
    const finding = schema.createFinding({
      kind: 'flaky_test', title: 'flaky', summary: 'fails intermittently', workspaceId: 'ws-2274',
      evidence: [{ type: 'test', ref: 'test/x.test.js', detail: 'fails 1 in 5 runs' }],
    });
    assert.equal(finding.severity, 'low');
  });
});

describe('the kind to severity mapping is one registry (#2274)', () => {
  it('exports a frozen table whose keys are exactly FINDING_KINDS', () => {
    const table = schema.FINDING_DEFAULT_SEVERITY_BY_KIND;
    assert.ok(table && typeof table === 'object', 'FINDING_DEFAULT_SEVERITY_BY_KIND must be exported');
    assert.ok(Object.isFrozen(table));
    assert.equal(Object.getPrototypeOf(table), null, 'no inherited keys can match a kind');
    assert.deepEqual(Object.keys(table), [...schema.FINDING_KINDS]);
    for (const severity of Object.values(table)) assert.ok(schema.FINDING_SEVERITIES.includes(severity), severity);
  });

  it('the architecture snapshot no longer sees a growing dispatch here', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'lib/self-healer/finding-schema.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('OCP')), JSON.stringify(row.signals));
  });
});
