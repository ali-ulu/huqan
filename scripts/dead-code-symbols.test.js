'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkUnusedNamedExports,
  checkUnusedTypes,
} = require('./dead-code-symbols');

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-dead-code-symbols-'));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  return root;
}

function allowlist(overrides = {}) {
  return {
    exportModules: [],
    exports: [],
    types: [],
    ...overrides,
  };
}

test('unused named exports are reported with file:line and consumed exports are ignored', () => {
  const root = fixtureRoot();
  fs.writeFileSync(
    path.join(root, 'lib', 'surface.js'),
    [
      "function used() { return 'used'; }",
      "function dead() { return 2; }",
      'module.exports = {',
      '  used,',
      '  dead,',
      '};',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'consumer.js'), "const { used } = require('./lib/surface');\nused();\n");

  const result = checkUnusedNamedExports({ root, allowlist: allowlist() });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unused.map((entry) => [entry.file, entry.name, entry.line]), [
    ['lib/surface.js', 'dead', 5],
  ]);
  assert.match(result.report, /lib\/surface\.js:5 exported 'dead'/);
});

test('intentional public export modules and exact exports can be allowlisted', () => {
  const root = fixtureRoot();
  fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = { PublicApi };\nfunction PublicApi() {}\n');
  fs.writeFileSync(path.join(root, 'lib', 'surface.js'), 'module.exports = { compatibilityHook };\nfunction compatibilityHook() {}\n');

  const result = checkUnusedNamedExports({
    root,
    allowlist: allowlist({
      exportModules: ['index.js'],
      exports: [{ path: 'lib/surface.js', name: 'compatibilityHook', reason: 'compatibility contract' }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.allowed.length, 2);
});

test('unused exported declaration types are reported while referenced declarations pass', () => {
  const root = fixtureRoot();
  fs.writeFileSync(
    path.join(root, 'index.d.ts'),
    [
      'export interface UsedOptions { value: string; }',
      'export type DeadAlias = string;',
      'export function create(options: UsedOptions): void;',
      '',
    ].join('\n'),
  );

  const result = checkUnusedTypes({ root, allowlist: allowlist() });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unused.map((entry) => [entry.file, entry.name, entry.line]), [
    ['index.d.ts', 'DeadAlias', 2],
  ]);
  assert.match(result.report, /index\.d\.ts:2 exported type 'DeadAlias'/);
});

test('intentional externally-consumed declaration types can be allowlisted', () => {
  const root = fixtureRoot();
  fs.writeFileSync(path.join(root, 'index.d.ts'), 'export interface ExternalOnly { value: string; }\n');

  const result = checkUnusedTypes({
    root,
    allowlist: allowlist({
      types: [{ path: 'index.d.ts', name: 'ExternalOnly', reason: 'documented public type' }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.allowed.length, 1);
});


test('whole-module or dynamic namespace use is treated conservatively instead of producing false positives', () => {
  const root = fixtureRoot();
  fs.writeFileSync(path.join(root, 'lib', 'surface.js'), 'module.exports = { one, two };\nfunction one() {} function two() {}\n');
  fs.writeFileSync(path.join(root, 'consumer.js'), "const surface = require('./lib/surface');\nObject.keys(surface);\n");

  const result = checkUnusedNamedExports({ root, allowlist: allowlist() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.unused, []);
});


test('an internally used export is not dead merely because no external consumer selects it', () => {
  const root = fixtureRoot();
  fs.writeFileSync(
    path.join(root, 'lib', 'surface.js'),
    [
      'function publicHelper() { return 1; }',
      'function internalConsumer() { return publicHelper(); }',
      'module.exports = { publicHelper, internalConsumer };',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'consumer.js'), "const { internalConsumer } = require('./lib/surface');\ninternalConsumer();\n");

  const result = checkUnusedNamedExports({ root, allowlist: allowlist() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.unused, []);
});
