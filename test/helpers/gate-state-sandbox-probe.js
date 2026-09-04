'use strict';

/**
 * A one-assertion stand-in for the suite, run *through* scripts/run-tests.js by
 * test/gate-state-sandbox.test.js. It reports where a test process would read
 * and write the gate's state, which is the property #1846 is about: this file
 * makes no claim of its own, it is the measurement the real test asserts on.
 *
 * Node's test runner discovers every file under `test/`, so the probe registers
 * itself only when the caller named an output file. Left in ordinary discovery
 * it would run with nowhere to report and fail the suite it is measuring.
 */

const fs = require('node:fs');
const test = require('node:test');
const { defaultExternalActionReceiptPath } = require('../../lib/external-action-receipt');
const { defaultExternalActionPolicyPath } = require('../../lib/external-action-command-policy');

const out = process.env.HUQAN_GATE_STATE_PROBE_OUT;

if (out) {
  test('report the gate state a sandboxed test process resolves', () => {
    fs.writeFileSync(out, `${JSON.stringify({
      stateRoot: process.env.HUQAN_STATE_ROOT ?? null,
      receiptOverride: process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS ?? null,
      policyOverride: process.env.HUQAN_EXTERNAL_GUARD_POLICY ?? null,
      receiptPath: defaultExternalActionReceiptPath(),
      policyPath: defaultExternalActionPolicyPath(),
    })}\n`, 'utf8');
  });
}
