'use strict';

// #3198 follow-up: the OCR reviewer runs in CI once an LLM endpoint is set as
// repository secrets, and its SARIF reaches Code Scanning. The provider stays
// undecided: the job reads OpenCodeReview's own provider-neutral variables
// (OCR_LLM_URL / TOKEN / MODEL / PROTOCOL), so choosing one is setting secrets.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const WORKFLOWS = path.join(__dirname, '..', '.github', 'workflows');
const REVIEW = fs.readFileSync(path.join(WORKFLOWS, 'pr-guardian-self.yml'), 'utf8');
const PUBLISH = fs.readFileSync(path.join(WORKFLOWS, 'pr-guardian-ocr-sarif.yml'), 'utf8');

const OCR_VARS = ['OCR_LLM_URL', 'OCR_LLM_TOKEN', 'OCR_LLM_MODEL', 'OCR_LLM_PROTOCOL'];

function executed(source) {
  return source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
}

test('the review job receives the provider-neutral OCR endpoint from secrets only', () => {
  for (const name of OCR_VARS) {
    assert.match(REVIEW, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`), `${name} comes from a secret`);
  }
  // A literal endpoint or token in the workflow would pick the provider here.
  assert.doesNotMatch(executed(REVIEW), /^\s+OCR_LLM_(URL|TOKEN|MODEL|PROTOCOL):\s*(?!\$\{\{ secrets\.)\S/m);
});

test('the OCR binary is a pinned release verified against a pinned sha256', () => {
  const body = executed(REVIEW);
  assert.match(body, /OCR_VERSION: 1\.12\.11/);
  assert.match(body, /releases\/download\/v\$\{OCR_VERSION\}\/opencodereview-linux-amd64/);
  assert.match(body, /OCR_SHA256: ae202b88fa03e16926512487bf1051d37ccb3f9690bdd74b889d11ea4dd8099b/);
  assert.match(body, /sha256sum --check --strict/);
  // Not the npm package: its postinstall runs code, and this job never runs
  // an install (pinned by pr-guardian-self-review.test.js as well).
  assert.doesNotMatch(body, /\bnpm (ci|install|run)\b/);
});

test('without an endpoint the job installs nothing and the reviewer stays unknown', () => {
  const install = REVIEW.slice(REVIEW.indexOf('- name: Install the OCR reviewer'));
  assert.match(install, /if \[ -z "\$\{OCR_LLM_URL:-\}\$\{OCR_LLM_TOKEN:-\}\$\{OCR_LLM_MODEL:-\}" \]; then[\s\S]{0,200}?exit 0/);
});

test('a failed OCR install never stops the policy evaluation', () => {
  const install = REVIEW.slice(REVIEW.indexOf('- name: Install the OCR reviewer'), REVIEW.indexOf('- name: Evaluate the pull request'));
  assert.match(install, /^\s+continue-on-error: true$/m);
});

test('the review job keeps its read-only permissions', () => {
  assert.match(REVIEW, /^permissions:\n\s+contents: read\n\s+pull-requests: read$/m);
  assert.doesNotMatch(executed(REVIEW), /security-events:\s*write/);
});

test('the publish workflow only uploads the SARIF the review run produced', () => {
  assert.match(PUBLISH, /workflow_run:\n\s+workflows: \["PR Guardian self-review"\]\n\s+types: \[completed\]/);
  // Top level grants only read; the job alone may write security events.
  assert.match(PUBLISH, /^permissions:\n\s+contents: read\n\n/m);
  assert.match(PUBLISH, /permissions:\n\s+actions: read\n\s+security-events: write/);
  assert.doesNotMatch(PUBLISH, /contents:\s*write|pull-requests:\s*write|issues:\s*write/);
  // No checkout and no script: nothing the pull request wrote runs here.
  assert.doesNotMatch(PUBLISH, /actions\/checkout@/);
  assert.doesNotMatch(executed(PUBLISH), /\bnode\b|\bnpm\b/);
  assert.match(PUBLISH, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(PUBLISH, /github\/codeql-action\/upload-sarif@[0-9a-f]{40}/);
  assert.match(PUBLISH, /name: ocr-findings/);
  assert.match(PUBLISH, /category: ocr-review/);
  assert.match(PUBLISH, /sha: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
});

test('a run without findings publishes nothing', () => {
  assert.match(PUBLISH, /steps\.find\.outputs\.present == 'true'/);
});
