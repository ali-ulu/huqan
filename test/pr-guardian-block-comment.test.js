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

function response(status, body, extraHeaders = {}) {
  return new Response(body == null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/** A page of ordinary comments, none of them the managed one. */
function filler(count, startId = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: startId + index,
    user: { login: 'someone' },
    body: `ordinary comment ${startId + index}`,
  }));
}

function nextLink(page) {
  return { link: `<https://api.github.test/repos/acme/widgets/issues/42/comments?per_page=100&page=${page}>; rel="next"` };
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

test('a managed comment on a later page is updated, not duplicated', async () => {
  // #1016: the search read one page. A PR with more than 100 issue comments
  // hid the marker behind it, and every block delivery posted another comment
  // -- the opposite of the idempotency this script advertises.
  await withResponseFile({ decision: 'block', policy: { reason: 'force_push_blocked' } }, async responseFile => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response(200, filler(100, 1), nextLink(2));
      if (calls.length === 2) return response(200, filler(100, 101), nextLink(3));
      if (calls.length === 3) {
        return response(200, [
          ...filler(3, 201),
          { id: 7001, user: { login: 'github-actions[bot]' }, body: `old\n${MARKER}` },
        ]);
      }
      return response(200, { id: 7001, body: 'updated' });
    };
    try {
      const result = await run(baseEnv(responseFile));
      assert.equal(result.updated, true);
      assert.equal(result.created, undefined);
      assert.equal(result.commentId, 7001);

      assert.equal(calls.length, 4, 'expected three page reads and one PATCH');
      assert.equal(calls[0].url, 'https://api.github.test/repos/acme/widgets/issues/42/comments?per_page=100');
      assert.equal(calls[1].url, 'https://api.github.test/repos/acme/widgets/issues/42/comments?per_page=100&page=2');
      assert.equal(calls[2].url, 'https://api.github.test/repos/acme/widgets/issues/42/comments?per_page=100&page=3');
      assert.equal(calls[3].options.method, 'PATCH');
      assert.ok(!calls.some(call => call.options?.method === 'POST'), 'a duplicate comment was posted');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('a marker absent from every page creates exactly one comment', async () => {
  await withResponseFile({ decision: 'block', policy: { reason: 'force_push_blocked' } }, async responseFile => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response(200, filler(100, 1), nextLink(2));
      if (calls.length === 2) return response(200, filler(40, 101));
      return response(201, { id: 7002 });
    };
    try {
      const result = await run(baseEnv(responseFile));
      assert.equal(result.created, true);
      assert.equal(result.commentId, 7002);
      assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('a page read that fails leaves the thread untouched rather than duplicating', async () => {
  // The distinction the fix rests on: "not in the pages I could read" is not
  // "not there". Reporting a partial search as absent is what creates the
  // duplicate, so an incomplete search must not reach the POST.
  await withResponseFile({ decision: 'block', policy: { reason: 'force_push_blocked' } }, async responseFile => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response(200, filler(100, 1), nextLink(2));
      return response(502, { message: 'bad gateway' });
    };
    try {
      await assert.rejects(run(baseEnv(responseFile)), error => error.code === 'GITHUB_COMMENT_API_ERROR');
      assert.ok(!calls.some(call => call.options?.method === 'POST'), 'a comment was posted after a failed search');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('pagination is bounded, and exhausting the budget does not post', async () => {
  // A cyclic or endless Link header must not become an unbounded run of
  // authenticated requests, and must not end in a new comment either.
  await withResponseFile({ decision: 'block', policy: { reason: 'force_push_blocked' } }, async responseFile => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return response(200, filler(100, calls.length * 100), nextLink(calls.length + 1));
    };
    try {
      await assert.rejects(
        run(baseEnv(responseFile)),
        error => error.code === 'GITHUB_COMMENTS_PAGINATION_EXHAUSTED',
      );
      assert.equal(calls.length, 20, 'the page budget was not enforced');
      assert.ok(!calls.some(call => call.options?.method === 'POST'));
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('pagination pointing at another host is refused before the token is sent there', async () => {
  await withResponseFile({ decision: 'block', policy: { reason: 'force_push_blocked' } }, async responseFile => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return response(200, filler(100, 1), {
        link: '<https://attacker.example/repos/acme/widgets/issues/42/comments?page=2>; rel="next"',
      });
    };
    try {
      await assert.rejects(
        run(baseEnv(responseFile)),
        error => error.code === 'GITHUB_COMMENTS_PAGINATION_INVALID',
      );
      assert.equal(calls.length, 1, 'a request was sent to the host the response chose');
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
