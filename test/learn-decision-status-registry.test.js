'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2189 (#2123): statusForLearnDecisionError mapped every learn-decision error
// code to its HTTP status through a switch that grew with each executor or
// oversight code. The mapping is now a frozen table. The first block pins
// today's behaviour and must be green before and after the change.

const { statusForLearnDecisionError } = require('../lib/http/workflow-data-routes');

describe('statusForLearnDecisionError mapping (unchanged)', () => {
  const expected = {
    APPROVAL_STORE_UNAVAILABLE: 503,
    APPROVAL_NOT_FOUND: 404,
    APPROVAL_ALREADY_FINAL: 409,
    APPROVAL_DECISION_CONFLICT: 409,
    APPROVAL_EXECUTION_IN_PROGRESS: 409,
    APPROVAL_RECONCILIATION_REQUIRED: 409,
    APPROVAL_EXECUTION_FAILED: 409,
    APPROVAL_FINALIZATION_FAILED: 409,
    APPROVAL_EXECUTION_UNKNOWN: 409,
    OVERSIGHT_CASE_UNAVAILABLE: 409,
    OVERSIGHT_DECISION_FAILED: 409,
    OVERSIGHT_EXECUTION_BLOCKED: 409,
    OVERSIGHT_QUORUM_PENDING: 409,
    IDENTITY_ENFORCEMENT_BLOCKED: 403,
  };

  it('maps every known code to its status', () => {
    for (const [code, status] of Object.entries(expected)) {
      assert.equal(statusForLearnDecisionError(code), status, code);
    }
  });

  it('an unknown code fails closed to 400, never a success', () => {
    for (const code of [undefined, null, '', 'NOPE', 'approval_not_found', ' APPROVAL_NOT_FOUND', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 404, {}]) {
      assert.equal(statusForLearnDecisionError(code), 400, String(code));
    }
    assert.equal(statusForLearnDecisionError(), 400);
  });
});

describe('the status mapping is a registry (#2189)', () => {
  it('lib/http/workflow-data-routes.js no longer switches on the error code', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http', 'workflow-data-routes.js'), 'utf8');
    assert.doesNotMatch(source, /switch\s*\(\s*code\s*\)/);
  });

  it('the architecture snapshot no longer sees a growing dispatch here', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'lib/http/workflow-data-routes.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('OCP')), JSON.stringify(row.signals));
  });
});
