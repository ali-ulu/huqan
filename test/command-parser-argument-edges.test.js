'use strict';

/**
 * Deterministic coverage of the parser's argument edge cases (bare command,
 * missing operand, dangling --workspace).
 *
 * test/fuzz/cli.fuzz.test.js draws unseeded random input, so which of these
 * branches it happened to reach changed from run to run. The coverage ratchet
 * (scripts/check-coverage.js) measures lib/command-parser.js after merging every
 * test process, and with the other 164 processes held fixed the parser's branch
 * ratio still moved between 134/152 and 141/154 depending only on the fuzz run,
 * which flapped the Coverage gate on identical code. Pinning these edges here
 * means the ratio no longer depends on what the fuzz test happens to draw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCommand, parseCompanyIngestArgs } = require('../lib/command-parser');

const KERNEL = { normalizeWord: (value) => String(value), graph: { getNode: () => null } };
const parse = (text) => JSON.parse(JSON.stringify(parseCommand(text, { kernel: KERNEL })));

test('experience-read keeps its defaults and reads operands around --workspace', () => {
  assert.deepEqual(parse('experience-read').args, { runId: '', workspaceId: 'default' });
  assert.deepEqual(parse('experience-read run-1').args, { runId: 'run-1', workspaceId: 'default' });
  assert.deepEqual(parse('experience-read --workspace ws run-1').args, { runId: 'run-1', workspaceId: 'ws' });
  assert.deepEqual(parse('experience-read --workspace').args, { runId: '', workspaceId: '' });
});

test('bare experience-reconcile, experience-learn and inference fall back to empty operands', () => {
  assert.deepEqual(parse('experience-reconcile').args,
    { operationId: '', workspaceId: '', performed: false, notPerformed: false, reason: '' });
  assert.deepEqual(parse('experience-learn').args, { runId: '', workspaceId: 'default' });
  assert.equal(parse('inference').args, '{}');
});

test('onayla and receipt keep an empty workspace when --workspace has no value', () => {
  assert.deepEqual(parse('onayla ap-1 --workspace').args,
    { approvalId: 'ap-1', decision: 'approved', invalidDecision: false, workspaceId: '' });
  assert.deepEqual(parse('onayla ap-1 reject --workspace w').args,
    { approvalId: 'ap-1', decision: 'reject', invalidDecision: false, workspaceId: 'w' });
  assert.deepEqual(parse('receipt r-1 --workspace').args, { receiptId: 'r-1', workspaceId: '' });
  assert.deepEqual(parse('receipt r-1 --workspace w').args, { receiptId: 'r-1', workspaceId: 'w' });
});

test('approvals scopes to a workspace only when one is named', () => {
  assert.equal(parse('approvals').command, 'onaylar');
  assert.deepEqual(parse('approvals --workspace w').args, { workspaceId: 'w' });
  assert.equal(parse('approvals --workspace').command, 'anlamadım');
});

test('company ingest arguments default every field that is not given', () => {
  assert.equal(parseCompanyIngestArgs(''), null);
  assert.deepEqual(parseCompanyIngestArgs('--kaynak GitHub'), {
    source: 'github', author: 'unknown', repoUrl: '', targetPath: '', title: '', rationale: '', text: '', date: '',
  });
  assert.deepEqual(parseCompanyIngestArgs('--kaynak x --author a --url u --path p "t" "r" "body" --tarih d'), {
    source: 'x', author: 'a', repoUrl: 'u', targetPath: 'p', title: 't', rationale: 'r', text: 'body', date: 'd',
  });
});
