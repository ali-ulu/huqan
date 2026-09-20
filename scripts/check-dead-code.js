#!/usr/bin/env node
'use strict';

/**
 * Dead-code gate for M1 (#2648), slice 1: unreachable modules.
 *
 * Wraps lib/module-reachability.js so the same classification ledger that the
 * unit tests enforce also runs as a named verify stage (`npm run check:dead-code`).
 *
 * Scope of this slice:
 *   - Unreachable source modules from production entry points
 *   - Stale NOT_YET_WIRED acknowledgements
 *
 * Deferred to later slices (still tracked on #2648):
 *   - Unused named exports inside reachable modules
 *   - Unused CLI commands / MCP tools / REST routes
 *   - Unused TypeScript types
 */

const path = require('node:path');
const { analyzeReachability } = require('../lib/module-reachability');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * @param {{ root?: string }} [opts]
 * @returns {{ ok: boolean, unacknowledged: string[], staleAcknowledgements: string[], reachableCount: number, unreachableCount: number, report: string }}
 */
function checkDeadCode(opts = {}) {
  const root = opts.root || REPO_ROOT;
  const { reachable, unreachable, unacknowledged, staleAcknowledgements } = analyzeReachability({ root });

  const lines = [];
  lines.push(`Dead-code check (module reachability): ${reachable.length} reachable, ${unreachable.length} unreachable classified or pending`);

  if (unacknowledged.length > 0) {
    lines.push(`FAIL: ${unacknowledged.length} unreachable module(s) are not classified:`);
    for (const file of unacknowledged) lines.push(`  - ${file}`);
    lines.push('Wire a production caller, or add the path to NOT_YET_WIRED in lib/module-reachability.js with a durable reason.');
  }

  if (staleAcknowledgements.length > 0) {
    lines.push(`FAIL: ${staleAcknowledgements.length} stale NOT_YET_WIRED acknowledgement(s) (now reachable or gone):`);
    for (const file of staleAcknowledgements) lines.push(`  - ${file}`);
    lines.push('Remove them from NOT_YET_WIRED so the ledger stays meaningful.');
  }

  const ok = unacknowledged.length === 0 && staleAcknowledgements.length === 0;
  if (ok) {
    lines.push(`Dead-code check passed: no unacknowledged unreachable modules (${unreachable.length} classified unreachable)`);
  }

  return {
    ok,
    unacknowledged,
    staleAcknowledgements,
    reachableCount: reachable.length,
    unreachableCount: unreachable.length,
    report: lines.join('\n'),
  };
}

function main() {
  const result = checkDeadCode();
  if (result.ok) {
    console.log(result.report);
    return 0;
  }
  console.error(result.report);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkDeadCode, main };
