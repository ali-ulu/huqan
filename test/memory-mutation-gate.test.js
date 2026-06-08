'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  MEMORY_MUTATION_POLICY_VERSION,
  MEMORY_MUTATION_RISK_LEVELS,
  evaluateMemoryMutation,
  normalizeMemoryMutationDecision,
  normalizeMemoryMutationInput,
  classifyMemoryMutation,
  summarizeMemoryMutationFindings,
} = require('../lib/memory-mutation-gate');

const CLEAN_REPO = Object.freeze({
  branch: 'v0.9.1/pr-ab4-memory-mutation-gate',
  isMain: false,
  dirty: false,
  hasUntracked: false,
});

function makeEntry(overrides = {}) {
  return {
    id: 'mem_001',
    action: 'inspect',
    changeType: 'read',
    scope: 'default',
    workspaceId: 'default',
    contentChanged: false,
    linksChanged: false,
    auditChanged: false,
    deleted: false,
    tombstoned: false,
    superseded: false,
    metadataOnly: true,
    ...overrides,
  };
}

function makeInput(overrides = {}) {
  return {
    entries: [makeEntry()],
    operationType: 'read',
    mutationType: 'memory',
    targetSpace: 'default',
    diffSummary: 'read memory state',
    mutationMetadata: {
      entryCount: 1,
      patchCount: 0,
      linkCount: 0,
      auditCount: 0,
      workspaceCount: 1,
      crossWorkspaceCount: 0,
      contentCount: 0,
      graphCount: 0,
    },
    repoState: CLEAN_REPO,
    priorDecisions: {
      ab1: null,
      ab2: null,
      ab3: null,
    },
    metadata: {
      workspaceId: 'default',
    },
    ...overrides,
  };
}

function evaluate(overrides = {}, options = {}) {
  return evaluateMemoryMutation(makeInput(overrides), options);
}

describe('AB4 memory mutation gate core decisions', () => {
  it('read-only inspection returns allow', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'inspect',
          changeType: 'read',
          contentChanged: false,
          linksChanged: false,
          auditChanged: false,
        }),
      ],
      operationType: 'read',
      diffSummary: 'inspect current memory state',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.ALLOW);
    assert.equal(result.allowed, true);
    assert.equal(result.canApply, true);
    assert.equal(result.canDryRun, true);
    assert.equal(result.requiredReview, false);
    assert.equal(result.dryRunOnly, false);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.LOW_RISK_MEMORY_INSPECTION);
    assert.equal(result.risk.level, MEMORY_MUTATION_RISK_LEVELS.LOW);
    assert.equal(result.metadata.policyVersion, MEMORY_MUTATION_POLICY_VERSION);
  });

  it('metadata-only memory change returns allow', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'annotate',
          changeType: 'metadata',
          metadataOnly: true,
        }),
      ],
      operationType: 'update',
      diffSummary: 'metadata note only',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.ALLOW);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.LOW_RISK_METADATA_ONLY);
  });

  it('narrow note or link change does not become allow', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'link',
          changeType: 'graph',
          linksChanged: true,
          metadataOnly: false,
        }),
      ],
      operationType: 'write',
      diffSummary: 'link two memories',
    });

    assert.notEqual(result.decision, MEMORY_MUTATION_GATE_DECISIONS.ALLOW);
    assert.ok([
      MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY,
      MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
    ].includes(result.decision));
    assert.equal(result.findings[0].reason, MEMORY_MUTATION_GATE_REASONS.GRAPH_MUTATION_REQUIRES_REVIEW);
  });

  it('content edit returns review', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'update',
          changeType: 'content',
          contentChanged: true,
          metadataOnly: false,
        }),
      ],
      operationType: 'write',
      diffSummary: 'edit memory content',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.CONTENT_EDIT_REQUIRES_REVIEW);
    assert.equal(result.risk.level, MEMORY_MUTATION_RISK_LEVELS.MEDIUM);
  });

  it('canonical graph mutation cannot allow', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'supersede',
          changeType: 'graph',
          linksChanged: true,
          metadataOnly: false,
        }),
      ],
      operationType: 'write',
      diffSummary: 'supersede one memory',
    });

    assert.notEqual(result.decision, MEMORY_MUTATION_GATE_DECISIONS.ALLOW);
    assert.ok(result.decision === MEMORY_MUTATION_GATE_DECISIONS.REVIEW || result.decision === MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY || result.decision === MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.GRAPH_MUTATION_REQUIRES_REVIEW);
    assert.equal(result.risk.level, MEMORY_MUTATION_RISK_LEVELS.MEDIUM);
  });

  it('tombstone path does not allow', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'tombstone',
          changeType: 'graph',
          tombstoned: true,
        }),
      ],
      operationType: 'write',
      diffSummary: 'tombstone old memory',
    });

    assert.notEqual(result.decision, MEMORY_MUTATION_GATE_DECISIONS.ALLOW);
    assert.ok([
      MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY,
      MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
    ].includes(result.decision));
  });

  it('delete memory path blocks', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'delete',
          changeType: 'content',
          deleted: true,
        }),
      ],
      operationType: 'write',
      diffSummary: 'delete memory entry',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.AUDIT_REWRITE_OR_DELETE_BLOCKED);
    assert.equal(result.allowed, false);
    assert.equal(result.canApply, false);
    assert.equal(result.canDryRun, false);
  });

  it('audit rewrite or delete blocks', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'audit-delete',
          changeType: 'audit',
          auditChanged: true,
        }),
      ],
      operationType: 'write',
      diffSummary: 'rewrite audit trail',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.AUDIT_REWRITE_OR_DELETE_BLOCKED);
  });

  it('cross-workspace mutation blocks', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'upsert',
          changeType: 'content',
          workspaceId: 'other-workspace',
          scope: 'other-workspace',
          contentChanged: true,
        }),
      ],
      targetSpace: 'default',
      metadata: {
        workspaceId: 'default',
      },
      operationType: 'write',
      diffSummary: 'cross workspace mutation',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.CROSS_WORKSPACE_MUTATION_BLOCKED);
  });

  it('package or import changes require review', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'import',
          changeType: 'package',
        }),
      ],
      operationType: 'write',
      diffSummary: 'memory import sync',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.PACKAGE_OR_IMPORT_REQUIRES_REVIEW);
  });

  it('workflow or sync style mutation requires review', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'sync',
          changeType: 'workflow',
        }),
      ],
      operationType: 'write',
      diffSummary: 'memory sync workflow',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.PACKAGE_OR_IMPORT_REQUIRES_REVIEW);
  });

  it('release or deploy memory mutation blocks', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'deploy',
          changeType: 'memory',
        }),
      ],
      operationType: 'write',
      diffSummary: 'deploy memory change',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.RELEASE_OR_DEPLOY_MUTATION_BLOCKED);
  });

  it('auto-merge or autopush memory logic blocks', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'auto-merge',
          changeType: 'memory',
        }),
      ],
      operationType: 'write',
      diffSummary: 'auto merge memory change',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED);
  });

  it('secret-looking mutation metadata blocks without leaking secrets', () => {
    const secret = 'sk-1234567890abcdef';
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'upsert',
          changeType: 'content',
          metadataOnly: false,
        }),
      ],
      mutationMetadata: {
        entryCount: 1,
        token: secret,
      },
      diffSummary: 'store secret token',
      operationType: 'write',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.SECRET_MUTATION_BLOCKED);
    assert.ok(result.warnings.every(warning => !String(warning).includes(secret)));
    assert.ok(result.warnings.every(warning => !String(warning).toLowerCase().includes('sk-')));
  });

  it('main branch write attempt blocks', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'write',
          changeType: 'content',
          contentChanged: true,
        }),
      ],
      operationType: 'write',
      repoState: {
        branch: 'main',
        isMain: true,
        dirty: false,
        hasUntracked: false,
      },
      diffSummary: 'write on main',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.MAIN_BRANCH_WRITE_BLOCKED);
  });

  it('dirty root returns review and does not allow', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'inspect',
          changeType: 'read',
        }),
      ],
      repoState: {
        branch: 'feature/memory',
        isMain: false,
        dirty: true,
        hasUntracked: true,
      },
      diffSummary: 'dirty repo inspection',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.DIRTY_REPO_REVIEW_REQUIRED);
  });

  it('empty entry list requires review', () => {
    const result = evaluate({
      entries: [],
      operationType: 'write',
      diffSummary: 'no entries provided',
    });

    assert.notEqual(result.decision, MEMORY_MUTATION_GATE_DECISIONS.ALLOW);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.EMPTY_ENTRY_LIST_REVIEW_REQUIRED);
  });

  it('malformed input does not crash and does not allow', () => {
    const result = evaluateMemoryMutation(null);

    assert.equal(result.ok, true);
    assert.notEqual(result.decision, MEMORY_MUTATION_GATE_DECISIONS.ALLOW);
    assert.ok([
      MEMORY_MUTATION_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED,
      MEMORY_MUTATION_GATE_REASONS.EMPTY_ENTRY_LIST_REVIEW_REQUIRED,
    ].includes(result.reason));
  });

  it('unknown operation type does not allow', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'inspect',
          changeType: 'read',
        }),
      ],
      operationType: 'unknown',
      diffSummary: 'unknown operation',
    });

    assert.notEqual(result.decision, MEMORY_MUTATION_GATE_DECISIONS.ALLOW);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED);
  });

  it('broad read-only mutation becomes dry_run_only', () => {
    const entries = Array.from({ length: 8 }, (_, index) => makeEntry({
      id: `mem_${String(index + 1).padStart(3, '0')}`,
      action: 'inspect',
      changeType: 'read',
    }));

    const result = evaluate({
      entries,
      operationType: 'read',
      mutationMetadata: {
        entryCount: 8,
        graphCount: 3,
        linkCount: 0,
        workspaceCount: 1,
        crossWorkspaceCount: 0,
      },
      diffSummary: 'broad read-only memory sweep',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY);
    assert.equal(result.allowed, false);
    assert.equal(result.canApply, false);
    assert.equal(result.canDryRun, true);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.BREADTH_REVIEW_REQUIRED);
    assert.equal(result.risk.level, MEMORY_MUTATION_RISK_LEVELS.HIGH);
  });

  it('policy override can increase strictness', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'inspect',
          changeType: 'read',
        }),
      ],
      operationType: 'read',
      policyOverride: {
        minimumDecision: 'review',
      },
      diffSummary: 'policy raised review',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.POLICY_OVERRIDE_REVIEW);
    assert.equal(result.allowed, false);
  });

  it('policy override cannot downgrade critical to allow', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'delete',
          changeType: 'content',
          deleted: true,
        }),
      ],
      operationType: 'write',
      policyOverride: {
        minimumDecision: 'allow',
      },
      diffSummary: 'critical delete with permissive policy',
    });

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.AUDIT_REWRITE_OR_DELETE_BLOCKED);
  });

  it('normalizeMemoryMutationDecision keeps output shape stable', () => {
    const normalized = normalizeMemoryMutationDecision({
      ok: true,
      allowed: false,
      canApply: false,
      canDryRun: true,
      decision: 'review',
      reason: 'TEST_REASON',
      risk: {
        level: 'medium',
        score: 0.55,
        categories: ['memory_write', 'memory_write', 'audit'],
      },
      requiredReview: true,
      dryRunOnly: false,
      findings: [
        {
          ok: true,
          id: 'mem_001',
          action: 'inspect',
          changeType: 'read',
          scope: 'default',
          workspaceId: 'default',
          targetSpace: 'default',
          category: 'read_only',
          riskLevel: 'low',
          riskScore: 0.15,
          decision: 'allow',
          reason: 'LOW_RISK_MEMORY_INSPECTION',
          notes: ['Read-only memory inspection.'],
          sensitive: false,
          contentChanged: false,
          linksChanged: false,
          auditChanged: false,
        },
      ],
      warnings: ['test warning'],
      metadata: {
        policyVersion: 'AB4-v0.1.0',
        workspaceId: 'default',
      },
    });

    assert.equal(normalized.decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    assert.equal(normalized.allowed, false);
    assert.equal(normalized.canApply, false);
    assert.equal(normalized.canDryRun, true);
    assert.equal(normalized.risk.level, MEMORY_MUTATION_RISK_LEVELS.MEDIUM);
    assert.deepStrictEqual(normalized.risk.categories, ['audit', 'memory_write']);
    assert.equal(normalized.metadata.policyVersion, MEMORY_MUTATION_POLICY_VERSION);
    assert.equal(normalized.metadata.workspaceId, 'default');
    assert.equal(normalized.findings.length, 1);
  });

  it('findings include per-entry reasons and summary is deterministic', () => {
    const input = makeInput({
      entries: [
        makeEntry({
          id: 'mem_b',
          action: 'update',
          changeType: 'content',
          contentChanged: true,
          metadataOnly: false,
        }),
        makeEntry({
          id: 'mem_a',
          action: 'inspect',
          changeType: 'read',
        }),
      ],
      operationType: 'write',
      diffSummary: 'mixed memory entries',
    });

    const first = evaluateMemoryMutation(input);
    const second = evaluateMemoryMutation(input);

    assert.deepStrictEqual(first, second);
    assert.ok(first.findings.every(finding => typeof finding.reason === 'string' && finding.reason.length > 0));
    assert.ok(first.findings.every(finding => typeof finding.decision === 'string'));

    const summary = summarizeMemoryMutationFindings(first.findings);
    assert.ok(typeof summary.reason === 'string' && summary.reason.length > 0);
    assert.ok(Array.isArray(summary.categories));
  });

  it('output shape is stable', () => {
    const result = evaluate({
      entries: [
        makeEntry({
          action: 'inspect',
          changeType: 'read',
        }),
      ],
      operationType: 'read',
      diffSummary: 'shape check',
    });

    assert.deepStrictEqual(Object.keys(result), [
      'ok',
      'allowed',
      'canApply',
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
