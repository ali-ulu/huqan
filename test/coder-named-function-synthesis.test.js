'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { synthesizeArithmetic } = require('../lib/coder/arithmetic-synthesis');
const { readArithmeticTarget } = require('../lib/experience/expression-adaptation');

test('production CLI synthesizes and transfers a named function while preserving unrelated project code', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-named-synthesis-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text); };
  const original = (name, parameter) => `'use strict';\nconst path = require('node:path');\n`
    + `function helper(${parameter}) { return ${parameter} + 1; }\n`
    + (name === 'calculate' ? `function calculate ( ${parameter} ) {\n /* distinct target */ return ${parameter} + 1;\n}\n`
      : `function ${name}(${parameter}) { /* preserve this */ return ${parameter} + 1; }\n`)
    + `module.exports = { calculate: ${name}, helper, separator: path.sep };\n`;
  const specs = [['train', 'estimate', 'number'], ['transfer', 'calculate', 'amount'], ['reject', 'rejectValue', 'qty']];
  for (const [file, name, parameter] of specs) {
    write(`src/${file}.js`, original(name, parameter));
    write(`test/${file}.js`, `const assert = require('node:assert/strict');\n`
      + `const api = require('../src/${file}');\nassert.equal(api.helper(5), 6);\n`
      + `assert.equal(api.calculate(5), ${file === 'reject' ? 99 : 26});\nassert.equal(api.calculate(8), 65);\n`);
  }
  write('src/duplicate.js', 'function duplicate(x) { return x + 1; }\nfunction duplicate(x) { return x + 1; }\n');
  const trainingFunction = readArithmeticTarget(original('estimate', 'number'), { functionName: 'estimate' }).find;
  write('qualify/drift.md', 'no matching function');
  write('qualify/ambiguous.md', `${trainingFunction}\n${trainingFunction}`);
  write('.gitignore', '*.json\n*.db*\n.huqan/\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const commit = () => { git(['add', 'src', 'test', 'qualify', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); };
  git(['init', '-qb', 'feat/named-synthesis']); commit();
  const request = (file, functionName) => ({ id: file, level: 'l0', allowedPaths: [`src/${file}.js`],
    operation: { type: 'replace_text', path: `src/${file}.js` }, test: { command: `node test/${file}.js` },
    synthesis: { family: 'arithmetic-expression', functionName, reuseMemory: true,
      examples: [{ input: 0, expected: 1 }, { input: 1, expected: 2 }, { input: 2, expected: 5 }] } });
  const cli = (task, expectedStatus = 0) => {
    const file = path.join(root, `${task.id}.json`); fs.writeFileSync(file, JSON.stringify(task));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', file,
      '--root', root, '--journal', path.join(root, 'journal.db'), '--run-id', task.id,
      '--synthesize', '--authorize', '--json'], { encoding: 'utf8', cwd: root, timeout: 120000,
        maxBuffer: 1048576, env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') } });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, expectedStatus, child.stdout + child.stderr);
    return JSON.parse(child.stdout).data;
  };
  const training = request('train', 'estimate');
  training.qualificationPaths = ['qualify/drift.md', 'qualify/ambiguous.md'];
  training.synthesis.rememberFile = '.huqan/coder/candidates/quadratic.json';
  const trained = cli(training);
  assert.equal(trained.outcome, 'applied_tested', JSON.stringify(trained));
  assert.equal(trained.synthesis.memory.ok, true, JSON.stringify(trained.synthesis.memory));
  assert.equal(trained.synthesis.memoryReuse.attempted, false);
  const candidate = fs.readFileSync(path.join(root, training.synthesis.rememberFile), 'utf8');
  for (const [file, name, parameter, result] of [['train', 'estimate', 'number', trained]]) {
    assert.equal(fs.readFileSync(path.join(root, `src/${file}.js`), 'utf8'),
      original(name, parameter).replace(result.synthesis.operation.find, () => result.synthesis.operation.replace));
  }
  commit();
  const transferred = cli(request('transfer', 'calculate'));
  assert.equal(transferred.outcome, 'applied_tested', JSON.stringify(transferred));
  assert.equal(transferred.synthesis.memoryReuse.attempted, true);
  assert.equal(transferred.synthesis.enumerated, 0);
  assert.equal(transferred.attempts.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'src/transfer.js'), 'utf8'), original('calculate', 'amount')
    .replace(transferred.synthesis.operation.find, () => transferred.synthesis.operation.replace));
  assert.equal(fs.readFileSync(path.join(root, training.synthesis.rememberFile), 'utf8'), candidate);
  commit();
  const rejected = cli(request('reject', 'rejectValue'), 6);
  assert.equal(rejected.outcome, 'needs_human_decision');
  assert.equal(rejected.synthesis.memoryReuse.outcome, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(root, 'src/reject.js'), 'utf8'), original('rejectValue', 'qty'));
  assert.equal(rejected.attempts.every(row => row.rolledBack === true), true);
  const duplicate = cli(request('duplicate', 'duplicate'), 6);
  assert.equal(duplicate.reason, 'SYNTHESIS_TARGET_UNSUPPORTED');
  assert.equal(duplicate.attempts.length, 0);
  assert.equal(synthesizeArithmetic({ task: request('train', 'helper'),
    content: original('estimate', 'number') }).ok, true);
});
