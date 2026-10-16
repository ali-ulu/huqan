'use strict';

// Pins every decision the code-change gate reaches, field for field (#2134).
// The file split in that issue moves this code; no decision may move with it.
//
// Regenerate only on purpose: UPDATE_CODE_CHANGE_GATE_FIXTURE=1 node --test <this file>

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const gate = require('../lib/code-change-gate');

const FIXTURE = path.join(__dirname, 'fixtures', 'code-change-gate-decisions.json');
const UNDEFINED = '__undefined__';

function snapshot(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (item === undefined ? UNDEFINED : item)));
}

function capture(fn) {
  try {
    return snapshot(fn());
  } catch (error) {
    return { threw: String(error && error.message) };
  }
}

// One path per classifier branch, plus paths that sit on the edges between them.
const PATHS = [
  '',
  'docs/guide.md',
  'README.md',
  'test/gate.test.js',
  'src/__tests__/a.js',
  'lib/foo.spec.js',
  'package.json',
  'nested/package-lock.json',
  '.github/workflows/ci.yml',
  'scripts/ci/run.sh',
  'server.js',
  'lib/verify.js',
  'lib\\memory-store.js',
  'memory/index.js',
  'lib/text-utils.js',
  'lib/helpers/format.js',
  'lib/coder/apply.js',
  'scripts/release.sh',
  'deploy/app.yaml',
  'scripts/auto-merge.js',
  '.env',
  'config/id_rsa',
  'lib//double//slash.js',
];

const CHANGE_TYPES = [undefined, 'docs', 'test', 'package', 'workflow', 'ci', 'runtime', 'memory', 'helper', 'Secret', 'weird'];

const CLASSIFY_CONTEXTS = [
  {},
  { intent: 'refactor helper', diffSummary: 'small change' },
  { intent: 'publish the package', diffSummary: '' },
  { intent: 'rotate api key', diffSummary: 'token update' },
];

function classifyScenarios() {
  const out = {};
  for (const filePath of PATHS) {
    for (const changeType of CHANGE_TYPES) {
      const file = { path: filePath, changeType, status: 'modified', additions: 3, deletions: 1 };
      out[`classify/${JSON.stringify(filePath)}/${changeType}/0`] = capture(() => gate.classifyChangedFile(file, CLASSIFY_CONTEXTS[0]));
    }
    for (const [index, context] of CLASSIFY_CONTEXTS.entries()) {
      if (index === 0) continue;
      out[`classify/${JSON.stringify(filePath)}/-/${index}`] = capture(() => gate.classifyChangedFile({ path: filePath }, context));
    }
  }
  out['classify/non-object'] = capture(() => gate.classifyChangedFile('docs/a.md'));
  out['classify/type-alias'] = capture(() => gate.classifyChangedFile({ path: 'x.js', type: 'docs', status: 'added' }));
  return out;
}

const FILE_SETS = {
  none: [],
  docs: [{ path: 'docs/a.md' }],
  docsTests: [{ path: 'docs/a.md' }, { path: 'test/a.test.js' }],
  source: [{ path: 'lib/coder/apply.js' }],
  runtime: [{ path: 'server.js' }],
  crossCutting: [{ path: 'package.json' }, { path: '.github/workflows/ci.yml' }],
  runtimeAndDocs: [{ path: 'kernel.js' }, { path: 'docs/a.md' }],
  secret: [{ path: '.env' }, { path: 'docs/a.md' }],
  release: [{ path: 'scripts/release.sh' }, { path: 'scripts/auto-merge.js' }, { path: '.env' }],
  broadSix: Array.from({ length: 6 }, (_, i) => ({ path: `lib/coder/f${i}.js` })),
  broadTen: Array.from({ length: 10 }, (_, i) => ({ path: `lib/coder/g${i}.js` })),
  broadDocs: Array.from({ length: 12 }, (_, i) => ({ path: `docs/p${i}.md` })),
  unsorted: [{ path: 'z.md' }, { path: 'a/b.js' }, { path: 'M.md' }],
  malformedEntry: [null, { path: 'docs/a.md' }],
};

const OPERATIONS = [undefined, 'patch', 'Dry Run', 'preview', 'delete'];

const REPO_STATES = {
  clean: { branch: 'feature/x' },
  main: { branch: 'main' },
  originMain: { currentBranch: 'origin/main' },
  explicitNotMain: { branch: 'main', isMain: false },
  dirty: { branch: 'feature/x', dirty: true },
  untracked: { branch: 'feature/x', hasUntracked: true },
};

const POLICIES = {
  none: undefined,
  review: { minimumDecision: 'review' },
  block: { overrides: { decision: 'BLOCK' }, version: 'custom-v2', metadata: { workspaceId: 'tenant-p' } },
  dryRun: { decision: 'dry_run_only' },
  bogus: { minimumDecision: 'sometimes' },
  notObject: 'block',
};

function evaluateScenarios() {
  const out = {};
  for (const [setName, files] of Object.entries(FILE_SETS)) {
    // Operation and repo state interact only through the main-branch write block,
    // which `patch` on every state exercises; the full cross product adds nothing.
    for (const operationType of OPERATIONS) {
      out[`evaluate/${setName}/${operationType}/clean`] = capture(() => gate.evaluateCodeChange({ files, operationType, repoState: REPO_STATES.clean }));
    }
    for (const [stateName, repoState] of Object.entries(REPO_STATES)) {
      out[`evaluate/${setName}/patch/${stateName}`] = capture(() => gate.evaluateCodeChange({ files, operationType: 'patch', repoState }));
    }
    for (const [policyName, policy] of Object.entries(POLICIES)) {
      out[`evaluate/${setName}/policy:${policyName}`] = capture(() => gate.evaluateCodeChange({ files, operationType: 'preview', policy }));
      out[`evaluate/${setName}/option-policy:${policyName}`] = capture(() => gate.evaluateCodeChange({ files, operationType: 'preview' }, { policy }));
    }
  }
  const docs = FILE_SETS.docs;
  const extras = {
    'no-input': () => gate.evaluateCodeChange(),
    'array-input': () => gate.evaluateCodeChange([]),
    'files-not-array': () => gate.evaluateCodeChange({ files: 'docs/a.md', operationType: 'preview' }),
    'secret-intent': () => gate.evaluateCodeChange({ files: docs, operationType: 'preview', intent: 'add the api key' }),
    'secret-diff': () => gate.evaluateCodeChange({ files: docs, operationType: 'preview', diffSummary: 'password=hunter2' }),
    'secret-metadata': () => gate.evaluateCodeChange({ files: docs, operationType: 'preview', metadata: { note: 'bearer abc' } }),
    'workspace-metadata': () => gate.evaluateCodeChange({ files: docs, operationType: 'preview', metadata: { workspaceId: 'tenant-a' } }),
    'context-metadata': () => gate.evaluateCodeChange({ files: docs, operationType: 'preview', contextMetadata: { workspaceId: 'tenant-b' } }),
    'patch-file-count': () => gate.evaluateCodeChange({ files: FILE_SETS.source, operationType: 'preview', patchMetadata: { fileCount: 11, additions: 5 } }),
    'gate-policy-alias': () => gate.evaluateCodeChange({ files: docs, operationType: 'preview', gatePolicy: { minimumDecision: 'review' } }),
    'code-change-policy-alias': () => gate.evaluateCodeChange({ files: docs, operationType: 'preview', codeChangePolicy: { minimumDecision: 'block' } }),
    'policy-override-wins': () => gate.evaluateCodeChange({ files: docs, operationType: 'preview', policy: { minimumDecision: 'block' }, policyOverride: { minimumDecision: 'review' } }),
    'release-intent': () => gate.evaluateCodeChange({ files: FILE_SETS.source, operationType: 'preview', intent: 'deploy to prod' }),
    'automerge-diff': () => gate.evaluateCodeChange({ files: FILE_SETS.source, operationType: 'preview', diffSummary: 'enable auto merge' }),
  };
  for (const [name, fn] of Object.entries(extras)) out[`evaluate/extra/${name}`] = capture(fn);
  return out;
}

function normalizeScenarios() {
  const out = {};
  const inputs = {
    empty: undefined,
    full: {
      files: [{ path: 'b\\c.js', type: 'Docs', additions: '4', deletions: -2 }, { path: 'a.md' }],
      intent: '  intent  ',
      operationType: 'DRY-RUN',
      diffSummary: 'summary',
      patchMetadata: { additions: 7, deletions: 'x', fileCount: 2 },
      repoState: { currentBranch: 'release/main', dirty: 1 },
      priorDecisions: { a: 1 },
      codeChangePolicy: { version: 'v9', workspaceId: '' },
      contextMetadata: { workspaceId: '' },
    },
  };
  for (const [name, input] of Object.entries(inputs)) {
    out[`normalizeInput/${name}`] = capture(() => gate.normalizeCodeChangeInput(input));
  }
  const decisions = {
    empty: undefined,
    lowercase: { decision: 'ALLOW', reason: '', risk: { level: 'severe', score: 3, categories: ['b', 'a', 'b', null] } },
    bogus: { ok: false, decision: 'maybe', risk: 'x', fileFindings: [{ path: 'z', riskLevel: 'moderate', riskScore: 'n', decision: 'dry_run_only', notes: ['a', 0, 'b'] }, 'bad'], warnings: ['w', '', 2], metadata: { policyVersion: 'p', workspaceId: '' } },
  };
  for (const [name, decision] of Object.entries(decisions)) {
    out[`normalizeDecision/${name}`] = capture(() => gate.normalizeCodeChangeDecision(decision));
  }
  const summaries = {
    notArray: 'x',
    empty: [],
    reviewThenAllow: [{ path: 'b', decision: 'review', reason: 'SOURCE_CHANGE_REQUIRES_REVIEW', category: 'source' }, { path: 'c', decision: 'allow', reason: 'LOW_RISK_DOCS_ONLY', category: 'docs' }],
    allowThenDryRun: [{ path: 'a', decision: 'allow', category: 'docs', reason: 'LOW_RISK_DOCS_ONLY' }, { path: 'b', decision: 'dry_run_only', category: 'runtime', reason: 'RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN' }],
    twoBroadAllow: [{ path: 'a', decision: 'allow', category: 'package', reason: 'X' }, { path: 'b', decision: 'allow', category: 'workflow', reason: 'Y' }],
    criticalOrder: [{ path: 'a', decision: 'block', reason: 'SECRET_CHANGE_BLOCKED', category: 'secret' }, { path: 'b', decision: 'block', reason: 'AUTO_MERGE_OR_AUTOPUSH_BLOCKED', category: 'auto_merge' }],
    unknownDecision: [{ path: 'a', decision: 'nope' }],
  };
  for (const [name, findings] of Object.entries(summaries)) {
    out[`summarize/${name}`] = capture(() => gate.summarizeFileFindings(findings));
  }
  return out;
}

function surface() {
  return snapshot({
    exports: Object.keys(gate),
    DECISIONS: gate.CODE_CHANGE_GATE_DECISIONS,
    REASONS: gate.CODE_CHANGE_GATE_REASONS,
    RISK_LEVELS: gate.CODE_CHANGE_RISK_LEVELS,
    POLICY_VERSION: gate.CODE_CHANGE_POLICY_VERSION,
    frozen: [gate.CODE_CHANGE_GATE_DECISIONS, gate.CODE_CHANGE_GATE_REASONS, gate.CODE_CHANGE_RISK_LEVELS].map(Object.isFrozen),
  });
}

test('code-change gate decisions match the recorded characterisation', () => {
  const actual = { surface: surface(), runs: { ...classifyScenarios(), ...evaluateScenarios(), ...normalizeScenarios() } };

  if (process.env.UPDATE_CODE_CHANGE_GATE_FIXTURE === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    // One scenario per line keeps a real decision change reviewable as a one-line diff.
    const runs = Object.entries(actual.runs).map(([key, run]) => `    ${JSON.stringify(key)}: ${JSON.stringify(run)}`);
    fs.writeFileSync(FIXTURE, `{\n  "surface": ${JSON.stringify(actual.surface)},\n  "runs": {\n${runs.join(',\n')}\n  }\n}\n`);
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(actual.surface, expected.surface);
  assert.deepEqual(Object.keys(actual.runs), Object.keys(expected.runs));
  for (const key of Object.keys(expected.runs)) {
    assert.deepEqual(actual.runs[key], expected.runs[key], key);
  }
});
