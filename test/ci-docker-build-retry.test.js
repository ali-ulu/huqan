const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/benchmark.yml'), 'utf8');
const step = workflow.match(/      - name: Build Docker image\n        run: \|\n((?:          .*\n)+)/);
assert.ok(step, 'the Docker build step must exist');
const script = step[1].replace(/^ {10}/gm, '');
const timeout = 'ERROR: failed to fetch oauth token: unexpected status from POST request to https://auth.docker.io/token: 504 Gateway Timeout: error code: 504';

function runBuild(t, failures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-docker-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  failures.forEach((failure, index) => fs.writeFileSync(path.join(dir, `failure-${index + 1}`), failure));
  // Run the workflow's actual shell with controlled Docker responses and no
  // wall-clock delay. The counter is a file so subshells cannot reset it.
  const harness = `
docker() {
  printf '%s\\n' "$*" >> "$TEST_DIR/calls"
  count=$(wc -l < "$TEST_DIR/calls")
  if [ -f "$TEST_DIR/failure-$count" ]; then
    cat "$TEST_DIR/failure-$count" >&2
    return 17
  fi
  echo 'image built'
}
sleep() { printf '%s\\n' "$1" >> "$TEST_DIR/sleeps"; }
${script}`;
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', harness], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, TEST_DIR: dir, TMPDIR: dir },
  });
  assert.ifError(result.error);
  const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
  calls.forEach(call => assert.equal(call, 'build --progress=plain -t huqan:test .'));
  const sleeps = fs.existsSync(path.join(dir, 'sleeps'))
    ? fs.readFileSync(path.join(dir, 'sleeps'), 'utf8').trim().split('\n') : [];
  assert.equal(fs.readdirSync(dir).some(file => file.startsWith('tmp.')), false, 'temporary build log is cleaned up');
  return { ...result, attempts: calls.length, sleeps };
}

describe('Docker build retries transient registry token outages (#3749)', {
  skip: spawnSync('bash', ['-c', 'printf bash-ok'], { encoding: 'utf8' }).stdout !== 'bash-ok'
    ? 'requires a usable POSIX bash' : false,
}, () => {
  it('builds once without delay on success', t => {
    const result = runBuild(t, []);
    assert.equal(result.status, 0);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.sleeps, []);
  });

  it('recovers from the reported Docker Hub 504 with bounded backoff', t => {
    const result = runBuild(t, [timeout, timeout]);
    assert.equal(result.status, 0);
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.sleeps, ['15', '30']);
    assert.ok(result.stdout.includes(timeout));
    assert.match(result.stdout, /image built/);
  });

  it('preserves failure after three unsuccessful attempts', t => {
    const result = runBuild(t, [timeout, timeout, timeout]);
    assert.equal(result.status, 17);
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.sleeps, ['15', '30']);
  });

  it('also recovers from token-service 502 and 503 responses', t => {
    const result = runBuild(t, [
      'failed to fetch anonymous token: unexpected status: 502 Bad Gateway',
      'failed to fetch oauth token: unexpected status: 503 Service Unavailable',
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.attempts, 3);
  });

  for (const failure of [
    'ERROR: process npm ci did not complete successfully: exit code: 1',
    'failed to fetch oauth token: unexpected status: 401 Unauthorized',
    'RUN npm test failed: 504 Gateway Timeout',
  ]) {
    it(`does not retry a non-transient build failure: ${failure}`, t => {
      const result = runBuild(t, [failure]);
      assert.equal(result.status, 17);
      assert.equal(result.attempts, 1);
      assert.deepEqual(result.sleeps, []);
    });
  }

  it('does not let a previous transient log cause a permanent error to retry', t => {
    const result = runBuild(t, [timeout, 'ERROR: Dockerfile syntax error']);
    assert.equal(result.status, 17);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.sleeps, ['15']);
    assert.match(result.stdout, /Dockerfile syntax error/);
  });
});
