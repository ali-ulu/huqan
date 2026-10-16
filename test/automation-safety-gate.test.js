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

  it('an unclassified operation is not waved through as read-only merely because unrelated words contain "read" (#450)', () => {
    // 'already' and 'ready' both contain the READ_ONLY hint 'read' as a
    // substring, with no other hint word present anywhere in the text. A
    // naive .includes() match would classify this unrecognized, potentially
    // mutating operation as LOW_RISK_READ_ONLY / ALLOW purely from that
    // incidental substring, instead of falling through to review.
    const result = evaluate({
      operationType: 'execute_task',
      target: 'already indexed, ready to run script',
    });

    assert.notEqual(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED);
  });

  it('an unclassified operation whose text contains "checkout" is not read as the "check" hint (#450)', () => {
    // 'checkout' contains the READ_ONLY hint 'check' as a substring, with no
    // other hint word present.
    const result = evaluate({
      operationType: 'execute_task',
      target: 'run checkout script for staging environment',
    });

    assert.notEqual(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED);
  });

  it('"bread crumbs" style substrings of a hint word do not trigger the hint', () => {
    const result = evaluate({
      operationType: 'status_check',
      target: 'show bread crumbs navigation status',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.LOW_RISK_READ_ONLY);
  });

  it('a genuine read-only status check with the real word "read" still allows', () => {
    const result = evaluate({
      operationType: 'status_check',
      target: 'read pull request status',
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.ALLOW);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.LOW_RISK_READ_ONLY);
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

  it('secret-looking metadata escalates to block and does not leak in warnings (#402)', () => {
    const secret = 'sk-1234567890abcdef';
    const result = evaluate({
      operationType: 'repo_settings_change',
      metadata: {
        workspaceId: 'default',
        apiKey: secret,
      },
    });

    // #402: a detected secret escalates all the way to BLOCK, not just
    // ALLOW->REVIEW -- a secret in flight is not something to merely review.
    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.SECRET_DETECTED_BLOCKED);
    assert.ok(result.warnings.every(warning => !String(warning).includes(secret)));
    assert.ok(result.warnings.every(warning => !String(warning).toLowerCase().includes('sk-')));
  });

  it('secret detection never downgrades an operation that was already block (#402)', () => {
    // Detected by key name (apiKey is in SECRET_HINTS), not value shape --
    // deliberately not a plausible-looking key/token value.
    const result = evaluate({
      operationType: 'token_persistence',
      metadata: {
        workspaceId: 'default',
        apiKey: 'placeholder-not-a-real-credential',
      },
    });

    assert.equal(result.decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    // The operation's own reason is preserved rather than overwritten by the
    // secret-detection reason, since it was already at BLOCK on its own.
    assert.equal(result.reason, AUTOMATION_SAFETY_REASONS.TOKEN_PERSISTENCE_BLOCKED);
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

  it('maps decision severity monotonically for dry-run and review findings', () => {
    const finding = (decision, id) => ({
      id,
      operationType: 'test',
      category: 'test',
      decision,
      reason: `${id}_REASON`,
    });

    const dryRun = summarizeAutomationFindings([finding(AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY, 'dry-run')]);
    assert.equal(dryRun.decision, AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY);
    assert.equal(dryRun.riskLevel, 'medium');
    assert.equal(dryRun.riskScore, 0.55);
    assert.equal(dryRun.hasHighRisk, false);

    const review = summarizeAutomationFindings([finding(AUTOMATION_SAFETY_DECISIONS.REVIEW, 'review')]);
    assert.equal(review.decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    assert.equal(review.riskLevel, 'high');
    assert.equal(review.riskScore, 0.8);
    assert.equal(review.hasHighRisk, true);

    const combined = summarizeAutomationFindings([
      finding(AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY, 'dry-run'),
      finding(AUTOMATION_SAFETY_DECISIONS.REVIEW, 'review'),
    ]);
    assert.equal(combined.decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    assert.equal(combined.riskLevel, 'high');
    assert.equal(combined.riskScore, 0.8);
    assert.equal(combined.hasHighRisk, true);
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
