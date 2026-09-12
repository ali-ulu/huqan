#!/usr/bin/env node
'use strict';

const { queryIdentityLog } = require('../lib/gate-hook-identity');
const { runSealsCommand, runFleetCommand, runResidencyCommand } = require('../lib/gate-hook-reports');
const {
  runShipCommand,
  runAdapterCommand,
  runOverviewCommand,
  runAgentsCommand,
  runConnectCommand,
  runGateCommand,
} = require('../lib/gate-hook-management');
const { createProcessFailureHandlers, failureCodeFor } = require('../lib/http/process-failure-handlers');
const { writeStructuredLog } = require('../lib/http/structured-log');
// Input parsing lives in lib/gate-hook-input.js, hook evaluation in
// lib/gate-hook-evaluate.js (#2248); dispatch stays here.
const { argumentValue } = require('../lib/gate-hook-input');
const { runHookEvaluation } = require('../lib/gate-hook-evaluate');

createProcessFailureHandlers({
  logError: (kind, cause) => writeStructuredLog(console, 'error', kind === 'uncaughtException' ? 'process.uncaught_exception' : 'process.unhandled_rejection', null, {
    runtime: 'gate-hook',
    errorCode: failureCodeFor(kind, cause),
  }),
}).bind();

// Input helpers live in lib/gate-hook-input.js, the identity reader in
// lib/gate-hook-identity.js (#2248).

async function main() {
  try {
    const command = process.argv[2];
    // Read-only report commands live in lib/gate-hook-reports.js (#2248).
    // `seals` asks the one question a stored receipt cannot answer for itself:
    // has anything been removed from this store since it was received. A break
    // exits non-zero, because a silent audit is not an audit (#1882).
    if (command === 'seals') {
      runSealsCommand();
      return;
    }
    if (command === 'fleet') {
      runFleetCommand();
      return;
    }
    // `residency` reads the trail this gate already wrote and reports the rule
    // its own decisions imply. It proposes and stops: applying it means editing
    // external-action-policy.json by hand, which is what keeps the resulting
    // boundary something a receipt can attest to (docs/what-huqan-learns.md).
    if (command === 'residency') {
      runResidencyCommand();
      return;
    }
    // Management commands live in lib/gate-hook-management.js (#2248).
    if (command === 'ship') {
      await runShipCommand();
      return;
    }
    if (command === 'adapter') {
      runAdapterCommand();
      return;
    }
    if (command === 'overview') {
      runOverviewCommand();
      return;
    }
    if (command === 'agents') {
      runAgentsCommand();
      return;
    }
    if (command === 'connect') {
      runConnectCommand();
      return;
    }
    if (['install', 'uninstall', 'status'].includes(command)) {
      runGateCommand(command);
      return;
    }
    if (argumentValue('--identity-log')) return queryIdentityLog();
    await runHookEvaluation(command);
  } catch (error) {
    process.stderr.write(`HUQAN external action guard failed closed: ${error?.message || error}\n`);
    process.exitCode = 2;
  }
}

main();
