#!/usr/bin/env node
'use strict';

/**
 * A defect fix must be traceable to the issue it fixes and to a regression test
 * that can actually run, or carry a documented waiver (#4006).
 *
 * The repository already numbers regression tests by issue
 * (`test/issue-<n>-<slug>.test.js`), and a fix PR usually does add a test. What
 * nothing enforced is that the two are *linked*: a `fix(...)` change could land,
 * close its issue, and add no test at all, and every existing gate would still
 * pass -- the impact selector only asks which tests the change touches, never
 * whether a test pins the failure mode the issue reported.
 *
 * Scope is deliberately narrow, in both directions:
 *
 *   - Only a defect fix is held to it. The type is read from the pull request
 *     title, which is the same string that becomes the squash-commit subject, so
 *     `fix`, `security` and `hotfix` are in scope and `feat`, `test`, `chore`,
 *     `docs`, `ci`, `perf` and `refactor` are not. An ordinary enhancement is
 *     exempt by classification, not by a waiver anyone has to write.
 *   - A documentation-only change is exempt too: there is no runtime failure
 *     mode to pin, and demanding a test for a prose edit only teaches authors to
 *     write waivers until the gate means nothing.
 *
 * What remains is the class the issue names: a code fix that must either point
 * at its regression test or say, in one visible line, why it cannot. The
 * declaration lives in the pull request body because that is the one artifact
 * the author already writes and a reviewer already reads:
 *
 *     Regression-Test: test/issue-4006-<slug>.test.js
 *     Regression-Test: none -- the fix only rewords a refusal message; no path changes
 *
 * A named test is verified three ways: it must exist on disk, it must be a file
 * the CI test discovery actually runs (a discovered test file, not a stray
 * helper), and it must be in the applicable CI path for this change -- selected
 * by the impact plan for the changed files, or added by this pull request. A
 * declaration that names a test nothing will run is the same claim with extra
 * steps, and is refused.
 *
 * Fail-closed: a missing declaration, an unreadable pull request payload, or an
 * impact plan that cannot be built is a failure, never a silent pass. The
 * escape hatch is the documented waiver, which is a sentence a reviewer can
 * disagree with -- not an absence.
 *
 * CLI:
 *   node scripts/check-issue-regression-traceability.js <pull-request.json> <files.json>
 *
 * `pull-request.json` is `gh api repos/{owner}/{repo}/pulls/{n}` (title, body).
 * `files.json` is `gh api repos/{owner}/{repo}/pulls/{n}/files` in either the
 * single-page array shape or the `--paginate --slurp` array-of-pages shape.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DOC_ONLY_PATTERNS } = require('./ci-impact-rules');
const { matchesAny, normalizePath } = require('./ci-impact-plan-paths');
const { REPO_ROOT, discoverTestFiles } = require('./ci-shard-manifest');

/** Conventional-commit types that assert a defect was fixed. */
const DEFECT_FIX_TYPES = Object.freeze(['fix', 'security', 'hotfix']);
const DECLARATION_LABEL = 'Regression-Test';
const WAIVER_VALUE = 'none';
const ISSUE_REFERENCE = /#(\d+)/g;
const MIN_WAIVER_REASON = 10;

/** The leading conventional-commit type of a title, or null when there is none. */
function conventionalType(title) {
  const match = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(String(title || '').trim());
  return match ? match[1] : null;
}

function isDefectFix(title) {
  const type = conventionalType(title);
  return type !== null && DEFECT_FIX_TYPES.includes(type);
}

/**
 * Documentation-only when every changed file is a markdown document or lives on
 * a surface the repository already classifies as unable to affect runtime
 * behaviour (`docs/`, `specs/`, fixtures). An empty change set is not
 * documentation-only: it makes no claim this check can accept.
 */
function isDocumentationOnly(changedFiles) {
  const files = (changedFiles || []).map(normalizePath).filter(Boolean);
  if (files.length === 0) return false;
  return files.every((file) => file.endsWith('.md') || matchesAny(file, DOC_ONLY_PATTERNS));
}

function issueReferences(text) {
  return [...String(text || '').matchAll(ISSUE_REFERENCE)].map((match) => Number(match[1]));
}

function declarationLines(body) {
  const pattern = new RegExp(`^\\s*${DECLARATION_LABEL}\\s*:\\s*(.*)$`, 'gim');
  return [...String(body || '').matchAll(pattern)].map((match) => match[1].trim());
}

/**
 * Read the traceability declaration out of a pull request body.
 *
 * `missing` is not the same as `invalid`: one is "the author said nothing", the
 * other is "the author said something that cannot be read", and the failure
 * messages differ because the fix does.
 */
function parseDeclaration(body) {
  const lines = declarationLines(body);
  if (lines.length === 0) return { status: 'missing', tests: [], reason: '' };

  const waiverLine = lines.find((line) => new RegExp(`^${WAIVER_VALUE}\\b`, 'i').test(line));
  if (waiverLine) {
    const reason = waiverLine
      .replace(new RegExp(`^${WAIVER_VALUE}\\b`, 'i'), '')
      // A waiver is written `none -- reason` or `none: reason`; the separator is
      // any run of dashes or a colon, not a single character.
      .replace(/^\s*[-—:–]+\s*/, '')
      .trim();
    return { status: 'waiver', tests: [], reason };
  }

  const tests = [...new Set(lines.flatMap((line) => line.split(/[,\s]+/)).map((token) => token.trim()).filter(Boolean))];
  if (tests.length === 0) {
    return {
      status: 'invalid',
      tests: [],
      reason: '',
      error: `the ${DECLARATION_LABEL} line names no test file and is not "${WAIVER_VALUE}"`,
    };
  }
  return { status: 'tests', tests, reason: '' };
}

/**
 * Verify one declared test path: it exists, CI discovery runs it, and this
 * change puts it on the applicable CI path. Each failure names the path so the
 * message is actionable without re-reading the declaration.
 */
function verifyDeclaredTest(test, { changed, known, selected, fullSuite }) {
  const relative = normalizePath(test);
  const failures = [];
  if (path.isAbsolute(relative) || relative.split('/').includes('..')) {
    failures.push(`${test}: a declared test path must be repository-relative`);
    return failures;
  }
  const absolute = path.join(REPO_ROOT, relative);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    failures.push(`${relative}: the declared regression test does not exist`);
    return failures;
  }
  if (!stat.isFile()) {
    failures.push(`${relative}: the declared regression test is not a file`);
    return failures;
  }
  if (!known.has(relative)) {
    failures.push(`${relative}: not a discovered test file, so no CI path runs it`);
    return failures;
  }
  if (!changed.has(relative) && !selected.has(relative) && !fullSuite) {
    failures.push(`${relative}: not selected by the impact plan for this change, and not added by this pull request`);
  }
  return failures;
}

/**
 * The verdict for one pull request. Pure over its inputs except for the disk
 * existence probe, so a test can exercise every branch with a fixture list.
 */
function evaluateTraceability({
  title,
  body,
  changedFiles = [],
  knownTests = [],
  selectedTests = [],
  fullSuite = false,
} = {}) {
  const files = (changedFiles || []).map(normalizePath).filter(Boolean);

  if (!isDefectFix(title)) {
    return { required: false, ok: true, kind: 'exempt', reason: 'not a defect fix', failures: [] };
  }
  if (isDocumentationOnly(files)) {
    return { required: false, ok: true, kind: 'exempt', reason: 'documentation-only change', failures: [] };
  }

  const declaration = parseDeclaration(body);
  const issues = [...new Set([...issueReferences(title), ...issueReferences(body)])];
  const failures = [];

  if (declaration.status === 'missing') {
    failures.push(
      `no ${DECLARATION_LABEL} line in the pull request body: name the regression test, `
      + `or write "${DECLARATION_LABEL}: ${WAIVER_VALUE} -- <reason>"`,
    );
  } else if (declaration.status === 'invalid') {
    failures.push(declaration.error);
  } else if (declaration.status === 'waiver') {
    if (declaration.reason.length < MIN_WAIVER_REASON) {
      failures.push(
        `a ${DECLARATION_LABEL}: ${WAIVER_VALUE} waiver needs a reason of at least `
        + `${MIN_WAIVER_REASON} characters, so a reviewer can disagree with it`,
      );
    }
  } else {
    if (issues.length === 0) {
      failures.push('the pull request names no issue (#NNNN), so the regression test cannot be traced to a defect');
    }
    const changed = new Set(files);
    const known = new Set(knownTests.map(normalizePath));
    const selected = new Set(selectedTests.map(normalizePath));
    for (const test of declaration.tests) {
      failures.push(...verifyDeclaredTest(test, { changed, known, selected, fullSuite }));
    }
  }

  return {
    required: true,
    ok: failures.length === 0,
    kind: declaration.status,
    reason: declaration.reason,
    issues,
    tests: declaration.tests,
    failures,
  };
}

/** The changed-file paths from either pull request files payload shape. */
function changedFilesFrom(payload) {
  if (!Array.isArray(payload)) return null;
  return payload.flat()
    .map((entry) => (entry && typeof entry === 'object' ? entry.filename : null))
    .filter(Boolean)
    .map(normalizePath)
    .sort();
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`could not read the ${label} at ${file}: ${error.message}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const [prFile, filesFile] = argv;
  if (!prFile || !filesFile) {
    process.stderr.write('usage: check-issue-regression-traceability.js <pull-request.json> <files.json>\n');
    return 2;
  }

  let pullRequest;
  let filesPayload;
  try {
    pullRequest = readJson(prFile, 'pull request payload');
    filesPayload = readJson(filesFile, 'pull request files payload');
  } catch (error) {
    process.stderr.write(`issue-regression-traceability: ${error.message}\n`);
    return 2;
  }

  const changedFiles = changedFilesFrom(filesPayload);
  if (changedFiles === null) {
    process.stderr.write('issue-regression-traceability: the files payload must be an array (use --slurp for a paginated read)\n');
    return 2;
  }

  const title = pullRequest && pullRequest.title;
  const body = pullRequest && pullRequest.body;

  // The impact plan is only needed when a declared test is not already part of
  // this pull request; building it otherwise would add a failure mode with no
  // question to answer.
  const declaration = parseDeclaration(body);
  const changed = new Set(changedFiles);
  const needsPlan = isDefectFix(title)
    && declaration.status === 'tests'
    && !isDocumentationOnly(changedFiles)
    && declaration.tests.some((test) => !changed.has(normalizePath(test)));

  let selectedTests = [];
  let fullSuite = false;
  if (needsPlan) {
    let plan;
    try {
      // Required lazily: the plan builder reads the git tree, which the
      // documentation-only and declaration-free paths never need.
      const { buildTestImpactPlan } = require('./ci-impact-plan');
      plan = buildTestImpactPlan({ changedFiles, mode: 'pr' });
    } catch (error) {
      process.stderr.write(
        `issue-regression-traceability: the impact plan could not be built, so a declared test `
        + `cannot be shown to be on the applicable CI path: ${error.message}\n`,
      );
      return 2;
    }
    selectedTests = plan.selectedTests || [];
    fullSuite = Boolean(plan.fullSuite);
  }

  const verdict = evaluateTraceability({
    title,
    body,
    changedFiles,
    knownTests: discoverTestFiles(REPO_ROOT),
    selectedTests,
    fullSuite,
  });

  if (!verdict.required) {
    console.log(`issue-regression-traceability: not required (${verdict.reason}).`);
    return 0;
  }

  if (!verdict.ok) {
    process.stderr.write('Issue-to-regression-test traceability failed:\n');
    for (const failure of verdict.failures) process.stderr.write(`- ${failure}\n`);
    process.stderr.write(
      '\nAdd a `' + DECLARATION_LABEL + ': <test path>` line naming a test that exists and runs on CI,\n'
      + 'or document a waiver with `' + DECLARATION_LABEL + ': ' + WAIVER_VALUE + ' -- <reason>`.\n',
    );
    return 1;
  }

  if (verdict.kind === 'waiver') {
    console.log(`issue-regression-traceability: documented waiver accepted -- ${verdict.reason}`);
    return 0;
  }

  console.log(
    `issue-regression-traceability: defect fix #${verdict.issues[0]} traced to `
    + `${verdict.tests.length} regression test(s): ${verdict.tests.join(', ')}`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`issue-regression-traceability: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  DECLARATION_LABEL,
  MIN_WAIVER_REASON,
  WAIVER_VALUE,
  changedFilesFrom,
  conventionalType,
  evaluateTraceability,
  isDefectFix,
  isDocumentationOnly,
  issueReferences,
  main,
  parseDeclaration,
};
