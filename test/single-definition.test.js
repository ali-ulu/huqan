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

test('declaresAny matches a declaration and not a call site', () => {
  const [rule] = RULES;
  const declaration = 'function normalizeWorkspaceId(value) {\n  return value;\n}';
  const methodDeclaration = '  normalizeWorkspaceId(value) {\n    return value;\n  }';
  const arrowDeclaration = 'const normalizeWorkspaceId = (value) => value;';
  const callSite = "const id = normalizeWorkspaceId(input.workspaceId);";
  const destructuredImport = "const { normalizeWorkspaceId } = require('./workspace-id');";

  for (const source of [declaration, methodDeclaration, arrowDeclaration]) {
    assert.equal(declaresAny(source, rule.patterns), true, source);
  }
  for (const source of [callSite, destructuredImport]) {
    assert.equal(declaresAny(source, rule.patterns), false, source);
  }
});

test('declaresAny ignores a declaration shown in a comment', () => {
  const [rule] = RULES;
  const commented = [
    '// function normalizeWorkspaceId(value) { return value; }',
    ' * normalizeWorkspaceId(value) { return value; }',
    '/* const normalizeWorkspaceId = (value) => value; */',
  ].join('\n');

  assert.equal(declaresAny(commented, rule.patterns), false);
});

test('the scan finds the canonical declaration', () => {
  const [rule] = RULES;
  assert.equal(scanRule(rule).includes(rule.canonical), true);
});

test('the committed baseline tolerates exactly the declarations present in the tree', () => {
  const baseline = readBaseline();
  const [rule] = RULES;
  const found = scanRule(rule).filter((file) => file !== rule.canonical);
  const tolerated = (baseline.rules[rule.name] || []).filter((file) => file !== rule.canonical);

  assert.deepEqual([...tolerated].sort(), [...found].sort());
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

test('a new declaration fails the gate', (t) => {
  const scratch = path.join(repoRoot, 'lib', 'zz-scratch-single-definition.js');
  fs.writeFileSync(scratch, 'function normalizeWorkspaceId(value) {\n  return value;\n}\n');
  t.after(() => fs.rmSync(scratch, { force: true }));

  const { status, stderr } = runGate();
  assert.equal(status, 1);
  assert.match(stderr, /new-declaration/);
  assert.match(stderr, /zz-scratch-single-definition\.js/);
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
  const baselinePath = path.join(repoRoot, 'config', 'single-definition-baseline.json');
  const original = fs.readFileSync(baselinePath, 'utf8');
  fs.writeFileSync(baselinePath, '{ not json');
  try {
    assert.throws(() => readBaseline(), /cannot read/);
  } finally {
    fs.writeFileSync(baselinePath, original);
  }
});

test('the scan never leaves the lib directory', () => {
  const scratch = path.join(os.tmpdir(), 'single-definition-outside.js');
  fs.writeFileSync(scratch, 'function normalizeWorkspaceId(value) {\n  return value;\n}\n');
  try {
    const { status } = runGate();
    assert.equal(status, 0, 'a declaration outside lib/ must not be reported');
  } finally {
    fs.rmSync(scratch, { force: true });
  }
});
