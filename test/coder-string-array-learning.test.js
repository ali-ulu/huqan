'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');

test('CLI remembers only accepted array candidates and reuses a verified candidate in a fresh process', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coder-array-memory-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = "module.exports = function handler(options, res) {\n  const prefix = /^GET|POST$/.test(options[0] || '');\n  res.setHeader('Allow', options.join(','));\n  return prefix;\n};\n";
  const write = (file, text) => { const full = path.join(root, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); };
  for (const name of ['failed', 'train', 'other', 'reuse', 'corrupt', 'selector']) {
    write(`src/${name}.js`, name === 'other' ? source.replaceAll('options', 'methods') : source);
    write(`test/${name}.js`, `const assert = require('node:assert/strict'); const handler = require('../src/${name}'); let value; handler(['POST','GET','POST'], {setHeader: (_, v) => { value = v; }}); assert.equal(value, '${name === 'failed' ? 'impossible' : 'POST,GET'}'); handler([], {setHeader: (_, v) => { value = v; }}); ${name === 'failed' ? '' : "assert.equal(value, '');"}\n`);
  }
  write('.gitignore', '.huqan/\n*.db*\nrequest.json\n');
  write('qualify/drift.js', 'no matching expression\n');
  write('qualify/ambiguous.js', "options.join(',')\noptions.join(',')\n");
  write('qualify/other-ambiguous.js', "methods.join(',')\nmethods.join(',')\n");
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  const commit = () => { git(['add', 'src', 'test', 'qualify', '.gitignore']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); };
  git(['init', '-qb', 'codex/fixture']); commit();
  const task = name => ({ id: name, level: 'l0', allowedPaths: [`src/${name}.js`], operation: { type: 'replace_text', path: `src/${name}.js` }, test: { command: `node test/${name}.js` }, synthesis: { family: 'string-array-join', target: { binding: 'options', separator: ',' }, reuseMemory: true, examples: [{ input: [], output: '' }, { input: ['GET', 'GET', 'POST'], output: 'GET,POST' }, { input: ['POST', 'GET', 'POST'], output: 'POST,GET' }] } });
  const cli = (request, expected) => {
    write('request.json', JSON.stringify(request));
    const env = { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'state') }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'request.json', '--synthesize', '--authorize', '--root', root, '--journal', path.join(root, 'journal.db'), '--run-id', request.id, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error)); assert.equal(child.status, expected, child.stdout + child.stderr);
    return JSON.parse(child.stdout).data;
  };
  const failed = task('failed'); failed.synthesis.rememberFile = '.huqan/coder/candidates/failed.json';
  const rejected = cli(failed, 6);
  assert.ok(rejected.attempts.length > 0, JSON.stringify(rejected));
  assert.ok(rejected.attempts.every(a => a.rolledBack && a.test.exitCode === 1));
  assert.equal(fs.readFileSync(path.join(root, 'src/failed.js'), 'utf8'), source);
  assert.equal(fs.existsSync(path.join(root, failed.synthesis.rememberFile)), false);
  const train = task('train'); train.qualificationPaths = ['qualify/drift.js', 'qualify/ambiguous.js']; train.synthesis.rememberFile = '.huqan/coder/candidates/join.json';
  const trained = cli(train, 0); assert.equal(trained.outcome, 'applied_tested'); assert.equal(trained.synthesis.memory.ok, true, JSON.stringify(trained));
  const candidate = path.join(root, train.synthesis.rememberFile);
  const store = openCoderJournal(path.join(root, 'journal.db'));
  try { assert.equal(store.journal.manifest(trained.synthesis.sourceRunId).learningEligibility, 'positive_procedure'); } finally { store.close(); }
  commit();
  const other = task('other'); other.synthesis.target.binding = 'methods';
  other.qualificationPaths = ['qualify/drift.js', 'qualify/other-ambiguous.js'];
  other.synthesis.rememberFile = '.huqan/coder/candidates/a-other.json';
  const otherTraining = cli(other, 0); assert.equal(otherTraining.synthesis.memory.ok, true, JSON.stringify(otherTraining));
  commit();
  const reused = cli(task('reuse'), 0); assert.equal(reused.outcome, 'applied_tested');
  assert.equal(reused.synthesis.memoryReuse.outcome, 'applied_tested'); assert.equal(reused.synthesis.enumerated, 0);
  assert.equal(reused.attempts.length, 1); assert.equal(reused.attempts[0].test.exitCode, 0); commit();
  const badSelector = task('selector'); badSelector.synthesis.target.binding = 'wrong';
  const refused = cli(badSelector, 6); assert.equal(refused.attempts.length, 0, JSON.stringify(refused));
  assert.equal(fs.readFileSync(path.join(root, 'src/selector.js'), 'utf8'), source);
  const candidateFd = fs.openSync(candidate, 'r+');
  try {
    const artifact = JSON.parse(fs.readFileSync(candidateFd, 'utf8'));
    artifact.params.newText = '"tampered"';
    const bytes = Buffer.from(JSON.stringify(artifact));
    fs.writeSync(candidateFd, bytes, 0, bytes.length, 0);
    fs.ftruncateSync(candidateFd, bytes.length);
  } finally { fs.closeSync(candidateFd); }
  const corrupt = cli(task('corrupt'), 6); assert.equal(corrupt.attempts.length, 0, JSON.stringify(corrupt));
  assert.equal(fs.readFileSync(path.join(root, 'src/corrupt.js'), 'utf8'), source);
});
