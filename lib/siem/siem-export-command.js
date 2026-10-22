'use strict';

/**
 * The `huqan-gate-hook siem-export` command (#4093, PR-B3).
 *
 * The marshal lives beside the sink it drives rather than in
 * lib/gate-hook-management.js, because the SIEM export is an outbound adapter
 * and the dependency rule keeps Core from knowing one (Core may require
 * Adapters only never). bin/huqan-gate-hook.js is the composition root that
 * chooses this command, the same way it already does for `browser-session` and
 * `canary`.
 */

const { argumentValue } = require('../gate-hook-input');
const { exportReceiptsToSiem } = require('./siem-export');

async function runSiemExportCommand() {
  // `file` is the only transport with no network and the only one PR-B3 ships;
  // PR-B4 adds syslog and http. An unknown sink is refused, not defaulted.
  const sink = argumentValue('--sink') || 'file';
  if (sink !== 'file') {
    process.stdout.write(`${JSON.stringify({ error: 'UNKNOWN_SIEM_SINK', sink })}\n`);
    process.exitCode = 2;
    return;
  }
  const maxBytes = argumentValue('--max-bytes');
  const result = await exportReceiptsToSiem({
    path: argumentValue('--receipt-log') || undefined,
    siemPath: argumentValue('--siem-log') || undefined,
    cursorPath: argumentValue('--cursor') || undefined,
    format: argumentValue('--format') || 'jsonl',
    maxBytes: maxBytes ? Number.parseInt(maxBytes, 10) : undefined,
    dryRun: process.argv.includes('--dry-run'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // A sink that would not take the events is a failure worth a non-zero exit,
  // so a scheduled export does not look successful in a log.
  process.exitCode = result.failure ? 1 : 0;
}

module.exports = { runSiemExportCommand };
