#!/usr/bin/env node
'use strict';

/**
 * huqan-authority (#3860, ADR-016): the operator's view of the approval
 * authority.
 *
 *   huqan-authority status   which authority this runtime answers to, and
 *                            whether the pinned service is the one answering
 *
 * Exit 0: legacy mode, or service mode with the pinned service answering under
 * its pinned key. Exit 2: an authority is required or installed but cannot be
 * used, or something other than the pinned service answered on its port.
 */

const { resolveApprovalAuthorityMode } = require('../lib/authority/authority-mode');
const { createAuthorityClient } = require('../lib/authority/authority-client');

const USAGE = 'usage: huqan-authority status';

async function status({ resolveMode = resolveApprovalAuthorityMode, createClient = createAuthorityClient } = {}) {
  const mode = resolveMode();
  if (mode.mode === 'legacy') {
    return { code: 0, report: { mode: 'legacy', boundary: mode.boundary,
      note: 'no approval authority is installed; operator decisions are protected only by the same OS user' } };
  }
  if (mode.mode !== 'service') return { code: 2, report: { mode: mode.mode, reason: mode.reason, pinPath: mode.pinPath } };
  const base = { mode: 'service', boundary: mode.boundary, pinPath: mode.pinPath, port: mode.pin.port, keyId: mode.pin.keyId };
  try {
    const identity = await createClient({ pin: mode.pin }).identity();
    // Signed is not enough: the service must answer 200 under the very key the pin names.
    if (identity.status !== 200 || !identity.body || identity.body.keyId !== mode.pin.keyId) {
      return { code: 2, report: { ...base, answering: false, error: 'AUTHORITY_IDENTITY_MISMATCH' } };
    }
    return { code: 0, report: { ...base, answering: true } };
  } catch (error) {
    return { code: 2, report: { ...base, answering: false, error: error.code || 'STATUS_FAILED' } };
  }
}

async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv[0] !== 'status' || argv.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const { code, report } = await status(deps);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return code;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`huqan-authority: ${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = { status, main };
