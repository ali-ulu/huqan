// #2151: the gate's closed vocabularies -- decisions, reasons, the action
// families it recognises, network mutation hints and secret key patterns.

const TOOL_GATE_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
  DRY_RUN_ONLY: 'dry_run_only',
});

const TOOL_GATE_REASONS = Object.freeze({
  LOW_RISK_ACTION: 'LOW_RISK_ACTION',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  CRITICAL_MUTATION_BLOCKED: 'CRITICAL_MUTATION_BLOCKED',
  HIGH_RISK_ACTION_DRY_RUN_ONLY: 'HIGH_RISK_ACTION_DRY_RUN_ONLY',
  UNKNOWN_ACTION_REVIEW_REQUIRED: 'UNKNOWN_ACTION_REVIEW_REQUIRED',
  SECRET_ARGS_REVIEW_REQUIRED: 'SECRET_ARGS_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
  EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED: 'EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED',
  DRY_RUN_REQUESTED: 'DRY_RUN_REQUESTED',
});

const AB2_POLICY_VERSION = 'AB2-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';

const READ_ONLY_ACTIONS = Object.freeze([
  'read',
  'get',
  'list',
  'fetch',
  'inspect',
  'view',
  'show',
  'open',
  'query',
  'search',
  'status',
  'describe',
  'check',
  'health',
]);

const WRITE_ACTIONS = Object.freeze([
  'write',
  'update',
  'create',
  'set',
  'edit',
  'save',
  'insert',
  'add',
  'modify',
]);

const DESTRUCTIVE_ACTIONS = Object.freeze([
  'delete',
  'remove',
  'destroy',
  'drop',
  'purge',
  'wipe',
  'truncate',
  'format',
  'reset',
  'erase',
  'revoke',
  'kill',
  'shutdown',
]);

const DEPLOY_ACTIONS = Object.freeze([
  'deploy',
  'publish',
  'release',
  'ship',
  'promote',
  'push',
  'upload',
]);

const SIDE_EFFECT_ACTIONS = Object.freeze([
  'send',
  'notify',
  'message',
  'post',
  'email',
  'webhook',
  'call',
  'execute',
  'run',
  'sync',
  'broadcast',
]);

const NETWORK_MUTATION_HINTS = Object.freeze([
  'post',
  'put',
  'patch',
  'webhook',
  'api write',
  'external api write',
  'remote update',
  'create issue',
  'create comment',
  'create pull request',
  'create pr',
  'payment',
  'billing',
  'third-party mutation',
]);

const SECRET_KEY_PATTERNS = Object.freeze([
  /(?:^|[^a-z])api[_-]?key(?:$|[^a-z])/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /bearer/i,
  /credential/i,
  /private\s*key/i,
  /client[_-]?secret/i,
]);

module.exports = {
  AB2_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
  DEPLOY_ACTIONS,
  DESTRUCTIVE_ACTIONS,
  NETWORK_MUTATION_HINTS,
  READ_ONLY_ACTIONS,
  SECRET_KEY_PATTERNS,
  SIDE_EFFECT_ACTIONS,
  TOOL_GATE_DECISIONS,
  TOOL_GATE_REASONS,
  WRITE_ACTIONS,
};
