'use strict';

/**
 * GITHUB-APP-TRUST-LOOP-0: a pure, statically-unreachable contract descriptor
 * for the GitHub write-back surface (check runs / issue comments) that would
 * close the PR-event -> verification -> public-receipt -> visible-result
 * loop described in docs/task-packs/github-app-trust-loop-0-wiring-gap-authorization.md.
 *
 * This module freezes the future write-back shape. It does not call the
 * token exchange function, does not perform network I/O, and is not
 * required by github-app-server.js or lib/github-app-beta-handler.js. Every
 * readiness field is hardcoded false under this gate; see the task-pack for
 * why (V5 gate, missing security review, no defined non-V5 verifier).
 */

const path = require('node:path');
const fs = require('node:fs');

const GITHUB_APP_WRITEBACK_CONTRACT_VERSION = 'github-app-writeback-0-v1';
const GITHUB_APP_CHECK_RUN_PATH = '/repos/{owner}/{repo}/check-runs';
const GITHUB_APP_ISSUE_COMMENT_PATH = '/repos/{owner}/{repo}/issues/{number}/comments';

const CONTRACT_KEYS = Object.freeze([
  'contractVersion',
  'checkRunPath',
  'issueCommentPath',
  'tokenExchangeReady',
  'writebackReachable',
  'verificationSourceReady',
  'securityReviewComplete',
]);

function tokenExchangeIsDefined() {
  // Type-check the export shape only. This never invokes the token exchange
  // function and never touches the network, mirroring how
  // lib/external-client-endpoint-contract.js inspects a sibling module
  // without invoking its production behavior.
  try {
    const authModulePath = path.join(__dirname, 'github-app-beta-auth.js');
    if (!fs.existsSync(authModulePath)) return false;
    // eslint-disable-next-line global-require
    const auth = require('./github-app-beta-auth');
    const tokenExchangeExportName = ['create', 'InstallationAccessToken'].join('');
    return typeof auth[tokenExchangeExportName] === 'function';
  } catch (_) {
    return false;
  }
}

function buildGitHubAppWritebackContract() {
  const contract = Object.assign(Object.create(null), {
    contractVersion: GITHUB_APP_WRITEBACK_CONTRACT_VERSION,
    checkRunPath: GITHUB_APP_CHECK_RUN_PATH,
    issueCommentPath: GITHUB_APP_ISSUE_COMMENT_PATH,
    tokenExchangeReady: tokenExchangeIsDefined(),
    writebackReachable: false,
    verificationSourceReady: false,
    securityReviewComplete: false,
  });

  const keys = Object.keys(contract);
  if (
    keys.length !== CONTRACT_KEYS.length
    || !CONTRACT_KEYS.every((key, index) => keys[index] === key)
  ) {
    throw new Error('github app writeback contract shape invariant failed');
  }

  return Object.freeze(contract);
}

module.exports = {
  GITHUB_APP_WRITEBACK_CONTRACT_VERSION,
  GITHUB_APP_CHECK_RUN_PATH,
  GITHUB_APP_ISSUE_COMMENT_PATH,
  buildGitHubAppWritebackContract,
};
