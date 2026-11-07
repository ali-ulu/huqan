'use strict';

/**
 * Evidence for issue #4536: when the approve step fails closed because no
 * usable approval authority exists in this environment (a container is
 * `container_unverified`), quickstart must name a next step instead of
 * stopping at a bare QUICKSTART_APPROVAL_FAILED.
 */

const test = require('node:test');
const assert = require('node:assert');

const { runQuickstart, formatQuickstartResult } = require('../lib/quickstart');

function makeFakes({ approveError } = {}) {
  const callTool = (kernel, request) => {
    if (request.name === 'huqan.learn') {
      return {
        ok: false,
        gate: { decision: 'review', reason: 'mutating_requires_review' },
        approval: { id: 'approval-test-1' },
      };
    }
    if (request.name === 'huqan.approve') {
      return { ok: false, error: approveError };
    }
    throw new Error(`unexpected tool ${request.name}`);
  };
  return {
    callTool,
    kernel: { graph: {}, verify: () => ({ data: { status: 'verified', confidence: 0.9 } }) },
    buildTrustReceipt: () => { throw new Error('receipt must not be built after an approval failure'); },
  };
}

test('quickstart maps AUTHORITY_UNAVAILABLE to a next-step failure', () => {
  const deps = makeFakes({
    approveError: {
      code: 'AUTHORITY_UNAVAILABLE',
      message: 'The approval authority is required but unusable (container_unverified); no decision can be taken.',
    },
  });
  const result = runQuickstart(deps);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'QUICKSTART_AUTHORITY_UNAVAILABLE');
  assert.match(result.error.message, /container_unverified/);
  // The next step is the point of the change: say where the demo can run and
  // what the authority path is, rather than a bare failure code.
  assert.match(result.error.message, /host machine/);
  assert.match(result.error.message, /huqan-authority decide/);

  const output = formatQuickstartResult(result);
  assert.match(output, /QUICKSTART_AUTHORITY_UNAVAILABLE/);
  assert.match(output, /Next:/);
});

test('quickstart keeps the generic approval failure for other errors', () => {
  const deps = makeFakes({ approveError: { code: 'SOMETHING_ELSE', message: 'nope' } });
  const result = runQuickstart(deps);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'QUICKSTART_APPROVAL_FAILED');
  assert.match(result.error.message, /approval approval-test-1 could not be applied/);
});
