'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { synthesizeArithmetic, runArithmeticSynthesis } = require('../lib/coder/arithmetic-synthesis');
const { readStringTarget } = require('../lib/experience/string-program');
const content = 'function clean(value) { return value.toUpperCase(); }\nmodule.exports = clean;\n';
const request = () => ({ id: 'clean-text', level: 'l0', allowedPaths: ['text.js'],
  operation: { type: 'replace_text', path: 'text.js' }, test: { command: 'node acceptance.js' },
  synthesis: { family: 'string-expression', functionName: 'clean', examples: [
    { input: ' ABC ', expected: 'abc' }, { input: ' MiXeD ', expected: 'mixed' }, { input: '', expected: '' },
  ] } });
test('synthesizes a bounded string program from observations without executing the target', () => {
  const task = request();
  const result = synthesizeArithmetic({ task, content: content + 'throw new Error("must not execute");' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.plan.family, 'string-expression');
  assert.ok(result.plan.enumerated <= result.plan.searchBudget);
  assert.equal(result.task.synthesis, undefined);
  assert.match(result.task.operation.replace, /trim/);
  assert.match(result.task.operation.replace, /toLowerCase/);
  assert.equal(result.task.operation.find, 'function clean(value) { return value.toUpperCase(); }');
});
test('native string synthesis enforces authorization, independent acceptance and whole-file rollback', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coder-string-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'text.js'), content);
  fs.writeFileSync(path.join(root, 'reject.js'), content);
  fs.writeFileSync(path.join(root, 'acceptance.js'), 'const assert=require("node:assert/strict");const f=require("./text");assert.equal(f(" ÄBC "),"äbc");assert.equal(f(" OTHER "),"other");');
  fs.writeFileSync(path.join(root, 'reject-test.js'), 'const assert=require("node:assert/strict");const f=require("./reject");assert.equal(f(" OTHER "),"intentionally-wrong");');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/fixture']);
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']); };
  commit();
  const file = path.join(base, 'request.json');
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  const run = authorized => {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', file,
      '--synthesize', '--root', root, '--json', ...(authorized ? ['--authorize'] : [])],
    { cwd: base, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result };
  };
  fs.writeFileSync(file, JSON.stringify(request()));
  const denied = run(false); assert.equal(denied.child.status, 6, JSON.stringify(denied.result));
  assert.equal(fs.readFileSync(path.join(root, 'text.js'), 'utf8'), content);
  const good = run(true); assert.equal(good.child.status, 0, JSON.stringify(good.result));
  assert.equal(good.result.data.outcome, 'applied_tested');
  assert.equal(good.result.data.synthesis.enumerated, 1885);
  assert.equal(good.result.data.attempts[0].test.exitCode, 0);
  commit();
  const wrong = request(); wrong.allowedPaths = ['reject.js']; wrong.operation.path = 'reject.js'; wrong.test.command = 'node reject-test.js';
  fs.writeFileSync(file, JSON.stringify(wrong));
  const rejected = run(true); assert.equal(rejected.child.status, 6, JSON.stringify(rejected.result));
  assert.ok(rejected.result.data.attempts.length >= 1 && rejected.result.data.attempts.length <= 8);
  assert.ok(rejected.result.data.attempts.every(attempt => attempt.rolledBack === true && attempt.test.exitCode === 1));
  assert.equal(fs.readFileSync(path.join(root, 'reject.js'), 'utf8'), content);
  assert.equal(git(['diff', '--exit-code']).toString(), '');
});
test('unsupported string programs, invalid observations and unsupported memory options fail closed', () => {
  for (const source of [content.replace('value.toUpperCase()', 'process.exit()'),
    content.replace('value.toUpperCase()', 'value["trim"]()'),
    content.replace('value.toUpperCase()', 'value.repeat(1000000000)')])
    assert.equal(synthesizeArithmetic({ task: request(), content: source }).reason, 'SYNTHESIS_TARGET_UNSUPPORTED');
  const bad = request(); bad.synthesis.examples[0].expected = 1;
  assert.equal(synthesizeArithmetic({ task: bad, content }).reason, 'SYNTHESIS_EXAMPLES_INVALID');
  const huge = request(); huge.synthesis.examples[0].input = 'x'.repeat(1025);
  assert.equal(synthesizeArithmetic({ task: huge, content }).reason, 'SYNTHESIS_EXAMPLES_INVALID');
  const sparse = request(); delete sparse.synthesis.examples[1];
  assert.equal(synthesizeArithmetic({ task: sparse, content }).reason, 'SYNTHESIS_EXAMPLES_INVALID');
  const already = request(); already.synthesis.examples = already.synthesis.examples.map(row => ({ ...row, expected: row.input.toUpperCase() }));
  assert.equal(synthesizeArithmetic({ task: already, content }).reason, 'SYNTHESIS_ALREADY_SATISFIED');
  for (const flag of [{ reuseMemory: true }, { rememberFile: '.huqan/coder/candidates/text.json' }]) {
    const task = request(); Object.assign(task.synthesis, flag);
    assert.equal(runArithmeticSynthesis({ task }).reason, 'SYNTHESIS_STRING_MEMORY_UNSUPPORTED');
  }
});
test('the closed string reader preserves slice semantics, bounds and return line breaks', () => {
  for (const [operation, expected] of [
    ['trim()', 'AbC'], ['toLowerCase()', ' abc '], ['toUpperCase()', ' ABC '],
    ['slice(1)', 'AbC '], ['slice(2)', 'bC '], ['slice(3)', 'C '],
    ['slice(-1)', ' '], ['slice(-2)', 'C '], ['slice(-3)', 'bC '],
    ['slice(0,1)', ' '], ['slice(0,2)', ' A'], ['slice(0,3)', ' Ab'],
  ]) {
    const module = readStringTarget(`function clean($text) { return $text.${operation}; }`, { functionName: 'clean' });
    assert.ok(module, operation);
    assert.equal(module.evaluate(' AbC '), expected, operation);
    assert.equal(readStringTarget(module.instantiate(module.program), { functionName: 'clean' }).canonicalExpression, module.canonicalExpression);
    assert.throws(() => module.evaluate('x'.repeat(1025)), /STRING_PROGRAM/);
  }
  assert.equal(readStringTarget('function clean(x) { return\nx.trim(); }', { functionName: 'clean' }), null);
  const expansion = readStringTarget('function clean(x) { return x.toUpperCase(); }', { functionName: 'clean' });
  assert.throws(() => expansion.evaluate('ß'.repeat(1024)), /STRING_PROGRAM_OVER_CAP/);
  const task = request(); task.synthesis.examples = [{ input: 'abcX', expected: 'X' }, { input: 'abcYY', expected: 'YY' }, { input: '', expected: '' }];
  assert.match(synthesizeArithmetic({ task, content }).task.operation.replace, /slice\(3\)/);
  task.synthesis.examples = [{ input: 'a', expected: '12345' }, { input: 'b', expected: '67890' }, { input: '', expected: 'added' }];
  assert.equal(synthesizeArithmetic({ task, content }).reason, 'SYNTHESIS_NO_SOLUTION');
});
