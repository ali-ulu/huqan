'use strict';

const MEMORY_MUTATION_GATE_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
  DRY_RUN_ONLY: 'dry_run_only',
});

const MEMORY_MUTATION_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const MEMORY_MUTATION_GATE_REASONS = Object.freeze({
  LOW_RISK_MEMORY_INSPECTION: 'LOW_RISK_MEMORY_INSPECTION',
  LOW_RISK_METADATA_ONLY: 'LOW_RISK_METADATA_ONLY',
  NARROW_NOTE_OR_LINK_CHANGE: 'NARROW_NOTE_OR_LINK_CHANGE',
  CONTENT_EDIT_REQUIRES_REVIEW: 'CONTENT_EDIT_REQUIRES_REVIEW',
  GRAPH_MUTATION_REQUIRES_REVIEW: 'GRAPH_MUTATION_REQUIRES_REVIEW',
  CANONICAL_GRAPH_MUTATION_BLOCKED: 'CANONICAL_GRAPH_MUTATION_BLOCKED',
  AUDIT_REWRITE_OR_DELETE_BLOCKED: 'AUDIT_REWRITE_OR_DELETE_BLOCKED',
  CROSS_WORKSPACE_MUTATION_BLOCKED: 'CROSS_WORKSPACE_MUTATION_BLOCKED',
  SECRET_MUTATION_BLOCKED: 'SECRET_MUTATION_BLOCKED',
  PACKAGE_OR_IMPORT_REQUIRES_REVIEW: 'PACKAGE_OR_IMPORT_REQUIRES_REVIEW',
  SYNC_OR_REBUILD_REQUIRES_REVIEW: 'SYNC_OR_REBUILD_REQUIRES_REVIEW',
  RELEASE_OR_DEPLOY_MUTATION_BLOCKED: 'RELEASE_OR_DEPLOY_MUTATION_BLOCKED',
  AUTO_MERGE_OR_AUTOPUSH_BLOCKED: 'AUTO_MERGE_OR_AUTOPUSH_BLOCKED',
  EMPTY_ENTRY_LIST_REVIEW_REQUIRED: 'EMPTY_ENTRY_LIST_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED: 'UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED',
  DIRTY_REPO_REVIEW_REQUIRED: 'DIRTY_REPO_REVIEW_REQUIRED',
  MAIN_BRANCH_WRITE_BLOCKED: 'MAIN_BRANCH_WRITE_BLOCKED',
  BREADTH_REVIEW_REQUIRED: 'BREADTH_REVIEW_REQUIRED',
  CROSS_CUTTING_CHANGE_REVIEW_REQUIRED: 'CROSS_CUTTING_CHANGE_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
});

const MEMORY_MUTATION_POLICY_VERSION = 'AB4-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';
const BREADTH_REVIEW_THRESHOLD = 5;
const BREADTH_DRY_RUN_THRESHOLD = 8;

const SECRET_HINTS = Object.freeze([
  'api key',
  'apikey',
  'api_key',
  'api-key',
  'token',
  'secret',
  'password',
  'passwd',
  'bearer',
  'credential',
  'private key',
  '.env',
  'id_rsa',
  'client secret',
]);

const READ_ACTIONS = Object.freeze([
  'read',
  'inspect',
  'list',
  'query',
  'search',
  'view',
  'show',
  'open',
  'check',
  'status',
  'get',
]);

const NOTE_ACTIONS = Object.freeze([
  'note',
  'annotate',
  'comment',
  'tag',
  'label',
]);

const CONTENT_ACTIONS = Object.freeze([
  'write',
  'upsert',
  'update',
  'edit',
  'patch',
  'save',
  'store',
  'rewrite',
  'modify',
]);

const GRAPH_ACTIONS = Object.freeze([
  'link',
  'unlink',
  'supersede',
  'tombstone',
  'reference',
  'related',
  'contradict',
  'support',
  'edge',
  'relation',
  'graph',
]);

const DELETE_ACTIONS = Object.freeze([
  'delete',
  'remove',
  'destroy',
  'purge',
  'erase',
  'drop',
]);

const AUDIT_ACTIONS = Object.freeze([
  'audit',
  'log',
  'trail',
  'evidence',
  'rewrite',
  'delete',
]);

const PACKAGE_ACTIONS = Object.freeze([
  'package',
  'import',
  'sync',
  'rebuild',
  'rehydrate',
  'batch',
]);

const RELEASE_ACTIONS = Object.freeze([
  'release',
  'deploy',
  'publish',
  'ship',
  'promote',
  'rollout',
]);

const AUTO_ACTIONS = Object.freeze([
  'automerge',
  'auto merge',
  'auto-merge',
  'autopush',
  'auto push',
  'auto-push',
  'auto deploy',
  'auto-deploy',
]);

module.exports = {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_RISK_LEVELS,
  MEMORY_MUTATION_GATE_REASONS,
  MEMORY_MUTATION_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
  BREADTH_REVIEW_THRESHOLD,
  BREADTH_DRY_RUN_THRESHOLD,
  SECRET_HINTS,
  READ_ACTIONS,
  NOTE_ACTIONS,
  CONTENT_ACTIONS,
  GRAPH_ACTIONS,
  DELETE_ACTIONS,
  AUDIT_ACTIONS,
  PACKAGE_ACTIONS,
  RELEASE_ACTIONS,
  AUTO_ACTIONS,
};
