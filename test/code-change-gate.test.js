'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CODE_CHANGE_GATE_DECISIONS,
  CODE_CHANGE_GATE_REASONS,
  CODE_CHANGE_POLICY_VERSION,
  CODE_CHANGE_RISK_LEVELS,
  evaluateCodeChange,
  normalizeCodeChangeDecision,
  normalizeCodeChangeInput,
  classifyChangedFile,
  summarizeFileFindings,
} = require('../lib/code-change-gate');

const CLEAN_REPO = Object.freeze({
  branch: 'v0.9.1/pr-ab3-code-change-gate',
  isMain: false,
  dirty: false,
  hasUntracked: false,
});

function makeInput(overrides = {}) {
  return {
    files: [
      {
        path: 'docs/notes.md',
        status: 'modified',
        changeType: 'docs',
        additions: 2,
        deletions: 1,
      },
    ],
    intent: 'update docs',
    operationType: 'patch',
    diffSummary: 'docs update',
    patchMetadata: {
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    },
    repoState: CLEAN_REPO,
    priorDecisions: {
      ab1: null,
      ab2: null,
    },
    metadata: {
      workspaceId: 'default',
    },
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return evaluateCodeChange(makeInput(overrides));
}

describe('AB3 code change gate core decisions', () => {
  it('docs-only clean change returns allow', () => {
    const result = makeResult();
    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
    assert.equal(result.allowed, true);
    assert.equal(result.canApply, true);
    assert.equal(result.canDryRun, true);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.LOW_RISK_DOCS_ONLY);
    assert.equal(result.risk.level, CODE_CHANGE_RISK_LEVELS.LOW);
  });

  it('tests-only clean change returns allow', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'test/code-change-gate.test.js',
          status: 'modified',
          changeType: 'test',
          additions: 8,
          deletions: 0,
        },
      ],
      intent: 'extend test coverage',
      diffSummary: 'tests only',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.LOW_RISK_TESTS_ONLY);
  });

  it('narrow helper change returns allow', () => {
    const finding = classifyChangedFile({
      path: 'lib/helpers/path-utils.js',
      status: 'modified',
      changeType: 'helper',
    });

    assert.equal(finding.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
    assert.equal(finding.reason, CODE_CHANGE_GATE_REASONS.NARROW_HELPER_CHANGE);

    const summary = summarizeFileFindings([finding]);
    assert.equal(summary.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
  });

  it('policy override can raise a narrow helper change to review', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'lib/helpers/path-utils.js',
          status: 'modified',
          changeType: 'helper',
          additions: 3,
          deletions: 1,
        },
      ],
      intent: 'narrow helper change',
      policyOverride: {
        minimumDecision: 'review',
      },
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    assert.equal(result.allowed, false);
    assert.equal(result.canDryRun, true);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.POLICY_OVERRIDE_REVIEW);
  });

  it('normal source edit returns review', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'lib/transformer.js',
          status: 'modified',
          changeType: 'source',
          additions: 22,
          deletions: 7,
        },
      ],
      intent: 'change runtime behavior',
      diffSummary: 'source edit',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.SOURCE_CHANGE_REQUIRES_REVIEW);
    assert.equal(result.risk.level, CODE_CHANGE_RISK_LEVELS.MEDIUM);
  });

  it('server.js change returns dry_run_only', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'server.js',
          status: 'modified',
          changeType: 'runtime',
        },
      ],
      intent: 'touch server entrypoint',
    }));

    assert.ok([CODE_CHANGE_GATE_DECISIONS.REVIEW, CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY].includes(result.decision));
    assert.equal(result.canApply, false);
    assert.equal(result.canDryRun, true);
  });

  it('kernel.js change returns dry_run_only', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'kernel.js',
          status: 'modified',
          changeType: 'runtime',
        },
      ],
      intent: 'touch kernel runtime',
    }));

    assert.ok([CODE_CHANGE_GATE_DECISIONS.REVIEW, CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY].includes(result.decision));
    assert.equal(result.canApply, false);
    assert.equal(result.canDryRun, true);
  });

  it('graph.js change returns dry_run_only', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'graph.js',
          status: 'modified',
          changeType: 'runtime',
        },
      ],
      intent: 'touch graph runtime',
    }));

    assert.ok([CODE_CHANGE_GATE_DECISIONS.REVIEW, CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY].includes(result.decision));
    assert.equal(result.canApply, false);
    assert.equal(result.canDryRun, true);
  });

  it('memory path change returns dry_run_only', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'lib/memory/cache.js',
          status: 'modified',
          changeType: 'memory',
        },
      ],
      intent: 'touch memory surface',
    }));

    assert.ok([CODE_CHANGE_GATE_DECISIONS.REVIEW, CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY].includes(result.decision));
    assert.equal(result.canApply, false);
    assert.equal(result.canDryRun, true);
  });

  it('package.json change returns review', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'package.json',
          status: 'modified',
          changeType: 'package',
        },
      ],
      intent: 'update dependency metadata',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.PACKAGE_MUTATION_REQUIRES_REVIEW);
  });

  it('package-lock.json change returns review', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'package-lock.json',
          status: 'modified',
          changeType: 'package',
        },
      ],
      intent: 'update lockfile',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.PACKAGE_MUTATION_REQUIRES_REVIEW);
  });

  it('workflow file change returns review', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: '.github/workflows/ci.yml',
          status: 'modified',
          changeType: 'workflow',
        },
      ],
      intent: 'adjust CI workflow',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.CI_WORKFLOW_CHANGE_REQUIRES_REVIEW);
  });

  it('deploy or release file change returns block', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'scripts/release.js',
          status: 'modified',
          changeType: 'source',
        },
      ],
      intent: 'adjust release automation',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.RELEASE_OR_DEPLOY_CHANGE_BLOCKED);
    assert.equal(result.canDryRun, false);
  });

  it('auto-merge or autopush logic returns block', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'scripts/automerge.js',
          status: 'modified',
          changeType: 'source',
        },
      ],
      intent: 'wire auto merge flow',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED);
  });

  it('secret-looking patch metadata returns block', () => {
    const token = 'sk-test-abcdef1234567890';
    const result = evaluateCodeChange(makeInput({
      patchMetadata: {
        fileCount: 1,
        totalAdditions: 2,
        totalDeletions: 1,
        apiKey: token,
      },
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.SECRET_CHANGE_BLOCKED);
    assert.ok(result.warnings.every(warning => !warning.includes(token)));
  });

  it('main branch write attempt returns block', () => {
    const result = evaluateCodeChange(makeInput({
      repoState: {
        branch: 'main',
        isMain: true,
        dirty: false,
        hasUntracked: false,
      },
      files: [
        {
          path: 'lib/transformer.js',
          status: 'modified',
          changeType: 'source',
        },
      ],
      intent: 'apply source edit on main',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.MAIN_BRANCH_WRITE_BLOCKED);
  });

  it('dirty root returns review', () => {
    const result = evaluateCodeChange(makeInput({
      repoState: {
        branch: 'v0.9.1/pr-ab3-code-change-gate',
        isMain: false,
        dirty: true,
        hasUntracked: false,
      },
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.DIRTY_REPO_REVIEW_REQUIRED);
  });

  it('empty file list returns review or block, not allow', () => {
    const result = evaluateCodeChange(makeInput({
      files: [],
      patchMetadata: {
        fileCount: 0,
        totalAdditions: 0,
        totalDeletions: 0,
      },
    }));

    assert.notEqual(result.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
    assert.equal(result.allowed, false);
    assert.ok([CODE_CHANGE_GATE_DECISIONS.REVIEW, CODE_CHANGE_GATE_DECISIONS.BLOCK].includes(result.decision));
  });

  it('malformed input does not crash and does not allow', () => {
    const normalized = normalizeCodeChangeInput(null);
    const result = evaluateCodeChange(null);

    assert.equal(normalized.malformed, true);
    assert.equal(result.ok, true);
    assert.equal(result.allowed, false);
    assert.notEqual(result.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
  });

  it('unknown operation type does not allow', () => {
    const result = evaluateCodeChange(makeInput({
      operationType: 'migrate',
      files: [
        {
          path: 'docs/notes.md',
          status: 'modified',
          changeType: 'docs',
        },
      ],
    }));

    assert.notEqual(result.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED);
  });

  it('broad file count triggers high risk', () => {
    const files = Array.from({ length: 7 }, (_, index) => ({
      path: `lib/source-${index}.js`,
      status: 'modified',
      changeType: 'source',
    }));

    const result = evaluateCodeChange(makeInput({
      files,
      patchMetadata: {
        fileCount: files.length,
        totalAdditions: 120,
        totalDeletions: 31,
      },
      intent: 'broad source refactor',
    }));

    assert.equal(result.risk.level, CODE_CHANGE_RISK_LEVELS.HIGH);
    assert.notEqual(result.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
    assert.equal(result.canApply, false);
  });

  it('cross-cutting changes trigger review or dry-run-only', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'lib/source-a.js',
          status: 'modified',
          changeType: 'source',
        },
        {
          path: 'package.json',
          status: 'modified',
          changeType: 'package',
        },
        {
          path: '.github/workflows/ci.yml',
          status: 'modified',
          changeType: 'workflow',
        },
      ],
      patchMetadata: {
        fileCount: 3,
        totalAdditions: 40,
        totalDeletions: 12,
      },
      intent: 'cross-cutting update',
    }));

    assert.ok([CODE_CHANGE_GATE_DECISIONS.REVIEW, CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY, CODE_CHANGE_GATE_DECISIONS.BLOCK].includes(result.decision));
    assert.notEqual(result.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
    assert.equal(result.canDryRun, true);
  });

  it('policy override can increase strictness', () => {
    const result = evaluateCodeChange(makeInput({
      policyOverride: {
        minimumDecision: 'review',
      },
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.POLICY_OVERRIDE_REVIEW);
  });

  it('policy override cannot downgrade critical to allow', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'scripts/release.js',
          status: 'modified',
          changeType: 'source',
        },
      ],
      policyOverride: {
        minimumDecision: 'allow',
      },
      intent: 'critical release flow',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, CODE_CHANGE_GATE_REASONS.RELEASE_OR_DEPLOY_CHANGE_BLOCKED);
  });

  it('dry-run-only sets canApply false and canDryRun true', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'server.js',
          status: 'modified',
          changeType: 'runtime',
        },
      ],
      intent: 'preview server runtime edit',
    }));

    assert.equal(result.canApply, false);
    assert.equal(result.canDryRun, true);
    assert.ok([CODE_CHANGE_GATE_DECISIONS.REVIEW, CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY].includes(result.decision));
  });

  it('block sets allowed false, canApply false, and canDryRun false', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'scripts/automerge.js',
          status: 'modified',
          changeType: 'source',
        },
      ],
      intent: 'blockable automation',
    }));

    assert.equal(result.decision, CODE_CHANGE_GATE_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
    assert.equal(result.canApply, false);
    assert.equal(result.canDryRun, false);
  });

  it('gate never executes provided callback', () => {
    let called = false;
    const result = evaluateCodeChange(makeInput({
      callback: () => {
        called = true;
      },
    }));

    assert.equal(called, false);
    assert.equal(result.allowed, true);
  });

  it('same input produces the same output', () => {
    const input = makeInput({
      files: [
        {
          path: 'docs/guide.md',
          status: 'modified',
          changeType: 'docs',
          additions: 4,
          deletions: 0,
        },
      ],
      intent: 'update docs',
    });

    assert.deepEqual(evaluateCodeChange(input), evaluateCodeChange(input));
  });

  it('warnings do not contain raw token or API key', () => {
    const token = 'sk-test-abc1234567890xyz';
    const result = evaluateCodeChange(makeInput({
      patchMetadata: {
        fileCount: 1,
        apiKey: token,
      },
      intent: 'sensitive metadata check',
    }));

    assert.ok(result.warnings.every(warning => !warning.includes(token)));
  });

  it('fileFindings include per-file reasons', () => {
    const result = evaluateCodeChange(makeInput({
      files: [
        {
          path: 'docs/guide.md',
          status: 'modified',
          changeType: 'docs',
        },
        {
          path: 'lib/transformer.js',
          status: 'modified',
          changeType: 'source',
        },
      ],
      intent: 'mixed change',
    }));

    assert.equal(result.fileFindings.length, 2);
    assert.ok(result.fileFindings.every(finding => typeof finding.reason === 'string' && finding.reason.length > 0));
    assert.ok(result.fileFindings.some(finding => finding.reason === CODE_CHANGE_GATE_REASONS.SOURCE_CHANGE_REQUIRES_REVIEW));
  });

  it('output shape is stable', () => {
    const result = evaluateCodeChange(makeInput());

    assert.deepEqual(Object.keys(result), [
      'ok',
      'allowed',
      'canApply',
      'canDryRun',
      'decision',
      'reason',
      'risk',
      'requiredReview',
      'dryRunOnly',
      'fileFindings',
      'warnings',
      'metadata',
    ]);
    assert.deepEqual(Object.keys(result.risk), ['level', 'score', 'categories']);
    assert.deepEqual(Object.keys(result.metadata), ['policyVersion', 'workspaceId']);
    assert.equal(result.metadata.policyVersion, CODE_CHANGE_POLICY_VERSION);
    assert.deepEqual(Object.keys(result.fileFindings[0]), [
      'ok',
      'path',
      'status',
      'changeType',
      'category',
      'riskLevel',
      'riskScore',
      'decision',
      'reason',
      'notes',
      'sensitive',
    ]);
  });

  it('normalizeCodeChangeDecision canonicalizes malformed objects', () => {
    const normalized = normalizeCodeChangeDecision({
      decision: 'ALLOW',
      reason: 'LOW_RISK_DOCS_ONLY',
      risk: {
        level: 'LOW',
        score: 0.1,
        categories: ['docs'],
      },
      metadata: {
        policyVersion: 'AB3-v9.9.9',
        workspaceId: 'ws-a',
      },
      fileFindings: [
        {
          path: 'docs/guide.md',
          status: 'modified',
          changeType: 'docs',
          category: 'docs',
          riskLevel: 'low',
          riskScore: 0.1,
          decision: 'ALLOW',
          reason: 'LOW_RISK_DOCS_ONLY',
          notes: ['ok'],
          sensitive: false,
        },
      ],
      warnings: ['ok'],
    });

    assert.equal(normalized.decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
    assert.equal(normalized.metadata.workspaceId, 'ws-a');
    assert.equal(normalized.metadata.policyVersion, 'AB3-v9.9.9');
    assert.equal(normalized.fileFindings[0].decision, CODE_CHANGE_GATE_DECISIONS.ALLOW);
  });
});
