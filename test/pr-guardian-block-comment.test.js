'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MARKER, buildComment, run } = require('../scripts/comment-pr-guardian-block');

async function withResponseFile(response, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huqan-pr-block-'));
  const responseFile = path.join(directory, 'response.json');
  await fs.writeFile(responseFile, JSON.stringify(response), { mode: 0o600 });
  try {
    return await callback(responseFile);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function response(status, body) {
  return new Response(body == null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseEnv(responseFile) {
  return {
    PR_GUARDIAN_RESPONSE_FILE: responseFile,
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_API_URL: 'https://api.github.test',
    PR_NUMBER: '42',
    PR_HEAD_SHA: '0123456789abcdef0123456789abcdef01234567',
    PR_GUARDIAN_RUN_URL: 'https://github.com/acme/widgets/actions/runs/99',
    PR_GUARDIAN_ACTION: 'github.pr.guardian',
  };
}

test('allow response is a no-op and never calls GitHub', async () => {
  await withResponseFile({ decision: 'allow' }, async responseFile => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (...args) => {
      calls.push(args);
      return response(500, { error: 'must not be called' });
    };
    try {
      const result = await run(baseEnv(responseFile));
      assert.deepEqual(result, { ok: true, commented: false, decision: 'allow' });
      assert.equal(calls.length, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('block response creates one managed PR comment', async () => {
  await withResponseFile({
    decision: 'block',
    reason: 'ab5_automation_safety_gate_blocked',
    policy: { riskLabels: ['force-push'] },
  }, async responseFile => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? response(200, [])
        : response(201, { id: 7001, html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-7001' });
    };
    try {
      const result = await run(baseEnv(responseFile));
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      assert.equal(result.commentId, 7001);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, 'https://api.github.test/repos/acme/widgets/issues/42/comments?per_page=100');
      assert.equal(calls[1].url, 'https://api.github.test/repos/acme/widgets/issues/42/comments');
      assert.equal(calls[1].options.method, 'POST');
      const payload = JSON.parse(calls[1].options.body);
      assert.match(payload.body, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(payload.body, /ab5\\_automation\\_safety\\_gate\\_blocked/);
      assert.match(payload.body, /0123456789abcdef0123456789abcdef01234567/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('duplicate managed comment is updated instead of duplicated', async () => {
  await withResponseFile({ decision: 'block', policy: { reason: 'force_push_blocked' } }, async responseFile => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? response(200, [{ id: 7001, user: { login: 'github-actions[bot]' }, body: `old\n${MARKER}` }])
        : response(200, { id: 7001, body: 'updated' });
    };
    try {
      const result = await run(baseEnv(responseFile));
      assert.equal(result.ok, true);
      assert.equal(result.updated, true);
      assert.equal(result.created, undefined);
      assert.equal(result.commentId, 7001);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, 'https://api.github.test/repos/acme/widgets/issues/comments/7001');
      assert.equal(calls[1].options.method, 'PATCH');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('missing token fails closed before any GitHub request', async () => {
  await withResponseFile({ decision: 'block' }, async responseFile => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return response(200, []);
    };
    try {
      await assert.rejects(
        run({ ...baseEnv(responseFile), GITHUB_TOKEN: '' }),
        error => error.code === 'GITHUB_TOKEN_REQUIRED',
      );
      assert.equal(calls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('comment body carries the stable marker and no-mutation warning', () => {
  const body = buildComment({
    response: { decision: 'block', reason: 'production deploy blocked' },
    repo: 'acme/widgets',
    number: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    runUrl: 'https://github.com/acme/widgets/actions/runs/99',
    action: 'github.pr.guardian',
  });
  assert.match(body, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(body, /No merge, deploy, force-push, or other external mutation was authorized/);
  assert.match(body, /production deploy blocked/);
});
