'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  GITHUB_APP_WRITEBACK_CONTRACT_VERSION,
  GITHUB_APP_CHECK_RUN_PATH,
  GITHUB_APP_ISSUE_COMMENT_PATH,
  buildGitHubAppWritebackContract,
} = require('./github-app-writeback-contract');

const CONTRACT_KEYS = [
  'contractVersion',
  'checkRunPath',
  'issueCommentPath',
  'tokenExchangeReady',
  'writebackReachable',
  'verificationSourceReady',
  'securityReviewComplete',
];

test('the descriptor is deeply frozen and contains only the approved keys', () => {
  const contract = buildGitHubAppWritebackContract();
  assert.equal(Object.isFrozen(contract), true);
  assert.deepEqual(Object.keys(contract), CONTRACT_KEYS);
  assert.equal(contract.contractVersion, GITHUB_APP_WRITEBACK_CONTRACT_VERSION);
  assert.equal(contract.checkRunPath, GITHUB_APP_CHECK_RUN_PATH);
  assert.equal(contract.issueCommentPath, GITHUB_APP_ISSUE_COMMENT_PATH);
});

test('readiness fields are always false, regardless of arguments', () => {
  for (const input of [undefined, null, {}, { writebackReachable: true }, 'x', 42, []]) {
    const contract = buildGitHubAppWritebackContract(input);
    assert.equal(contract.writebackReachable, false);
    assert.equal(contract.verificationSourceReady, false);
    assert.equal(contract.securityReviewComplete, false);
  }
});

test('a prototype-polluted-looking input cannot flip any readiness field', () => {
  const evil = Object.create({ writebackReachable: true, securityReviewComplete: true });
  const contract = buildGitHubAppWritebackContract(evil);
  assert.equal(contract.writebackReachable, false);
  assert.equal(contract.securityReviewComplete, false);
});

test('tokenExchangeReady reflects the real export shape without calling it', () => {
  const contract = buildGitHubAppWritebackContract();
  // github-app-beta-auth.js genuinely exports createInstallationAccessToken
  // today, so this must observe true -- but observing is not calling.
  assert.equal(contract.tokenExchangeReady, true);
});

test('the module performs no network I/O and imports no fetch-capable module', () => {
  const source = fs.readFileSync(path.join(__dirname, 'github-app-writeback-contract.js'), 'utf8');
  assert.equal(/require\(\s*['"]node:https?['"]\s*\)/.test(source), false);
  assert.equal(/require\(\s*['"]undici['"]\s*\)/.test(source), false);
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/createInstallationAccessToken\s*\(/.test(source), false);
});

test('github-app-server.js and the beta handler do not import this contract', () => {
  const repoRoot = path.join(__dirname, '..');
  const serverSource = fs.readFileSync(path.join(repoRoot, 'github-app-server.js'), 'utf8');
  const handlerSource = fs.readFileSync(path.join(repoRoot, 'lib', 'github-app-beta-handler.js'), 'utf8');
  const boundarySource = fs.readFileSync(path.join(repoRoot, 'lib', 'github-app-beta-http-boundary.js'), 'utf8');

  for (const source of [serverSource, handlerSource, boundarySource]) {
    assert.equal(source.includes('github-app-writeback-contract'), false);
  }
});
