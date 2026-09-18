'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'release-distribution.yml'),
  'utf8',
);

test('release distribution only follows the canonical npm publish workflow', () => {
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /- Publish to npm/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
});

test('distribution is pinned to the exact upstream published commit', () => {
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /git rev-list -n 1/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /tag_sha.*SOURCE_SHA/);
});

test('container is tested before any GHCR push', () => {
  const smoke = workflow.indexOf('- name: Smoke-test release image before registry write');
  const push = workflow.indexOf('- name: Push tested image');
  assert.ok(smoke > -1 && push > smoke);
  assert.match(workflow, /curl --fail --silent --show-error http:\/\/127\.0\.0\.1:18080\/health/);
  assert.match(workflow, /test "\$\(id -u\)" -ne 0/);
});

test('GHCR authority uses short-lived GitHub credentials and attests the digest', () => {
  assert.match(workflow, /^\s*packages:\s*write\s*$/m);
  assert.match(workflow, /^\s*attestations:\s*write\s*$/m);
  assert.match(workflow, /secrets\.GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /GHCR_TOKEN\s*[:=]\s*['"][A-Za-z0-9_-]{20,}/);
  assert.match(workflow, /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/);
  assert.match(workflow, /push-to-registry:\s*true/);
  assert.match(workflow, /create-storage-record:\s*false/);
});

test('GitHub Release is downstream of container publication and carries the SBOM', () => {
  assert.match(workflow, /github-release:/);
  assert.match(workflow, /- container/);
  assert.match(workflow, /gh run download/);
  assert.match(workflow, /--name sbom-cyclonedx/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--generate-notes/);
});
