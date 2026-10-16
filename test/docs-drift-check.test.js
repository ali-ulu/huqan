'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  collectDrift,
  violationsIn,
  isRecord,
  releaseSections,
  ALLOWED,
} = require('../scripts/check-docs-drift.js');

const context = {
  nodeMajor: '22',
  packageVersion: '0.11.1',
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

test('a documented status-endpoint version other than the package version is drift', () => {
  // The exact claim docs/architecture.md carried: v0.9.0 while the package
  // shipped 0.11.1, falsifiable by calling the endpoint it describes.
  const found = violationsIn('docs/x.md', 'The endpoint answers `version=0.9.0`.', context);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].rule, 'release-version');
});

test('a published package spec at another version is drift', () => {
  const found = violationsIn('docs/x.md', 'Install huqan@0.9.0 to begin.', context);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].rule, 'release-version');
});

test('the shipped version passes in both self-marking forms', () => {
  for (const phrasing of ['version=0.11.1', 'huqan@0.11.1']) {
    assert.deepStrictEqual(violationsIn('docs/x.md', phrasing, context), [], phrasing);
  }
});

test('every version inside a Current Release section is held to the package', () => {
  const section = '## Current Release Contract\n\nRelease:\n\n```text\nv0.9.0\n```\n';
  const found = violationsIn('docs/x.md', section, context);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].rule, 'release-version');
});

test('a Current Release section naming the shipped version passes', () => {
  const section = '## Current Release Contract\n\nRelease:\n\n```text\n0.11.1\n```\n';
  assert.deepStrictEqual(violationsIn('docs/x.md', section, context), []);
});

test('a release section ends at the next heading of the same or a higher level', () => {
  // A later section listing past releases is history, not a current claim, so
  // the scan must not run past the heading that ends the release section.
  const text = '## Current Release\n\n0.11.1\n\n## Past Releases\n\n0.9.0 and 0.10.0\n';
  assert.deepStrictEqual(violationsIn('docs/x.md', text, context), []);
  const [body] = releaseSections(text);
  assert.ok(!body.includes('0.9.0'), 'the release section must stop at the next heading');
});

test('a version outside a release marker is not drift', () => {
  // The 121 legitimate mentions the axis deliberately does not touch: an ADR
  // naming the version it was decided under, a spec numbering itself, a pin.
  const prose = [
    'ADR-007 was accepted for v0.9.2 and still applies.',
    'The protocol spec at 0.2 ships its own vectors.',
    'Pin better-sqlite3 to 11.5.0 for the prebuilt binary.',
  ].join('\n');
  assert.deepStrictEqual(violationsIn('docs/x.md', prose, context), []);
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
