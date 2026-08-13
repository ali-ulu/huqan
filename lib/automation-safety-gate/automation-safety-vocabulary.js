'use strict';

const AUTOMATION_SAFETY_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
  DRY_RUN_ONLY: 'dry_run_only',
});

const AUTOMATION_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const AUTOMATION_SAFETY_REASONS = Object.freeze({
  LOW_RISK_READ_ONLY: 'LOW_RISK_READ_ONLY',
  LOW_RISK_CI_INSPECTION: 'LOW_RISK_CI_INSPECTION',
  DRY_RUN_ONLY_PREVIEW: 'DRY_RUN_ONLY_PREVIEW',
  REPOSITORY_MUTATION_REVIEW_REQUIRED: 'REPOSITORY_MUTATION_REVIEW_REQUIRED',
  MERGE_REQUIRES_APPROVAL: 'MERGE_REQUIRES_APPROVAL',
  LOCAL_MERGE_PUSH_REQUIRES_APPROVAL: 'LOCAL_MERGE_PUSH_REQUIRES_APPROVAL',
  DEPLOY_REQUIRES_APPROVAL: 'DEPLOY_REQUIRES_APPROVAL',
  DEPLOY_PREVIEW_ONLY: 'DEPLOY_PREVIEW_ONLY',
  RELEASE_REQUIRES_APPROVAL: 'RELEASE_REQUIRES_APPROVAL',
  RELEASE_PREVIEW_ONLY: 'RELEASE_PREVIEW_ONLY',
  AUTO_MERGE_BLOCKED: 'AUTO_MERGE_BLOCKED',
  ENABLE_AUTO_MERGE_BLOCKED: 'ENABLE_AUTO_MERGE_BLOCKED',
  FORCE_PUSH_BLOCKED: 'FORCE_PUSH_BLOCKED',
  HISTORY_REWRITE_BLOCKED: 'HISTORY_REWRITE_BLOCKED',
  BRANCH_PROTECTION_BYPASS_BLOCKED: 'BRANCH_PROTECTION_BYPASS_BLOCKED',
  CI_BYPASS_BLOCKED: 'CI_BYPASS_BLOCKED',
  WORKFLOW_ABUSE_BLOCKED: 'WORKFLOW_ABUSE_BLOCKED',
  WORKFLOW_DISPATCH_REVIEW_REQUIRED: 'WORKFLOW_DISPATCH_REVIEW_REQUIRED',
  DESTRUCTIVE_CLEANUP_BLOCKED: 'DESTRUCTIVE_CLEANUP_BLOCKED',
  TOKEN_PERSISTENCE_BLOCKED: 'TOKEN_PERSISTENCE_BLOCKED',
  PUSH_TO_MAIN_BLOCKED: 'PUSH_TO_MAIN_BLOCKED',
  BRANCH_DELETE_REVIEW_REQUIRED: 'BRANCH_DELETE_REVIEW_REQUIRED',
  REPO_SETTINGS_CHANGE_REVIEW_REQUIRED: 'REPO_SETTINGS_CHANGE_REVIEW_REQUIRED',
  REPOSITORY_MUTATION_REVIEW_REQUIRED: 'REPOSITORY_MUTATION_REVIEW_REQUIRED',
  SECRET_DETECTED_BLOCKED: 'SECRET_DETECTED_BLOCKED',
  UNKNOWN_OPERATION_REVIEW_REQUIRED: 'UNKNOWN_OPERATION_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  DIRTY_REPO_REVIEW_REQUIRED: 'DIRTY_REPO_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
});

const AUTOMATION_SAFETY_POLICY_VERSION = 'AB5-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';

const READ_ONLY_HINTS = Object.freeze([
  'read',
  'status',
  'check',
  'inspect',
  'inspect',
  'ci inspection',
  'ci status',
  'read only',
  'read-only',
  'dry run report',
  'report',
  'view',
  'show',
  'list',
  'query',
  'search',
]);

const DEPLOY_HINTS = Object.freeze(['deploy']);
const RELEASE_HINTS = Object.freeze(['release', 'tag_release', 'create_release']);
const MERGE_HINTS = Object.freeze(['merge_pr', 'local_merge_push', 'merge pull request', 'merge']);
const AUTO_MERGE_HINTS = Object.freeze(['enable_auto_merge', 'auto_merge', 'auto-merge', 'automerge']);
const FORCE_PUSH_HINTS = Object.freeze(['force_push', 'force-push']);
const HISTORY_REWRITE_HINTS = Object.freeze(['history_rewrite', 'rewrite_history', 'history rewrite', 'rebase', 'reset_hard']);
const BRANCH_PROTECTION_HINTS = Object.freeze(['branch_protection_change', 'branch protection', 'ruleset', 'protection bypass']);
const CI_BYPASS_HINTS = Object.freeze(['ci_bypass', 'skip ci', 'skip_ci', 'bypass ci', 'ci bypass']);
const WORKFLOW_HINTS = Object.freeze(['workflow_change', 'workflow_dispatch', 'workflow abuse', 'workflow_abuse']);
const DESTRUCTIVE_HINTS = Object.freeze(['destructive_cleanup', 'cleanup', 'prune', 'destroy', 'wipe', 'purge']);
const TOKEN_PERSISTENCE_HINTS = Object.freeze(['token_persistence', 'secret_persistence', 'persist token', 'save token', 'store token']);
const BRANCH_DELETE_HINTS = Object.freeze(['branch_delete', 'delete branch']);
const SETTINGS_CHANGE_HINTS = Object.freeze(['repo_settings_change', 'repo settings', 'settings change']);
const PUSH_TO_MAIN_HINTS = Object.freeze(['push_to_main', 'push to main', 'main push']);
const PREVIEW_HINTS = Object.freeze(['preview', 'dry run', 'dry-run', 'plan']);
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

module.exports = {
  AUTOMATION_SAFETY_DECISIONS,
  AUTOMATION_RISK_LEVELS,
  AUTOMATION_SAFETY_REASONS,
  AUTOMATION_SAFETY_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
  READ_ONLY_HINTS,
  DEPLOY_HINTS,
  RELEASE_HINTS,
  MERGE_HINTS,
  AUTO_MERGE_HINTS,
  FORCE_PUSH_HINTS,
  HISTORY_REWRITE_HINTS,
  BRANCH_PROTECTION_HINTS,
  CI_BYPASS_HINTS,
  WORKFLOW_HINTS,
  DESTRUCTIVE_HINTS,
  TOKEN_PERSISTENCE_HINTS,
  BRANCH_DELETE_HINTS,
  SETTINGS_CHANGE_HINTS,
  PUSH_TO_MAIN_HINTS,
  PREVIEW_HINTS,
  SECRET_HINTS,
};
