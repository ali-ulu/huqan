'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('native CLI requires authorization and rolls back the whole file on acceptance failure', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coder-array-cli-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  const source = "module.exports = function handler(options, res) {\n  const prefix = /^GET|POST$/.test(options[0] || '');\n  res.setHeader('Allow', options.join(','));\n  return prefix;\n};\n";
  fs.writeFileSync(path.join(root, 'target.js'), source);
  fs.writeFileSync(path.join(root, 'accept.js'), "const assert = require('node:assert/strict'); const handler = require('./target'); let header; handler(['POST','GET','POST'], {setHeader: (_, v) => { header = v; }}); assert.equal(header, 'POST,GET'); handler([], {setHeader: (_, v) => { header = v; }}); assert.equal(header, '');\n");
  fs.writeFileSync(path.join(root, 'reject.js'), "const assert = require('node:assert/strict'); const handler = require('./target'); let header; handler(['GET','GET'], {setHeader: (_, v) => { header = v; }}); assert.equal(header, 'impossible');\n");
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  git(['init', '-qb', 'codex/fixture']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const request = { id: 'join', level: 'l0', allowedPaths: ['target.js'], operation: { type: 'replace_text', path: 'target.js' }, test: { command: 'node accept.js' }, synthesis: { family: 'string-array-join', target: { binding: 'options', separator: ',' }, examples: [{ input: [], output: '' }, { input: ['GET', 'GET', 'POST'], output: 'GET,POST' }, { input: ['POST', 'GET', 'POST'], output: 'POST,GET' }] } };
  const run = (task, authorize) => {
    const file = path.join(base, 'request.json'); fs.writeFileSync(file, JSON.stringify(task));
    const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', file, '--synthesize', '--root', root, '--json', ...(authorize ? ['--authorize'] : [])], { cwd: base, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result };
  };
  const denied = run(request, false); assert.equal(denied.child.status, 6, JSON.stringify(denied.result));
  assert.equal(fs.readFileSync(path.join(root, 'target.js'), 'utf8'), source);
  const invalid = structuredClone(request); invalid.synthesis.target.binding = 'missing';
  const bad = run(invalid, true); assert.equal(bad.child.status, 6, JSON.stringify(bad.result));
  assert.equal(fs.readFileSync(path.join(root, 'target.js'), 'utf8'), source);
  const mismatch = structuredClone(request); mismatch.synthesis.target.sourceHash = '0'.repeat(64);
  const stale = run(mismatch, true); assert.equal(stale.child.status, 6, JSON.stringify(stale.result));
  assert.equal(stale.result.data.attempts.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'target.js'), 'utf8'), source);
  const reject = structuredClone(request); reject.test.command = 'node reject.js';
  const failed = run(reject, true); assert.equal(failed.child.status, 6, JSON.stringify(failed.result));
  assert.ok(failed.result.data.attempts.length >= 1 && failed.result.data.attempts.length <= 8, JSON.stringify(failed.result));
  assert.ok(failed.result.data.attempts.every(a => a.rolledBack && a.test.exitCode === 1));
  assert.equal(fs.readFileSync(path.join(root, 'target.js'), 'utf8'), source);
  assert.equal(git(['diff', '--exit-code']).toString(), '');
  const accepted = run(request, true); assert.equal(accepted.child.status, 0, JSON.stringify(accepted.result));
  assert.equal(accepted.result.data.outcome, 'applied_tested');
  assert.equal(accepted.result.data.attempts[0].test.exitCode, 0);
  assert.ok(accepted.result.data.synthesis.enumerated <= accepted.result.data.synthesis.searchBudget);
  assert.match(fs.readFileSync(path.join(root, 'target.js'), 'utf8'), /\^GET\|POST\$/);
});
