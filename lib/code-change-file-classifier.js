'use strict';

// Classifies one changed file into the surface it touches and the decision
// that surface earns on its own (#2134).
//
// The surfaces are checked in a fixed order and the first match wins: the
// blocking ones (auto-merge, release, secret) before anything that could
// allow. Reordering SURFACES changes decisions.

const { containsWholeTerm, containsNormalizedTerm, isExactSensitiveFilePath, isSecretLikeValue, normalizeText } = require('./text-utils');
const { isDocsPath, isHelperPath } = require('./code-change-path-classification');
const { CODE_CHANGE_GATE_DECISIONS, CODE_CHANGE_RISK_LEVELS, CODE_CHANGE_GATE_REASONS, normalizePath } = require('./code-change-gate-vocabulary');
const { normalizeFileInput } = require('./code-change-input');

const TEST_PATH_HINTS = Object.freeze([
  'test/',
  'tests/',
  '__tests__',
  '.test.',
  '.spec.',
]);

const PACKAGE_PATH_HINTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const WORKFLOW_PATH_HINTS = Object.freeze([
  '.github/workflows/',
  '.github/actions/',
  'workflow',
  'ci/',
  '.circleci/',
  'azure-pipelines',
]);

const RUNTIME_PATH_HINTS = Object.freeze([
  'server.js',
  'mcpserver.js',
  'kernel.js',
  'kernel.v2.js',
  'graph.js',
  'requestguards.js',
  'plugin.js',
  'lib/verify.js',
]);

const MEMORY_PATH_HINTS = Object.freeze([
  'memory/',
  '/memory-',
  'memory.js',
  'memory.',
  'memory_',
]);

const RELEASE_DEPLOY_HINTS = Object.freeze([
  'release',
  'deploy',
  'publish',
  'automerge',
  'auto-merge',
  'auto merge',
  'autopush',
  'auto-push',
  'auto deploy',
  'auto-deploy',
]);

const SECRET_HINTS = Object.freeze([
  'api key',
  'apikey',
  'api_key',
  'api-key',
  'secret',
  'token',
  'password',
  'passwd',
  'bearer',
  'credential',
  'private key',
  '.env',
  'id_rsa',
  'client secret',
]);

/**
 * Two vocabularies, two match rules.
 *
 * Path hints are substrings of a path, because a directory segment such as
 * `test/` ends in `/`, which `isWordChar` rejects -- a whole-term match can
 * never find it. A directory hint must still sit on a segment boundary,
 * though: without one, `test/` fires on the `test/` suffix of `src/latest/`
 * and an ordinary source change would be misread as tests-only and allowed.
 * So a hint that ends in `/` has to start the path or follow a `/`; the
 * dotted file-name hints (`.test.`, `.spec.`) stay plain substrings.
 *
 * Content hints (`token`, `deploy`, `secret`) must not fire inside a larger
 * word, or `lib/tokenizer.js` and `docs/deployment.md` would hard-block; those
 * stay whole-term so `containsAnyWholeTerm` semantics are preserved.
 */
function directoryHintMatches(text, hint) {
  let from = 0;
  for (;;) {
    const index = text.indexOf(hint, from);
    if (index === -1) return false;
    if (index === 0 || text[index - 1] === '/') return true;
    from = index + 1;
  }
}

function includesAnyPath(text, hints) {
  const normalizedText = normalizeText(text);
  return hints.some(hint => {
    const normalizedHint = normalizeText(hint);
    return normalizedHint.endsWith('/')
      ? directoryHintMatches(normalizedText, normalizedHint)
      : normalizedText.includes(normalizedHint);
  });
}

function includesAnyContent(text, hints) {
  const normalized = normalizeText(text);
  return hints.some(hint => containsWholeTerm(normalized, normalizeText(hint)));
}

function hintedPath(changeTypes, hints) {
  return (path, changeType) => changeTypes.includes(normalizeText(changeType)) || includesAnyPath(normalizePath(path).toLowerCase(), hints);
}

const isTestPath = hintedPath(['test'], TEST_PATH_HINTS);
const isPackagePath = hintedPath(['package'], PACKAGE_PATH_HINTS);
const isWorkflowPath = hintedPath(['workflow', 'ci'], WORKFLOW_PATH_HINTS);
const isRuntimePath = hintedPath(['runtime'], RUNTIME_PATH_HINTS);
const isMemoryPath = hintedPath(['memory'], MEMORY_PATH_HINTS);

function isReleaseOrDeployPath(path, changeType, textSignals) {
  const normalized = normalizePath(path).toLowerCase();
  const signalText = normalizeText([path, changeType, textSignals].filter(Boolean).join(' '));
  return includesAnyContent(normalized, RELEASE_DEPLOY_HINTS) || includesAnyContent(signalText, RELEASE_DEPLOY_HINTS);
}

function isAutoMergePath(path, changeType, textSignals) {
  const signalText = normalizeText([path, changeType, textSignals].filter(Boolean).join(' '));
  return signalText.includes('auto merge') || signalText.includes('auto-merge') || signalText.includes('automerge') || signalText.includes('autopush') || signalText.includes('auto push');
}

const { LOW, MEDIUM, HIGH, CRITICAL } = CODE_CHANGE_RISK_LEVELS;
const { ALLOW, REVIEW, BLOCK, DRY_RUN_ONLY } = CODE_CHANGE_GATE_DECISIONS;
const R = CODE_CHANGE_GATE_REASONS;

// [matches(file, textSignals), category, riskLevel, riskScore, decision, reason, note, sensitive]
const SURFACES = [
  [(f, s) => isAutoMergePath(f.path, f.changeType, s), 'auto_merge', CRITICAL, 1, BLOCK, R.AUTO_MERGE_OR_AUTOPUSH_BLOCKED, 'Auto-merge or autopush surface detected.', true],
  [(f, s) => isReleaseOrDeployPath(f.path, f.changeType, s), 'release_or_deploy', CRITICAL, 1, BLOCK, R.RELEASE_OR_DEPLOY_CHANGE_BLOCKED, 'Release or deploy surface detected.', true],
  [f => isExactSensitiveFilePath(f.path) || isSecretLikeValue({ status: f.status, changeType: f.changeType, additions: f.additions, deletions: f.deletions }, SECRET_HINTS), 'secret', CRITICAL, 1, BLOCK, R.SECRET_CHANGE_BLOCKED, 'Sensitive file or metadata pattern detected.', true],
  [f => isPackagePath(f.path, f.changeType), 'package', MEDIUM, 0.6, REVIEW, R.PACKAGE_MUTATION_REQUIRES_REVIEW, 'Package or lockfile mutation detected.', false],
  [f => isWorkflowPath(f.path, f.changeType), 'workflow', HIGH, 0.8, REVIEW, R.CI_WORKFLOW_CHANGE_REQUIRES_REVIEW, 'CI or workflow surface detected.', false],
  [f => isRuntimePath(f.path, f.changeType) || isMemoryPath(f.path, f.changeType), f => (isMemoryPath(f.path, f.changeType) ? 'memory' : 'runtime'), HIGH, 0.85, DRY_RUN_ONLY, R.RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN, 'Runtime, kernel, graph, or memory surface detected.', false],
  [f => isDocsPath(f.path), 'docs', LOW, 0.15, ALLOW, R.LOW_RISK_DOCS_ONLY, 'Docs-only surface detected.', false],
  [f => isTestPath(f.path, f.changeType), 'tests', LOW, 0.15, ALLOW, R.LOW_RISK_TESTS_ONLY, 'Tests-only surface detected.', false],
  [f => isHelperPath(f.path, f.changeType), 'helper', LOW, 0.2, ALLOW, R.NARROW_HELPER_CHANGE, 'Narrow helper or utility surface detected.', false],
  [() => true, 'source', MEDIUM, 0.55, REVIEW, R.SOURCE_CHANGE_REQUIRES_REVIEW, 'Generic source change requires review.', false],
];

function classifyChangedFile(file, context = {}) {
  const normalized = normalizeFileInput(file);
  const textSignals = [context.intent, context.diffSummary, normalized.path, normalized.changeType].filter(Boolean).join(' ');

  if (!normalized.path) {
    return {
      ok: false,
      path: '',
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'malformed',
      riskLevel: MEDIUM,
      riskScore: 0.6,
      decision: REVIEW,
      reason: R.MALFORMED_INPUT_REVIEW_REQUIRED,
      notes: ['File path is missing.'],
      sensitive: false,
    };
  }

  const [, category, riskLevel, riskScore, decision, reason, note, sensitive] = SURFACES.find(([matches]) => matches(normalized, textSignals));
  return {
    ok: true,
    path: normalized.path,
    status: normalized.status,
    changeType: normalized.changeType,
    category: typeof category === 'function' ? category(normalized) : category,
    riskLevel,
    riskScore,
    decision,
    reason,
    notes: [note],
    sensitive,
  };
}

module.exports = {
  SECRET_HINTS,
  classifyChangedFile,
};
