'use strict';

/**
 * coder must fail closed when the repository state cannot be read (#4042).
 *
 * `readRepoState` answers `known: false` on purpose when git is unavailable or
 * the queried directory is not the repository root (#2992): "nobody checked" is
 * not "clean". That answer used to be dropped on the way to the gate (the CLI
 * projected branch/dirty/hasUntracked and left `known` behind, and
 * `normalizeRepoState` dropped what remained), so the gate saw an empty branch
 * plus `dirty: false` and read the gap as a clean non-main tree. A write-like
 * change then proceeded -- or was released by `--authorize`.
 *
 * These tests drive the real CLI in a child process, because the defect lives
 * in that boundary and not in the gate alone. Each refusal is held to three
 * things at once: the run is refused, no target file changed, and the declared
 * test command never ran (its marker file proves the verifier was not reached).
 * A readable clean feature branch runs the same task end to end as the control.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'cli.js');
const NOTES = 'release notes: v1.0.0 shipped\n';
const MARKER = 'accept-ran.txt';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeBase() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coder-unknown-repo-')));
}

// The marker write is the observable proof that the declared test ran. `node
// accept.js` is spawned without a shell (lib/coder/test-execution.js), with the
// repository root as cwd.
function writeFixture(base) {
  fs.mkdirSync(path.join(base, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(base, 'docs', 'notes.md'), NOTES, 'utf8');
  fs.writeFileSync(path.join(base, 'accept.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(MARKER)}, 'ran\\n');\n`, 'utf8');
}

function writeTaskFile(base, name = 'task.json') {
  const file = path.join(base, name);
  fs.writeFileSync(file, JSON.stringify({
    id: 'task-repostate-unknown',
    level: 'l0',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
    test: { command: 'node accept.js', timeoutMs: 30000 },
  }, null, 2), 'utf8');
  return file;
}

function runCoder(base, { taskFile, extra = [] }) {
  const child = childProcess.spawnSync(process.execPath, [CLI, 'coder', taskFile, '--root', base, ...extra, '--json'], {
    cwd: base,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(base, '..', `${path.basename(base)}-state`) },
  });
  return { child, result: child.stdout ? JSON.parse(child.stdout) : null };
}

describe('coder fails closed when the repository state cannot be read (#4042)', () => {
  it('refuses a write-like task, writes nothing and never reaches the declared test', () => {
    const base = makeBase();
    writeFixture(base);
    const taskFile = writeTaskFile(base);
    const before = sha256(path.join(base, 'docs', 'notes.md'));

    const { child, result } = runCoder(base, { taskFile });

    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 6, JSON.stringify(result));
    assert.equal(result.status, 'blocked');
    assert.equal(result.data.repoStateKnown, false);
    // The gate refused the write; the failure is carried back as the gate's own
    // reason, not as a generic loop exhaustion.
    assert.equal(result.data.attempts[0].apply.ok, false);
    assert.equal(result.data.attempts[0].apply.reason, 'GATE_REFUSED');
    assert.equal(result.data.attempts[0].apply.detail, 'REPO_STATE_UNKNOWN_BLOCKED');
    // No test record at all: the verifier was never reached, so the command was
    // never spawned and the marker cannot exist.
    assert.equal(result.data.attempts[0].test, null);
    assert.equal(fs.existsSync(path.join(base, MARKER)), false);
    assert.equal(sha256(path.join(base, 'docs', 'notes.md')), before);
  });

  it('refuses the same task under --authorize, which may not release the block', () => {
    const base = makeBase();
    writeFixture(base);
    const taskFile = writeTaskFile(base);
    const before = sha256(path.join(base, 'docs', 'notes.md'));

    const { child, result } = runCoder(base, { taskFile, extra: ['--authorize'] });

    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 6, JSON.stringify(result));
    assert.equal(result.data.attempts[0].apply.reason, 'GATE_REFUSED');
    assert.equal(result.data.attempts[0].apply.detail, 'REPO_STATE_UNKNOWN_BLOCKED');
    assert.equal(fs.existsSync(path.join(base, MARKER)), false);
    assert.equal(sha256(path.join(base, 'docs', 'notes.md')), before);
  });

  it('applies the same task on a readable clean feature branch', () => {
    const base = makeBase();
    writeFixture(base);
    const taskFile = writeTaskFile(base);
    const git = args => childProcess.execFileSync('git', args, {
      cwd: base, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    git(['init', '-b', 'fix/coder-unknown-repo']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', 'docs/notes.md', 'accept.js']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);

    const { child, result } = runCoder(base, { taskFile });

    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 0, JSON.stringify(result));
    assert.equal(result.data.repoStateKnown, true);
    assert.equal(result.data.attempts[0].test.exitCode, 0);
    assert.equal(fs.existsSync(path.join(base, MARKER)), true);
    assert.match(fs.readFileSync(path.join(base, 'docs', 'notes.md'), 'utf8'), /v1\.1\.0/);
  });
});
