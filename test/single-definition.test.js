'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  RULES,
  collectViolations,
  declaresAny,
  readBaseline,
  scanRule,
} = require('../scripts/check-single-definition');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-single-definition.js');

function runGate(args = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('every declared rule names a canonical file that exists', () => {
  for (const rule of RULES) {
    assert.equal(fs.existsSync(path.join(repoRoot, rule.canonical)), true, rule.canonical);
    assert.ok(rule.patterns.length > 0, `${rule.name} has no patterns`);
  }
});

test('declaresAny matches every declaration shape and no call site', () => {
  const [rule] = RULES;
  const declarations = {
    'function declaration': 'function normalizeWorkspaceId(value) {\n  return value;\n}',
    'async function declaration': 'async function normalizeWorkspaceId(value) {\n  return value;\n}',
    'arrow assignment': 'const normalizeWorkspaceId = (value) => value;',
    'function expression': 'const normalizeWorkspaceId = function (value) { return value; };',
    'async arrow assignment': 'const normalizeWorkspaceId = async (value) => value;',
    'async function expression': 'const normalizeWorkspaceId = async function (value) { return value; };',
    'single-parameter arrow': 'const normalizeWorkspaceId = value => value;',
    'object property arrow': 'module.exports = { normalizeWorkspaceId: (value) => value };',
    'object property function': 'module.exports = { normalizeWorkspaceId: function (value) { return value; } };',
    'class method': 'class Gate {\n  normalizeWorkspaceId(value) {\n    return value;\n  }\n}',
    'object method shorthand': 'const gate = { normalizeWorkspaceId(value) { return value; } };',
    'method with default parameter': 'const gate = { normalizeWorkspaceId(value = getDefault()) { return value; } };',
    'declaration split across lines': 'const normalizeWorkspaceId =\n  (value) =>\n  value;',
    'function parameters across lines': 'function normalizeWorkspaceId(\n  value,\n) {\n  return value;\n}',
  };
  const nonDeclarations = {
    'call site': 'const id = normalizeWorkspaceId(input.workspaceId);',
    'destructured import': "const { normalizeWorkspaceId } = require('./workspace-id');",
    'member call': 'gate.normalizeWorkspaceId(input.workspaceId);',
    're-export alias': "const normalizeWorkspaceId = require('./workspace-id').normalizeWorkspaceId;",
    'plain alias': 'const normalizeWorkspaceId = canonicalNormalizeWorkspaceId;',
  };

  for (const [name, source] of Object.entries(declarations)) {
    assert.equal(declaresAny(source, rule.patterns), true, name);
  }
  for (const [name, source] of Object.entries(nonDeclarations)) {
    assert.equal(declaresAny(source, rule.patterns), false, name);
  }
});

test('declaresAny ignores a declaration shown in a comment or a string', () => {
  const [rule] = RULES;
  const quoted = [
    '// function normalizeWorkspaceId(value) { return value; }',
    '/**',
    ' * normalizeWorkspaceId(value) { return value; }',
    ' */',
    '/* const normalizeWorkspaceId = (value) => value; */',
    "const label = 'normalizeWorkspaceId = (value) => value';",
    'const rendered = `normalizeWorkspaceId: (value) => value`;',
  ].join('\n');

  assert.equal(declaresAny(quoted, rule.patterns), false);
});

test('the scan finds the canonical declaration', () => {
  const [rule] = RULES;
  assert.equal(scanRule(rule).includes(rule.canonical), true);
});

test('the committed baseline tolerates exactly the declarations present in the tree', () => {
  const baseline = readBaseline();
  for (const rule of RULES) {
    const found = scanRule(rule).filter((file) => file !== rule.canonical);
    const tolerated = (baseline.rules[rule.name] || []).filter((file) => file !== rule.canonical);

    assert.deepEqual([...tolerated].sort(), [...found].sort(), rule.name);
  }
});

test('every tolerated declaration carries a reason', () => {
  const baseline = readBaseline();
  for (const rule of RULES) {
    for (const file of baseline.rules[rule.name] || []) {
      if (file === rule.canonical) continue;
      assert.ok(String(baseline.reasons[file] || '').trim(), `${file} has no reason`);
    }
  }
});

test('the committed tree passes the gate', () => {
  const { status, stdout } = runGate();
  assert.equal(status, 0, stdout);
});

test('a new declaration fails the gate, whatever shape it takes', (t) => {
  const scratch = path.join(repoRoot, 'lib', 'zz-scratch-single-definition.js');
  t.after(() => fs.rmSync(scratch, { force: true }));

  // The shapes a line-oriented matcher used to miss (#4033 review). Each one
  // must be a hard failure, not a silent pass.
  const shapes = [
    'function normalizeWorkspaceId(value) {\n  return value;\n}\n',
    'const normalizeWorkspaceId = function (value) { return value; };\n',
    'const normalizeWorkspaceId = async (value) => value;\n',
    'const normalizeWorkspaceId = value => value;\n',
    'module.exports = { normalizeWorkspaceId: (value) => value };\n',
    'const gate = { normalizeWorkspaceId(value = getDefault()) { return value; } };\n',
    'const normalizeWorkspaceId =\n  (value) =>\n  value;\n',
  ];

  for (const source of shapes) {
    fs.writeFileSync(scratch, source);
    const { status, stderr } = runGate();
    assert.equal(status, 1, source);
    assert.match(stderr, /new-declaration/, source);
    assert.match(stderr, /zz-scratch-single-definition\.js/, source);
  }
});

test('a duplicate of any ruled helper fails the gate, not just the first rule', (t) => {
  const scratch = path.join(repoRoot, 'lib', 'zz-scratch-ruled-helper.js');
  t.after(() => fs.rmSync(scratch, { force: true }));

  // #4116: a private `function isPlainObject` in lib/cognition/cognition-config.js
  // reached main because only test/is-plain-object.test.js pinned the predicate,
  // and the impact plan for that file never selected it. Every rule must fail the
  // gate on a new declaration, so the guard is the gate itself and not one test.
  for (const rule of RULES) {
    fs.writeFileSync(scratch, `function ${rule.name}(value) {\n  return value;\n}\n`);
    const { status, stderr } = runGate();
    assert.equal(status, 1, rule.name);
    assert.match(stderr, /new-declaration/, rule.name);
    assert.match(stderr, new RegExp(rule.name), rule.name);
  }
});

test('--update cannot bless a new declaration', (t) => {
  const scratch = path.join(repoRoot, 'lib', 'zz-scratch-single-definition.js');
  fs.writeFileSync(scratch, 'function normalizeWorkspaceId(value) {\n  return value;\n}\n');
  t.after(() => fs.rmSync(scratch, { force: true }));

  const before = fs.readFileSync(path.join(repoRoot, 'config', 'single-definition-baseline.json'), 'utf8');
  const { status } = runGate(['--update']);
  const after = fs.readFileSync(path.join(repoRoot, 'config', 'single-definition-baseline.json'), 'utf8');

  assert.equal(status, 1);
  assert.equal(after, before, '--update must not rewrite the baseline while a new declaration is present');
});

test('a stale baseline entry fails the gate', () => {
  const [rule] = RULES;
  const present = scanRule(rule).filter((file) => file !== rule.canonical);
  const reasons = Object.fromEntries(present.map((file) => [file, 'test fixture']));
  const baseline = {
    rules: { [rule.name]: [rule.canonical, ...present, 'lib/does-not-exist.js'] },
    reasons,
  };
  const violations = collectViolations(baseline);
  assert.deepEqual(violations.map((violation) => violation.kind), ['stale-baseline']);
});

test('a tolerated declaration without a reason fails the gate', () => {
  const [rule] = RULES;
  const baseline = { rules: { [rule.name]: scanRule(rule) }, reasons: {} };
  const violations = collectViolations(baseline);
  const kinds = new Set(violations.map((violation) => violation.kind));

  assert.ok(violations.length > 0);
  assert.deepEqual([...kinds], ['unreasoned-baseline']);
});

test('a rule whose canonical file stops declaring the helper fails the gate', () => {
  const rule = { name: 'normalizeWorkspaceId', canonical: 'lib/not-a-real-file.js', patterns: RULES[0].patterns };
  const original = RULES[0].canonical;
  RULES[0].canonical = rule.canonical;
  try {
    const violations = collectViolations({ rules: {}, reasons: {} });
    assert.ok(violations.some((violation) => violation.kind === 'missing-canonical'));
  } finally {
    RULES[0].canonical = original;
  }
});

test('an unreadable baseline is reported, not swallowed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'single-definition-'));
  const baselinePath = path.join(directory, 'single-definition-baseline.json');
  fs.writeFileSync(baselinePath, '{ not json');
  try {
    assert.throws(() => readBaseline(baselinePath), /cannot read/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the scan never leaves the lib directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'single-definition-'));
  const [rule] = RULES;
  const outside = path.join(directory, 'outside.js');
  fs.writeFileSync(outside, 'function normalizeWorkspaceId(value) {\n  return value;\n}\n');
  try {
    // The matcher does see the file when pointed at its directory...
    assert.equal(scanRule(rule, directory).length, 1);
    // ...but the gate's own scope is lib/, so it is never reported.
    assert.equal(scanRule(rule).includes(path.relative(repoRoot, outside)), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
