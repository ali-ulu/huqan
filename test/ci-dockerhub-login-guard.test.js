const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/benchmark.yml'), 'utf8');
const step = workflow.match(/      - name: Log in to Docker Hub\n(?:        .*\n)*?        run: \|\n((?:          .*\n)+)/);
assert.ok(step, 'the Docker Hub login step must exist');
const script = step[1].replace(/^ {10}/gm, '');

// Credentials only apply to a build that runs after the login, so the step
// order is part of the fix, not an incidental layout detail.
const loginIndex = workflow.indexOf('name: Log in to Docker Hub');
const buildIndex = workflow.indexOf('name: Build Docker image');
assert.ok(loginIndex !== -1 && buildIndex !== -1 && loginIndex < buildIndex, 'login must precede the build');

function runLogin(t, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-dockerhub-login-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Run the workflow's actual shell with a docker stub that records the call
  // and the token it receives on stdin. No network, no wall-clock delay.
  const harness = `
docker() {
  printf '%s\\n' "$*" >> "$TEST_DIR/calls"
  if [ "$1" = "login" ]; then cat >> "$TEST_DIR/stdin"; fi
  return 0
}
${script}`;
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', harness], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, TEST_DIR: dir, TMPDIR: dir, ...env },
  });
  assert.ifError(result.error);
  const calls = fs.existsSync(path.join(dir, 'calls'))
    ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : [];
  const stdin = fs.existsSync(path.join(dir, 'stdin'))
    ? fs.readFileSync(path.join(dir, 'stdin'), 'utf8') : '';
  return { ...result, calls, stdin };
}

describe('Docker build authenticates to Docker Hub when credentials exist (#3749 follow-up)', {
  skip: spawnSync('bash', ['-c', 'printf bash-ok'], { encoding: 'utf8' }).stdout !== 'bash-ok'
    ? 'requires a usable POSIX bash' : false,
}, () => {
  it('authenticates with the provided credentials and pipes the token on stdin', t => {
    const result = runLogin(t, { DOCKERHUB_USERNAME: 'ci-bot', DOCKERHUB_TOKEN: 's3cr3t-token' });
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, ['login -u ci-bot --password-stdin']);
    assert.equal(result.stdin, 's3cr3t-token');
    assert.doesNotMatch(result.stdout, /::warning::/);
  });

  it('stays anonymous and warns when neither secret is configured', t => {
    const result = runLogin(t, { DOCKERHUB_USERNAME: '', DOCKERHUB_TOKEN: '' });
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.stdout, /::warning::/);
  });

  it('stays anonymous when only the username is present', t => {
    const result = runLogin(t, { DOCKERHUB_USERNAME: 'ci-bot', DOCKERHUB_TOKEN: '' });
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.stdout, /::warning::/);
  });

  it('stays anonymous when only the token is present', t => {
    const result = runLogin(t, { DOCKERHUB_USERNAME: '', DOCKERHUB_TOKEN: 's3cr3t-token' });
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.stdout, /::warning::/);
  });
});
