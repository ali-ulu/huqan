'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// #3101: the FANOUT signal counts the distinct modules a file requires, and
// unlike DIP it has no composition-root exemption. kernel.js is an entrypoint
// whose remaining requires are the admission-gated learn() chokepoint and the
// audit sink the audit contracts pin to it (ADR-012), so it is recorded
// explicitly -- with a reason, a review date and a ceiling -- like
// OCP_ALLOWED and DIP_ALLOWED. Only an entrypoint can be recorded, a fan-out
// above the ceiling brings the signal back, and an expired, stale or loose
// entry fails the gate.

const snapshotModule = require('../scripts/architecture-snapshot');

test('kernel.js is recorded with a reason, a review date and its current fan-out as ceiling', () => {
  const { FANOUT_ALLOWED } = snapshotModule;
  assert.ok(Array.isArray(FANOUT_ALLOWED), 'FANOUT_ALLOWED must be exported');
  const entry = FANOUT_ALLOWED.find((item) => item.file === 'kernel.js');
  assert.ok(entry, 'kernel.js must be recorded');
  assert.match(entry.why, /chokepoint|ADR-012/, 'an exception states why');
  assert.match(entry.review_by, /^\d{4}-\d{2}-\d{2}$/, 'an exception has a review date');
  assert.ok(Number.isInteger(entry.ceiling), 'an exception has a ceiling');
});

test('a recorded entrypoint loses the FANOUT signal; an unrecorded file keeps it', () => {
  const rows = snapshotModule.snapshot();
  const kernel = rows.find((item) => item.file === 'kernel.js');
  assert.ok(kernel, 'kernel.js is measured');
  assert.ok(!kernel.signals.some((signal) => signal.startsWith('FANOUT')), JSON.stringify(kernel));
  const graph = rows.find((item) => item.file === 'graph.js');
  assert.ok(graph.signals.some((signal) => signal.startsWith('FANOUT')), 'graph.js is not an entrypoint and stays tracked');
});

test('the live exception list is neither expired, stale nor loose', () => {
  assert.deepEqual(snapshotModule.fanoutExceptionViolations(), []);
});

test('isFanoutAllowed holds only for an entrypoint at or under its ceiling', () => {
  const { isFanoutAllowed } = snapshotModule;
  const entries = [
    { file: 'kernel.js', why: 'fixture', review_by: '2026-12-31', ceiling: 25 },
    { file: 'lib/busy.js', why: 'fixture: not an entrypoint', review_by: '2026-12-31', ceiling: 25 },
  ];
  assert.equal(isFanoutAllowed('kernel.js', 25, entries), true);
  assert.equal(isFanoutAllowed('kernel.js', 26, entries), false, 'growth past the ceiling is a signal again');
  assert.equal(isFanoutAllowed('lib/busy.js', 21, entries), false, 'only an entrypoint can be recorded');
  assert.equal(isFanoutAllowed('cli.js', 21, entries), false, 'an unrecorded entrypoint is not exempt');
});

test('an expired, gone, non-entrypoint, stale, loose and grown entry are each reported, a live one is not', () => {
  const { fanoutExceptionViolations } = snapshotModule;
  const fanOuts = { 'kernel.js': 25, 'cli.js': 17, 'server.js': 22, 'index.js': 30, 'lib/busy.js': 30 };
  const fanOutOf = (file) => (file in fanOuts ? fanOuts[file] : null);
  const today = '2026-09-28';
  const violations = fanoutExceptionViolations([
    { file: 'kernel.js', why: 'fixture: live', review_by: '2026-12-31', ceiling: 25 },
    { file: 'mcpServer.js', why: 'fixture: expired', review_by: '2026-01-01', ceiling: 25 },
    { file: 'agentRuntime.js', why: 'fixture: gone', review_by: '2026-12-31', ceiling: 25 },
    { file: 'lib/busy.js', why: 'fixture: not an entrypoint', review_by: '2026-12-31', ceiling: 30 },
    { file: 'cli.js', why: 'fixture: below the signal', review_by: '2026-12-31', ceiling: 24 },
    { file: 'server.js', why: 'fixture: ceiling above the fan-out', review_by: '2026-12-31', ceiling: 24 },
    { file: 'index.js', why: 'fixture: fan-out above the ceiling', review_by: '2026-12-31', ceiling: 28 },
  ], { today, fanOutOf });

  assert.equal(violations.length, 6, JSON.stringify(violations));
  assert.ok(violations.some((v) => /mcpServer\.js/.test(v) && /expired/.test(v)));
  assert.ok(violations.some((v) => /agentRuntime\.js/.test(v) && /gone/.test(v)));
  assert.ok(violations.some((v) => /lib\/busy\.js/.test(v) && /entrypoint/.test(v)));
  assert.ok(violations.some((v) => /cli\.js/.test(v) && /stale/.test(v)));
  assert.ok(violations.some((v) => /server\.js/.test(v) && /lower the ceiling to 22/.test(v)));
  assert.ok(violations.some((v) => /index\.js/.test(v) && /above the ceiling/.test(v)));
});
