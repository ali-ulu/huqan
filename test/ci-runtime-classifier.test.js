const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'benchmark.yml');

let scriptPath;

/**
 * Extract the workflow's own is_runtime_file() and run it, rather than
 * reimplementing the rules here. A copy in the test would let the workflow
 * drift back to fail-open while the test kept passing (#752).
 */
before(() => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const start = workflow.indexOf('is_runtime_file() {');
  assert.ok(start > 0, 'is_runtime_file() not found in benchmark.yml');
  const end = workflow.indexOf('is_test_file() {', start);
  assert.ok(end > start, 'could not bound is_runtime_file()');

  // The block is indented inside the YAML `run:` scalar; strip the common
  // indent so bash sees a plain function definition.
  const block = workflow.slice(start, end).replace(/^ {10}/gm, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-classifier-'));
  scriptPath = path.join(dir, 'classify.sh');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\n${block}\nis_runtime_file "$1"\n`);
});

after(() => {
  if (scriptPath) fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
});

function isRuntime(filePath) {
  const result = spawnSync('bash', [scriptPath, filePath], { encoding: 'utf8' });
  assert.strictEqual(result.error, undefined, `bash failed for ${filePath}`);
  return result.status === 0;
}

function usableBash() {
  const probe = spawnSync('bash', [
    '-c', '[ "$1" = cli.js ] && printf huqan-bash-ok', 'huqan-probe', 'cli.js',
  ], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout === 'huqan-bash-ok';
}

describe('CI runtime classifier is fail-closed (#752)', {
  skip: usableBash() ? false : 'requires a usable POSIX bash; Windows system bash.exe is not one',
}, () => {
  it('classifies the surfaces the issue named', () => {
    for (const file of [
      'adapters/github-adapter.js',
      'adapters/http-adapter.js',
      'adapters/markdown-adapter.js',
      'adapters/pdf-adapter.js',
      'adapters/yaml-adapter.js',
      'adapters/json-adapter.js',
      'adapters/git-log-adapter.js',
      'github-app-server.js',
    ]) {
      assert.strictEqual(isRuntime(file), true, `${file} must require the full test suite`);
    }
  });

  it('every published JavaScript file is classified as runtime', () => {
    // Derived from the package inventory rather than restated, so a newly
    // published file is covered the moment it ships.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const published = pkg.files.filter((entry) => entry.endsWith('.js'));
    assert.ok(published.length > 50, 'expected a substantial published JS inventory');

    const unclassified = published.filter((file) => !isRuntime(file));
    assert.deepStrictEqual(unclassified, [], 'published files not classified as runtime');
  });

  it('an unclassified new root production file counts as runtime', () => {
    for (const file of ['brand-new-entry.js', 'future-runtime.js']) {
      assert.strictEqual(isRuntime(file), true, `${file} should fail closed`);
    }
  });

  it('the previously missing surfaces would have failed before', () => {
    // Guard against someone re-adding a bare allowlist: these two are exactly
    // what the old case statement omitted.
    assert.strictEqual(isRuntime('adapters/github-adapter.js'), true);
    assert.strictEqual(isRuntime('github-app-server.js'), true);
  });

  it('docs and spec changes stay out of the runtime class', () => {
    for (const file of [
      'README.md',
      'docs/architecture.md',
      'specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md',
      'examples/observability-client.js',
    ]) {
      assert.strictEqual(isRuntime(file), false, `${file} must not trigger the runtime suite`);
    }
  });

  it('the dashboard assets are runtime, not decoration', () => {
    // public/* sat in the excluded arm from when it was one self-contained HTML
    // page. It is not decoration: every file under public/ is listed in
    // package.json#files, and the suite asserts on their contents. Removing one
    // attribute from public/index.html -- the aria-label on
    // `<nav class="nav">` -- turns
    // test/observability-dashboard-accessibility-responsive-contract.test.js
    // red, which means a PR touching only that file was having its required
    // npm test check satisfied by the NOT_APPLICABLE skip job.
    for (const file of [
      'public/index.html',
      'public/css/app.css',
      'public/js/app.js',
      'public/viewer/app.mjs',
    ]) {
      assert.strictEqual(isRuntime(file), true, `${file} is a shipped surface with contract tests`);
    }
  });

  it('test files are left to the test classifier', () => {
    // is_test_file() sets runtime_or_test independently; is_runtime_file()
    // returning false here is intentional, not a gap.
    assert.strictEqual(isRuntime('test/graph.test.js'), false);
  });
});
