'use strict';

/**
 * #3032: GitHub PR webhook -> repo-memory ingest pipeline.
 *
 * Locks the three wired links end to end (without touching the network):
 *
 *   1. webhook binding -> approval submission (`buildRepoIngestSubmission`);
 *   2. approval execution -> `repoMemory` capability with a canonical
 *      allow/review/reject admission (`toCanonicalIngestAdmission`);
 *   3. capability execution pins the fetch to the approved commit
 *      (`repo-memory-github` prefers `commitSha`).
 *
 * Plus the boundary seam: a configured `queueIngest` callback reports
 * queueing in the webhook response, and a queue failure never fails the
 * observation itself.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildRepoIngestSubmission,
} = require('../lib/github-app-beta-handler');
const {
  createGitHubAppBetaHttpBoundary,
} = require('../lib/github-app-beta-http-boundary');
const {
  createGitHubAppBetaServer,
} = require('../github-app-server');
const {
  buildIngestApprovalSnapshot,
  handleIngest,
  toCanonicalIngestAdmission,
} = require('../lib/ingest');

const SHA = 'b'.repeat(40);
const BINDING = Object.freeze({
  deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  event: 'pull_request',
  repositoryId: 1300995136,
  repositoryFullName: 'ali-ulu/huqan',
  installationId: 991,
  pullRequestNumber: 279,
  headSha: SHA,
  payloadSha256: '0'.repeat(64),
  reservedAt: '2026-09-30T00:00:00.000Z',
});

test('buildRepoIngestSubmission derives a pinned, idempotent submission', () => {
  const submission = buildRepoIngestSubmission(BINDING);
  assert.strictEqual(submission.sourceType, 'github');
  assert.strictEqual(submission.repoUrl, 'https://github.com/ali-ulu/huqan');
  assert.strictEqual(submission.commitSha, SHA);
  assert.strictEqual(submission.workspaceId, 'default');
  assert.match(submission.idempotencyKey, new RegExp(SHA));
  // Frozen: the boundary must not be able to mutate the queued intent.
  assert.ok(Object.isFrozen(submission));
});

test('buildRepoIngestSubmission fails closed on malformed bindings', () => {
  assert.throws(
    () => buildRepoIngestSubmission({ ...BINDING, repositoryFullName: 'not-a-repo' }),
    (error) => error.code === 'GITHUB_APP_INVALID_PAYLOAD',
  );
  assert.throws(
    () => buildRepoIngestSubmission({ ...BINDING, headSha: 'main' }),
    (error) => error.code === 'GITHUB_APP_INVALID_PAYLOAD',
  );
  assert.throws(
    () => buildRepoIngestSubmission({ ...BINDING, pullRequestNumber: 0 }),
    (error) => error.code === 'GITHUB_APP_INVALID_PAYLOAD',
  );
});

test('the submission queues through the approval snapshot gate', () => {
  const snapshot = buildIngestApprovalSnapshot(buildRepoIngestSubmission(BINDING));
  assert.strictEqual(snapshot.ok, true);
  assert.strictEqual(snapshot.sourceType, 'github');
  assert.strictEqual(snapshot.payload.commitSha, SHA);
  assert.strictEqual(snapshot.payload.repoUrl, 'https://github.com/ali-ulu/huqan');
});

test('toCanonicalIngestAdmission maps the connector vocabulary without upgrading unknowns', () => {
  const entries = [
    { workspaceId: 'default', receiptId: 'r1', auditId: '', graphWrite: true },
  ];
  assert.strictEqual(toCanonicalIngestAdmission({ outcome: 'admitted', entries }).outcome, 'allow');
  assert.strictEqual(toCanonicalIngestAdmission({ outcome: 'admitted', entries }).graphWrite, true);
  assert.strictEqual(toCanonicalIngestAdmission({ outcome: 'skipped', entries: [] }).outcome, 'allow');
  assert.strictEqual(toCanonicalIngestAdmission({ outcome: 'skipped', entries: [] }).graphWrite, false);
  assert.strictEqual(toCanonicalIngestAdmission({ outcome: 'candidate', entries }).outcome, 'review');
  assert.strictEqual(toCanonicalIngestAdmission({ outcome: 'rejected', entries }).outcome, 'reject');
  // Fail-closed: an outcome nobody defined stays unrecognized downstream.
  assert.strictEqual(toCanonicalIngestAdmission({ outcome: 'mystery', entries }).outcome, 'mystery');
  assert.strictEqual(toCanonicalIngestAdmission(null), null);
  assert.strictEqual(toCanonicalIngestAdmission('admitted'), 'admitted');
});

test('handleIngest executes pinned github through repoMemory with a canonical admission', async () => {
  const seen = [];
  const kernel = {
    async runCapability(name, payload) {
      seen.push({ name, payload });
      return {
        ok: true,
        sourceType: 'repo',
        added: 2,
        admission: {
          outcome: 'admitted',
          counts: { admitted: 2 },
          total: 2,
          entries: [{ workspaceId: 'default', receiptId: 'r1', auditId: '', graphWrite: true }],
        },
      };
    },
  };
  const result = await handleIngest({
    kernel,
    data: {
      sourceType: 'github',
      repoUrl: 'https://github.com/ali-ulu/huqan',
      commitSha: SHA,
      branch: 'main',
    },
    ensureRuntime: () => {},
  });
  assert.strictEqual(seen[0].name, 'repoMemory');
  assert.strictEqual(seen[0].payload.commitSha, SHA);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.admission.outcome, 'allow');
  assert.strictEqual(result.admission.graphWrite, true);
  assert.strictEqual(result.ingestMeta.sourceType, 'github');
  assert.match(result.ingestMeta.sourceRef, new RegExp(SHA));
});

test('repo-memory-github prefers the approved commit SHA as the fetch ref', async () => {
  const { ingestGithubRepo } = require('../lib/connectors/repo-memory-github');
  const { pinnedRepoFile } = require('../lib/repo-file-pin');
  const captured = [];
  const file = {
    path: 'README.md',
    content: '# Title\n\nBody.\n',
    commitSha: SHA,
    lastModified: '2026-09-30T00:00:00.000Z',
  };
  const kernel = {
    proposeNode: () => ({ decision: 'allow', node: { id: 'n' }, admission: { receiptId: 'r' } }),
    proposeEdge: () => ({ decision: 'allow', edge: { id: 'e' }, admission: { receiptId: 'r' } }),
  };
  const stubFetch = async (repoUrl, opts) => {
    captured.push({ repoUrl, branch: opts.branch });
    return [file];
  };
  const result = await ingestGithubRepo(kernel, {
    repoUrl: 'https://github.com/ali-ulu/huqan',
    branch: 'main',
    commitSha: SHA,
    workspaceId: 'default',
  }, {
    fetchRepoFiles: stubFetch,
    parseRepoUrl: () => ({ owner: 'ali-ulu', repo: 'huqan' }),
    isMarkdownPath: () => false,
    parseMarkdown: () => [],
    pinnedRepoFile,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(captured[0].branch, SHA);
  const fileRecord = result.admissions.find((entry) => entry.targetId === `repo:ali-ulu/huqan@${SHA}:README.md`);
  assert.ok(fileRecord, 'the file admission must pin the approved commit');
  assert.match(fileRecord.sourceRef, new RegExp(SHA));
});

test('repo-memory-github resolves its token through the environment-compat shim (#3429)', async () => {
  const { ingestGithubRepo } = require('../lib/connectors/repo-memory-github');
  const { pinnedRepoFile } = require('../lib/repo-file-pin');

  const capturedToken = async (environment, extraInput = {}) => {
    const captured = [];
    const kernel = {
      proposeNode: () => ({ decision: 'allow', node: { id: 'n' }, admission: { receiptId: 'r' } }),
      proposeEdge: () => ({ decision: 'allow', edge: { id: 'e' }, admission: { receiptId: 'r' } }),
    };
    const stubFetch = async (repoUrl, opts) => {
      captured.push(opts.token);
      return [];
    };
    await ingestGithubRepo(kernel, {
      repoUrl: 'https://github.com/ali-ulu/huqan',
      workspaceId: 'default',
      environment,
      ...extraInput,
    }, {
      fetchRepoFiles: stubFetch,
      parseRepoUrl: () => ({ owner: 'ali-ulu', repo: 'huqan' }),
      isMarkdownPath: () => false,
      parseMarkdown: () => [],
      pinnedRepoFile,
    });
    return captured[0];
  };

  assert.equal(await capturedToken({ HUQAN_GITHUB_TOKEN: 'canonical-token' }), 'canonical-token');
  assert.equal(await capturedToken({ AXIOM_GITHUB_TOKEN: 'legacy-token' }), 'legacy-token');
  assert.equal(
    await capturedToken({ HUQAN_GITHUB_TOKEN: 'same', AXIOM_GITHUB_TOKEN: 'same' }),
    'same',
  );
  assert.equal(await capturedToken({}, { token: 'caller-token' }), 'caller-token');
  await assert.rejects(
    () => capturedToken({ HUQAN_GITHUB_TOKEN: 'canonical', AXIOM_GITHUB_TOKEN: 'legacy' }),
    (error) => error.code === 'HUQAN_ENV_CONFLICT',
  );
});

const SECRET = 'github-pr-ingest-pipeline-secret';
const DELIVERY = '83e4273f-dd89-22f4-92bc-5da478ed1069';

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-pr-ingest-pipe-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function pullRequestPayload() {
  return {
    action: 'opened',
    number: 279,
    installation: { id: 991 },
    repository: { id: 1300995136, full_name: 'ali-ulu/huqan' },
    pull_request: { number: 279, head: { sha: SHA } },
  };
}

function signature(body) {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

async function listen(t, boundary) {
  const server = createGitHubAppBetaServer({ boundary });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/github-app/webhook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

function environment(root) {
  return {
    HUQAN_GITHUB_APP_BETA_ENABLED: '1',
    HUQAN_GITHUB_APP_WEBHOOK_SECRET: SECRET,
    HUQAN_GITHUB_APP_STORE_PATH: root,
  };
}

test('webhook with a queueIngest callback reports the queued approval', async (t) => {
  const root = tempRoot(t);
  const submissions = [];
  const boundary = createGitHubAppBetaHttpBoundary({
    environment: environment(root),
    queueIngest: async (submission) => {
      submissions.push(submission);
      return {
        status: 202,
        json: { ok: true, status: 'pending', idempotent: false, approval: { id: 'approval-1' } },
      };
    },
  });
  const port = await listen(t, boundary);
  const body = Buffer.from(JSON.stringify(pullRequestPayload()), 'utf8');
  const result = await post(port, body, {
    'x-github-event': 'pull_request',
    'x-github-delivery': DELIVERY,
    'x-hub-signature-256': signature(body),
  });
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.ok, true);
  assert.strictEqual(submissions.length, 1);
  assert.strictEqual(submissions[0].commitSha, SHA);
  assert.strictEqual(result.body.ingest.queued, true);
  assert.strictEqual(result.body.ingest.status, 202);
});

test('a queue failure never fails the observation', async (t) => {
  const root = tempRoot(t);
  const boundary = createGitHubAppBetaHttpBoundary({
    environment: environment(root),
    queueIngest: async () => ({ status: 503, error: { code: 'APPROVAL_STORE_UNAVAILABLE' } }),
  });
  const port = await listen(t, boundary);
  const body = Buffer.from(JSON.stringify(pullRequestPayload()), 'utf8');
  const result = await post(port, body, {
    'x-github-event': 'pull_request',
    'x-github-delivery': DELIVERY,
    'x-hub-signature-256': signature(body),
  });
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.ok, true);
  assert.strictEqual(result.body.ingest.queued, false);
});

test('without queueIngest the response shape is unchanged', async (t) => {
  const root = tempRoot(t);
  const boundary = createGitHubAppBetaHttpBoundary({ environment: environment(root) });
  const port = await listen(t, boundary);
  const body = Buffer.from(JSON.stringify(pullRequestPayload()), 'utf8');
  const result = await post(port, body, {
    'x-github-event': 'pull_request',
    'x-github-delivery': DELIVERY,
    'x-hub-signature-256': signature(body),
  });
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.ok, true);
  assert.strictEqual('ingest' in result.body, false);
});
