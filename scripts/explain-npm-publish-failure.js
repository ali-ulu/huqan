'use strict';

/**
 * Turns npm's publish failure into the instruction it withholds.
 *
 * Trusted publishing fails with `404 Not Found - PUT .../huqan` when the
 * package has no trusted publisher configured for this repository, workflow and
 * environment. npm answers an unauthorized upload with 404 rather than 403 so a
 * stranger cannot enumerate private packages, which means the one error a
 * release engineer sees names the package and says nothing about the
 * credential. Eight consecutive releases failed that way before anyone read the
 * publish log closely enough to tell "not configured" from "does not exist".
 *
 * This does not decide anything: the publish has already failed by the time it
 * runs. It reads the captured log and, when the signature matches, prints the
 * four values that must line up on npmjs.com, because getting one of them wrong
 * produces exactly the same 404 as having done nothing at all.
 */

const fs = require('node:fs');

const UNAUTHORIZED_PUT = /npm error (?:code )?E?404[\s\S]{0,400}?PUT https:\/\/registry\.npmjs\.org\//i;
// The 404 also appears on a genuine miss during other npm operations; a publish
// that never reached the registry has a different shape entirely.
const PUT_LINE = /404[^\n]*PUT https:\/\/registry\.npmjs\.org\//i;

/** True when the log carries npm's unauthorized-upload signature. */
function isUnauthorizedPublish(log) {
  return UNAUTHORIZED_PUT.test(log) || PUT_LINE.test(log);
}

function diagnosis({ repository, workflow, environment }) {
  return [
    'npm refused the upload with 404 on PUT. For trusted publishing that means the package has no',
    'trusted publisher matching this run -- not that the package is missing.',
    '',
    'Configure it once at npmjs.com > huqan > Settings > Trusted Publisher, with all four values exact:',
    `  Organization or user : ${repository.split('/')[0]}`,
    `  Repository           : ${repository.split('/')[1]}`,
    `  Workflow filename    : ${workflow}`,
    `  Environment          : ${environment}`,
    '',
    'A mismatch in any one of them produces this identical 404, so compare all four rather than',
    'assuming the first three are fine. A dry run cannot confirm the fix: the OIDC exchange happens',
    'during the upload a dry run withholds, so only a real v* tag proves it.',
  ].join('\n');
}

function main(argv, env, out, err) {
  const logPath = argv[2];
  if (!logPath) {
    err('usage: explain-npm-publish-failure.js <npm-publish-log>\n');
    return 2;
  }
  let log = '';
  try {
    log = fs.readFileSync(logPath, 'utf8');
  } catch (error) {
    // Never mask the publish failure with a failure to explain it.
    err(`could not read ${logPath}: ${error.message}\n`);
    return 0;
  }
  if (!isUnauthorizedPublish(log)) return 0;

  const text = diagnosis({
    repository: env.GITHUB_REPOSITORY || 'ali-ulu/huqan',
    workflow: env.PUBLISH_WORKFLOW_FILENAME || 'publish.yml',
    environment: env.PUBLISH_ENVIRONMENT || 'npm-publish',
  });
  // A workflow annotation keeps the whole diagnosis on the run summary rather
  // than only in the log nobody expands.
  out(`::error title=npm trusted publisher is not configured::${text.replace(/\n/g, '%0A')}\n`);
  out(`${text}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(
    process.argv,
    process.env,
    text => process.stdout.write(text),
    text => process.stderr.write(text),
  );
}

module.exports = { isUnauthorizedPublish, diagnosis, main };
