'use strict';

// Read-only report commands for the huqan-gate-hook CLI entry point (#2248).
//
// Single responsibility: the seals/fleet/residency inspections. Each reads
// the trail the gate already wrote and prints JSON; none writes receipts,
// reads stdin, or dispatches other commands. Exit-code ownership stays with
// the caller contract documented here: seals exits non-zero on a break (a
// silent audit is not an audit, #1882), fleet and residency always exit 0.

const { argumentValue } = require('./gate-hook-input');

function runSealsCommand() {
  const collector = require('./external-action-receipt-collector');
  const report = collector.verifyCollectorSeals({
    root: argumentValue('--store'),
    workspaceId: argumentValue('--workspace') || undefined,
    ownerActorId: argumentValue('--owner') || undefined,
    trustedKeys: collector.readTrustedBatchKeys(argumentValue('--trusted-keys')),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

function runFleetCommand() {
  const { queryFleet } = require('./external-action-receipt-collector');
  process.stdout.write(`${JSON.stringify(queryFleet({
    root: argumentValue('--store'),
    workspaceId: argumentValue('--workspace') || undefined,
    ownerActorId: argumentValue('--owner') || undefined,
    since: argumentValue('--since') || undefined,
    until: argumentValue('--until') || undefined,
    ...(argumentValue('--limit') ? { limit: Number.parseInt(argumentValue('--limit'), 10) } : {}),
  }), null, 2)}\n`);
  process.exitCode = 0;
}

function runResidencyCommand() {
  const { mineResidencyRule } = require('./residency-rule-miner');
  const { readExternalActionReceipts } = require('./external-action-receipt-reader');
  const receipts = readExternalActionReceipts({ path: argumentValue('--receipt-log') || undefined });
  const minObservations = argumentValue('--min-observations');
  const mined = mineResidencyRule(receipts, {
    ...(minObservations ? { minObservations: Number.parseInt(minObservations, 10) } : {}),
  });
  process.stdout.write(`${JSON.stringify({ ...mined, receiptsRead: receipts.length }, null, 2)}\n`);
  process.exitCode = 0;
}

module.exports = { runSealsCommand, runFleetCommand, runResidencyCommand };
