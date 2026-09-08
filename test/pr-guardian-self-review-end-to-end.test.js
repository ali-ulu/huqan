'use strict';

/**
 * The assertions beside this file read the script's source and its workflow.
 * None of them ran it, so a line that throws on every invocation shipped and was
 * found by the job's first real execution: `readCompatibleEnvironmentVariable`
 * rejects a suffix that is not registered, and `WORKSPACE_ID` is not.
 *
 * This runs the script the way the workflow does -- as a child process, over a
 * pull_request event, against an API it actually calls -- so the whole path is
 * exercised rather than described. The API is a local server, so there is no
 * network and no token.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
// Async on purpose: the fixture API is served by this same process, so a
// synchronous child would block the event loop that has to answer its fetch.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pr-guardian-self-review.js');

function withFilesApi(files, run) {
  const server = http.createServer((request, response) => {
    // The script pages until a short page comes back; one short page is enough.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(files));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await run(`http://127.0.0.1:${server.address().port}`));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

async function runScript({ api, event, expectFailure = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-guardian-'));
  const eventPath = path.join(dir, 'event.json');
  const summaryPath = path.join(dir, 'summary.md');
  fs.writeFileSync(eventPath, JSON.stringify(event));
  fs.writeFileSync(summaryPath, '');
  const options = {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_TOKEN: 'test-token',
      GITHUB_API_URL: api,
      GITHUB_REPOSITORY: 'ali-ulu/huqan',
      GITHUB_STEP_SUMMARY: summaryPath,
    },
  };
  try {
    const { stdout } = await run(process.execPath, [SCRIPT], options);
    assert.equal(expectFailure, false, 'expected a non-zero exit');
    return { stdout, summary: fs.readFileSync(summaryPath, 'utf8') };
  } catch (error) {
    assert.equal(expectFailure, true, `unexpected failure: ${error.stdout || error.message}`);
    return { stdout: error.stdout || '', summary: fs.readFileSync(summaryPath, 'utf8') };
  }
}

const event = (patch = {}) => ({
  repository: { full_name: 'ali-ulu/huqan' },
  pull_request: {
    number: 1,
    title: 'docs: a change',
    body: 'body',
    base: { ref: 'main', sha: 'b'.repeat(40) },
    head: { ref: 'topic', sha: 'a'.repeat(40) },
    ...patch,
  },
});

test('an ordinary change is allowed and the job passes', async () => {
  const { stdout, summary } = await withFilesApi(
    [{ filename: 'public/js/app.js', patch: '+const greeting = "hello";' }],
    api => runScript({ api, event: event() }),
  );
  assert.match(stdout, /\*\*Decision:\*\* `allow`/);
  assert.match(stdout, /::notice title=HUQAN PR Guardian::/);
  // The summary is what a reader sees on the run page, so it has to be written.
  assert.match(summary, /HUQAN PR Guardian/);
});

test('a workflow change is reported without failing the check', async () => {
  const { stdout } = await withFilesApi(
    [{ filename: '.github/workflows/publish.yml', patch: '+          echo hi' }],
    api => runScript({ api, event: event() }),
  );
  assert.match(stdout, /\*\*Decision:\*\* `review`/);
  assert.match(stdout, /ci_workflow_change/);
  assert.match(stdout, /::warning title=HUQAN PR Guardian/);
});

test('an announced force-push fails the check', async () => {
  const { stdout } = await withFilesApi(
    [{ filename: 'README.md', patch: '+text' }],
    api => runScript({
      api,
      event: event({ body: 'I will force-push over main.' }),
      expectFailure: true,
    }),
  );
  assert.match(stdout, /::error title=HUQAN PR Guardian blocked this change::/);
});

test('an API that will not answer fails closed', async () => {
  // An unreadable diff is not evidence of a safe diff.
  const { stdout } = await runScript({
    api: 'http://127.0.0.1:1',
    event: event(),
    expectFailure: true,
  });
  assert.match(stdout, /could not evaluate this change/);
});

test('no HUQAN_ configuration is read, registered or otherwise', () => {
  // The bug this file exists for: an unregistered suffix throws on every run,
  // and nothing that only reads the source would notice.
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /readCompatibleEnvironmentVariable\(/);
  assert.doesNotMatch(source, /process\.env\.(HUQAN|AXIOM)_/);
});
