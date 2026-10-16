'use strict';

/**
 * #1969. Every risk pattern used to read one haystack built from the title,
 * body, branch names, filenames and patches together. The two that name a kind
 * of file rather than a kind of plan therefore fired on prose.
 *
 * Measured against the five pull requests merged into this repository on
 * 2026-09-08, three came back `secret_or_credential_change` and two of those
 * touched no credential: #1959 adds a source scanner and says "tokenise"
 * throughout, and #1960 ships a viewer page whose own copy reads "without
 * exposing operator credentials". A gate wrong two times in three is one nobody
 * reads, so the text below is the real text those pull requests carried.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePullRequest, DECISIONS, ACTIONS } = require('../lib/pr-guardian/policy');

const snapshot = (patch = {}) => ({
  repo: 'ali-ulu/huqan',
  headSha: 'a'.repeat(40),
  workspaceId: 'default',
  title: '',
  body: '',
  baseRef: 'main',
  headRef: 'topic',
  files: [],
  checks: [],
  ...patch,
});

const verdict = patch => evaluatePullRequest(snapshot(patch), { action: ACTIONS.READ_SNAPSHOT });

test('prose that merely says "token" or "credentials" is not a secret change', () => {
  // #1959, verbatim.
  const scanner = verdict({
    title: 'fix(ui): close the last unkeyed dashboard copy',
    body: 'It tokenises now — strings, template holes, comments and regex literals.',
    files: [{ filename: 'test/helpers/unkeyed-copy.js', patch: '+function stringLiterals(source) {' }],
  });
  assert.ok(!scanner.riskLabels.includes('secret-change'), JSON.stringify(scanner.riskLabels));

  // #1960, verbatim: the phrase is the viewer's own page copy.
  const viewer = verdict({
    title: 'fix(ui): wire the receipt viewer',
    body: 'Inspect one canonical trust receipt without exposing operator credentials.',
    files: [{ filename: 'public/viewer/index.html', patch: '+<p class="lede">Inspect one canonical trust receipt without exposing operator credentials.</p>' }],
  });
  assert.ok(!viewer.riskLabels.includes('secret-change'), JSON.stringify(viewer.riskLabels));
});

test('"schema" in ordinary writing is not a database migration', () => {
  // This repository writes the word constantly: schema.org markup on its pages,
  // JSON schemas in specs/.
  const seo = verdict({
    title: 'fix(seo): repair the Turkish FAQ schema',
    body: 'Soru is not a schema.org type, so that page FAQPage block was invalid.',
    files: [{ filename: 'public/index.html', patch: '+<script type="application/ld+json">' }],
  });
  assert.ok(!seo.riskLabels.includes('migration'), JSON.stringify(seo.riskLabels));
});

test('a credential-bearing path is still a secret change', () => {
  for (const filename of ['.env', 'config/.env.production', 'deploy/secrets/prod.key', 'certs/server.pem', 'ops/credentials/aws.json', 'home/.npmrc']) {
    const result = verdict({ files: [{ filename, patch: '' }] });
    assert.ok(result.riskLabels.includes('secret-change'), `${filename} should be a secret change`);
    assert.equal(result.decision, DECISIONS.REVIEW, filename);
  }
});

test('a credential written into an ordinary file is still a secret change', () => {
  const result = verdict({ files: [{ filename: 'src/client.js', patch: '@@\n context line\n+const apiKey = "live_abc123";' }] });
  assert.equal(result.reason, 'secret_or_credential_change');
});

test('reading a credential from somewhere else is not writing one', () => {
  // The common shape of *fixing* a hardcoded secret. Flagging it rewards
  // leaving the literal in place.
  for (const patch of [
    '+const token = process.env.HUQAN_TOKEN;',
    '+const apiKey = config.apiKey;',
    "+  password: secrets.DB_PASSWORD",
    '+const accessKey = readFromEnv();',
  ]) {
    const result = verdict({ files: [{ filename: 'src/client.js', patch }] });
    assert.ok(!result.riskLabels.includes('secret-change'), patch);
  }
});

test('a removed credential is not a new one', () => {
  // The whole point of deleting a hardcoded key is that it is gone; flagging the
  // cleanup teaches people to stop reading the gate.
  const result = verdict({ files: [{ filename: 'src/client.js', patch: '@@\n-const apiKey = "live_abc123";\n+const apiKey = readFromEnv();' }] });
  assert.ok(!result.riskLabels.includes('secret-change'), JSON.stringify(result.riskLabels));
});

test('migrations are recognised by file and by statement, not by vocabulary', () => {
  assert.ok(verdict({ files: [{ filename: 'db/migrations/003_add_index.sql', patch: '' }] }).riskLabels.includes('migration'));
  assert.ok(verdict({ files: [{ filename: 'src/store.js', patch: '+await db.exec("ALTER TABLE receipts ADD COLUMN sealed_at");' }] }).riskLabels.includes('migration'));
});

test('a CI workflow change is named directly', () => {
  // Narrowing secret-change to credential paths removed the one flag on this
  // repository that deserved review: a workflow holds the repository secrets and
  // runs whatever it says, so the surface is named rather than inferred.
  const result = verdict({ files: [{ filename: '.github/workflows/publish.yml', patch: '+          log="${RUNNER_TEMP}/npm-publish.log"' }] });
  assert.equal(result.decision, DECISIONS.REVIEW);
  assert.equal(result.reason, 'ci_workflow_change');
  assert.ok(result.riskLabels.includes('ci-workflow-change'));
});

test('an announced force-push still blocks with no diff at all', () => {
  // Intent-scoped patterns must keep reading the intent: there may be nothing in
  // the change that corroborates what the author says they are about to do.
  const result = verdict({ body: 'Please force-push the history rewrite.', files: [] });
  assert.equal(result.decision, DECISIONS.BLOCK);
  assert.equal(result.reason, 'history_rewrite_or_force_push');
});
