'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  collectDrift,
  violationsIn,
  isRecord,
  ALLOWED,
} = require('../scripts/check-docs-drift.js');

const context = {
  nodeMajor: '22',
  tools: new Set(['learn', 'approve']),
  routes: "policy('/api/receipts')",
};

test('living documentation states nothing the source contradicts', () => {
  const drift = collectDrift();
  const rendered = drift.map(item => `${item.file}: ${item.token} (${item.rule})`).join('\n');
  assert.deepStrictEqual(drift, [], `documentation drift:\n${rendered}`);
});

test('a documented Node floor below the engines range is drift', () => {
  const found = violationsIn('docs/x.md', 'Requires Node.js >= 20 to run.', context);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].rule, 'node-version');
});

test('a Node version mentioned without a requirement is not drift', () => {
  // The sentence CONTRIBUTING.md actually carries: prose about a runtime's
  // end of life is not a claim about what this package runs on.
  const prose = 'Node.js 20 reached end-of-life on 2026-04-30 and is no longer supported.';
  assert.deepStrictEqual(violationsIn('docs/x.md', prose, context), []);
});

test('the current engines floor passes in every requirement phrasing', () => {
  const phrasings = [
    'Node.js >= 22.13.0',
    'requires Node.js 22.13.0',
    'Node.js 22.13.0+',
  ];
  for (const phrasing of phrasings) {
    assert.deepStrictEqual(violationsIn('docs/x.md', phrasing, context), [], phrasing);
  }
});

test('a tool name outside the MCP catalog is drift', () => {
  const found = violationsIn('docs/x.md', 'Call `huqan.teleport` to finish.', context);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].rule, 'tool-name');
});

test('legacy aliases resolve to the same catalog entry as the canonical name', () => {
  assert.deepStrictEqual(violationsIn('docs/x.md', 'Both `huqan.learn` and `axiom.learn`.', context), []);
});

test('an unregistered /api route is drift', () => {
  const found = violationsIn('docs/x.md', 'POST `/api/nowhere`', context);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].rule, 'route');
});

test('a cited path that is not on disk is drift', () => {
  const found = violationsIn('docs/x.md', 'See `lib/not-a-real-module.js`.', context);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].rule, 'missing-path');
});

test('a path is resolved relative to the citing document as well as the root', () => {
  // specs/.../README.md cites `schemas/x.json` meaning the copy beside it.
  const text = 'See `schemas/agent-identity.schema.json`.';
  assert.deepStrictEqual(violationsIn('specs/huqan-trust-protocol/0.2/README.md', text, context), []);
});

test('records and plans are outside the checked set', () => {
  for (const file of [
    'docs/archive/old.md',
    'docs/audits/whatever.md',
    'docs/task-packs/v5-x.md',
    'docs/v4/v4-pr-plan.md',
    'CHANGELOG.md',
  ]) {
    assert.strictEqual(isRecord(file), true, file);
  }
  for (const file of ['README.md', 'docs/local-install.md', 'SECURITY.md']) {
    assert.strictEqual(isRecord(file), false, file);
  }
});

test('every allowance carries a written reason', () => {
  for (const [file, tokens] of Object.entries(ALLOWED)) {
    for (const [token, reason] of Object.entries(tokens)) {
      assert.strictEqual(typeof reason, 'string', `${file}: ${token}`);
      assert.ok(reason.length > 20, `${file}: ${token} needs a real reason`);
    }
  }
});

test('an allowance suppresses only its own token in its own file', () => {
  const text = 'Call `axiom.wipe` here.';
  assert.deepStrictEqual(violationsIn('docs/mcp-tool-name-migration.md', text, context), []);
  assert.strictEqual(violationsIn('docs/other.md', text, context).length, 1);
});
