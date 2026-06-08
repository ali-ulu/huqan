'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  AUTOMATION_SAFETY_DECISIONS,
  AUTOMATION_SAFETY_REASONS,
  AUTOMATION_SAFETY_POLICY_VERSION,
  AUTOMATION_RISK_LEVELS,
  evaluateAutomationSafety,
  normalizeAutomationSafetyDecision,
  normalizeAutomationSafetyInput,
  classifyAutomationOperation,
  summarizeAutomationFindings,
} = require('../lib/automation-safety-gate');

const CLEAN_REPO = Object.freeze({
  branch: 'v0.9.1/pr-ab5-automation-safety-gate',
  baseBranch: 'main',
  isMain: false,
  dirty: false,
  hasUntracked: false,
  protected: false,
  baseIsMain: true,
});

function makeInput(overrides = {}) {
  return {
    operationType: 'status_check',
    target: 'pull request status',
    actor: 'human',
    branch: 'feature/ab5',
    baseBranch: 'main',
    repoState: CLEAN_REPO,
    approval: null,
    ci: {
      status: 'green',
      preview: false,
    },
    release: {
      preview: false,
    },
    deploy: {
      preview: false,
    },
    github: {
      permissions: {
        pull: true,
      },
    },
    token: '',
    priorDecisions: {
      ab2: null,
      ab3: null,
      ab4: null,
    },
    metadata: {
      workspaceId: 'default',
    },
    ...overrides,
  };
}

function evaluate(overrides = {}, options = {}) {
  return evaluateAutomationSafety(makeInput(overrides), options);
}

describe('AB5 automation safety gate core decisions', () => {
  it('read-only PR status check returns allow', () => {
    const result = evaluate({
      operationType: 'status_check',
      target: 'pull request status',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(result.allowed, true);
    assert.equal(result.canExecute, true);
    assert.equal(result.canDryRun, true);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.LOW_RISK_READ_ONLY);
    assert.equal(result.risk.level, AUTOMATION_RISK_LEVELS.LOW);
  });

  it('read-only CI inspection returns allow', () => {
    const result = evaluate({
      operationType: 'ci_inspection',
      target: 'check ci status',
      ci: {
        status: 'success',
        preview: false,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.LOW_RISK_CI_INSPECTION);
  });

  it('unknown operation does not allow', () => {
    const result = evaluate({
      operationType: 'unknown',
      target: 'something ambiguous',
    });

    assert.notEqual(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED);
  });

  it('malformed input does not crash and does not allow', () => {
    const result = evaluateAutomationSafety(null);

    assert.equal(result.ok, true);
    assert.notEqual(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED);
  });

  it('auto-merge returns block', () => {
    const result = evaluate({
      operationType: 'auto_merge',
      github: {
        autoMergeEnabled: true,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.ENABLE_AUTO_MERGE_BLOCKED);
  });

  it('enable auto-merge returns block', () => {
    const result = evaluate({
      operationType: 'enable_auto_merge',
      github: {
        autoMergeEnabled: true,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.ENABLE_AUTO_MERGE_BLOCKED);
  });

  it('merge PR without approval returns block', () => {
    const result = evaluate({
      operationType: 'merge_pr',
      target: 'pull request #7',
      approval: {
        explicit: false,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.MERGE_REQUIRES_APPROVAL);
  });

  it('local merge push without approval returns block', () => {
    const result = evaluate({
      operationType: 'local_merge_push',
      target: 'main',
      approval: {
        explicit: false,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.LOCAL_MERGE_PUSH_REQUIRES_APPROVAL);
  });

  it('local merge push with explicit approval can return review', () => {
    const result = evaluate({
      operationType: 'local_merge_push',
      target: 'main',
      approval: {
        explicit: true,
        mergeApproved: true,
        reviewedBy: 'ali',
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.LOCAL_MERGE_PUSH_REQUIRES_APPROVAL);
  });

  it('deploy without approval returns block', () => {
    const result = evaluate({
      operationType: 'deploy',
      target: 'production',
      deploy: {
        preview: false,
      },
      approval: {
        explicit: false,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.DEPLOY_REQUIRES_APPROVAL);
  });

  it('deploy preview returns dry_run_only', () => {
    const result = evaluate({
      operationType: 'deploy',
      target: 'production',
      deploy: {
        preview: true,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.DEPLOY_PREVIEW_ONLY);
    assert.equal(result.allowed, false);
    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, true);
  });

  it('tag/release without approval returns block', () => {
    const result = evaluate({
      operationType: 'tag_release',
      target: 'v1.2.3',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.RELEASE_REQUIRES_APPROVAL);
  });

  it('release notes preview returns allow', () => {
    const result = evaluate({
      operationType: 'release_notes_preview',
      target: 'release notes',
      release: {
        preview: true,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.RELEASE_PREVIEW_ONLY);
  });

  it('force push returns block', () => {
    const result = evaluate({
      operationType: 'force_push',
      target: 'main',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.FORCE_PUSH_BLOCKED);
  });

  it('history rewrite returns block', () => {
    const result = evaluate({
      operationType: 'history_rewrite',
      target: 'feature/ab5',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.HISTORY_REWRITE_BLOCKED);
  });

  it('branch protection bypass returns block', () => {
    const result = evaluate({
      operationType: 'branch_protection_change',
      target: 'protect main',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.BRANCH_PROTECTION_BYPASS_BLOCKED);
  });

  it('CI bypass returns block', () => {
    const result = evaluate({
      operationType: 'ci_bypass',
      target: 'skip checks',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.CI_BYPASS_BLOCKED);
  });

  it('workflow dispatch returns review', () => {
    const result = evaluate({
      operationType: 'workflow_dispatch',
      target: '.github/workflows/deploy.yml',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.WORKFLOW_DISPATCH_REVIEW_REQUIRED);
  });

  it('workflow abuse returns block', () => {
    const result = evaluate({
      operationType: 'workflow_abuse',
      target: 'abuse workflow',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.WORKFLOW_ABUSE_BLOCKED);
  });

  it('destructive cleanup returns block', () => {
    const result = evaluate({
      operationType: 'destructive_cleanup',
      target: 'rm -rf .github',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.DESTRUCTIVE_CLEANUP_BLOCKED);
  });

  it('token persistence returns block', () => {
    const result = evaluate({
      operationType: 'token_persistence',
      metadata: {
        workspaceId: 'default',
        note: 'store token in repo',
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.TOKEN_PERSISTENCE_BLOCKED);
  });

  it('secret-looking metadata does not leak in warnings', () => {
    const secret = 'sk-1234567890abcdef';
    const result = evaluate({
      operationType: 'repo_settings_change',
      metadata: {
        workspaceId: 'default',
        apiKey: secret,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    assert.ok(result.warnings.every(warning => !String(warning).includes(secret)));
    assert.ok(result.warnings.every(warning => !String(warning).toLowerCase().includes('sk-')));
  });

  it('push to main without approved context returns block', () => {
    const result = evaluate({
      operationType: 'push_to_main',
      target: 'main',
      repoState: {
        branch: 'feature/ab5',
        baseBranch: 'main',
        isMain: false,
        dirty: false,
        hasUntracked: false,
        protected: false,
        baseIsMain: true,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.PUSH_TO_MAIN_BLOCKED);
  });

  it('branch delete returns review', () => {
    const result = evaluate({
      operationType: 'branch_delete',
      target: 'feature/ab5',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.BRANCH_DELETE_REVIEW_REQUIRED);
  });

  it('repo settings change returns review', () => {
    const result = evaluate({
      operationType: 'repo_settings_change',
      target: 'repository settings',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.REPO_SETTINGS_CHANGE_REVIEW_REQUIRED);
  });

  it('policy override can increase strictness', () => {
    const result = evaluate({
      operationType: 'status_check',
      policyOverride: {
        minimumDecision: 'review',
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.POLICY_OVERRIDE_REVIEW);
  });

  it('policy override cannot downgrade critical to allow', () => {
    const result = evaluate({
      operationType: 'force_push',
      policyOverride: {
        minimumDecision: 'allow',
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.FORCE_PUSH_BLOCKED);
  });

  it('dry-run-only sets canExecute false and canDryRun true', () => {
    const result = evaluate({
      operationType: 'deploy',
      deploy: {
        preview: true,
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY);
    assert.equal(result.allowed, false);
    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, true);
  });

  it('block sets allowed false and canDryRun false', () => {
    const result = evaluate({
      operationType: 'force_push',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, false);
  });

  it('gate never executes provided callback', () => {
    let called = false;
    const result = evaluate({
      operationType: 'status_check',
      operation: {
        run: () => {
          called = true;
        },
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(called, false);
  });

  it('same input produces same output', () => {
    const input = makeInput({
      operationType: 'local_merge_push',
      target: 'main',
      approval: {
        explicit: true,
        mergeApproved: true,
        reviewedBy: 'ali',
      },
    });

    const first = evaluateAutomationSafety(input);
    const second = evaluateAutomationSafety(input);

    assert.deepStrictEqual(first, second);
  });

  it('findings include per-risk reasons and summary is deterministic', () => {
    const input = makeInput({
      operationType: 'deploy',
      deploy: {
        preview: true,
      },
    });

    const first = evaluateAutomationSafety(input);
    const second = evaluateAutomationSafety(input);

    assert.deepStrictEqual(first, second);
    assert.ok(first.findings.every(finding => typeof finding.reason === 'string' && finding.reason.length > 0));
    assert.ok(first.findings.every(finding => typeof finding.decision === 'string'));

    const summary = summarizeAutomationFindings(first.findings);
    assert.ok(typeof summary.reason === 'string' && summary.reason.length > 0);
    assert.ok(Array.isArray(summary.categories));
  });

  it('normalizeAutomationSafetyDecision keeps output shape stable', () => {
    const normalized = normalizeAutomationSafetyDecision({
      ok: true,
      allowed: false,
      canExecute: false,
      canDryRun: true,
      decision: 'review',
      reason: 'TEST_REASON',
      risk: {
        level: 'medium',
        score: 0.55,
        categories: ['deploy', 'deploy', 'repository_mutation'],
      },
      requiredReview: true,
      dryRunOnly: false,
      findings: [
        {
          ok: true,
          id: 'automation',
          operationType: 'deploy',
          target: 'production',
          actor: 'ali',
          branch: 'feature/ab5',
          baseBranch: 'main',
          category: 'deploy',
          riskLevel: 'high',
          riskScore: 0.8,
          decision: 'dry_run_only',
          reason: 'DEPLOY_PREVIEW_ONLY',
          notes: ['Deploy preview can be generated safely, but execution must wait.'],
          sensitive: false,
          explicitApproval: false,
          previewRequested: true,
        },
      ],
      warnings: ['test warning'],
      metadata: {
        policyVersion: 'AB5-v0.1.0',
        workspaceId: 'default',
      },
    });

    assert.equal(normalized.decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    assert.equal(normalized.allowed, false);
    assert.equal(normalized.canExecute, false);
    assert.equal(normalized.canDryRun, true);
    assert.equal(normalized.risk.level, AUTOMATION_RISK_LEVELS.MEDIUM);
    assert.deepStrictEqual(normalized.risk.categories, ['deploy', 'repository_mutation']);
    assert.equal(normalized.metadata.policyVersion, AUTOMATION_SAFETY_POLICY_VERSION);
    assert.equal(normalized.metadata.workspaceId, 'default');
    assert.equal(normalized.findings.length, 1);
  });

  it('output shape is stable', () => {
    const result = evaluate({
      operationType: 'status_check',
      target: 'pull request status',
    });

    assert.deepStrictEqual(Object.keys(result), [
      'ok',
      'allowed',
      'canExecute',
      'canDryRun',
      'decision',
      'reason',
      'risk',
      'requiredReview',
      'dryRunOnly',
      'findings',
      'warnings',
      'metadata',
    ]);
    assert.deepStrictEqual(Object.keys(result.risk), ['level', 'score', 'categories']);
    assert.deepStrictEqual(Object.keys(result.metadata), ['policyVersion', 'workspaceId']);
  });
});
