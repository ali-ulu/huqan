'use strict';

// #2173: the guard's decisions and their rank, the shell side-effect rules,
// and the reason codes.

const EXTERNAL_ACTION_DECISIONS = Object.freeze({ ALLOW: 'allow', REVIEW: 'review', BLOCK: 'block' });
const DECISION_RANK = Object.freeze({ allow: 0, review: 1, block: 2 });

const SHELL_SIDE_EFFECT_RULES = Object.freeze([
  Object.freeze({
    pattern: /(?:^|\s)find(?:\.exe)?\b[\s\S]*?(?:^|\s)-delete(?:\s|$)/i,
    decision: 'block',
    reason: 'read_command_destructive_flag_blocked',
  }),
  Object.freeze({
    pattern: /(?:^|\s)find(?:\.exe)?\b[\s\S]*?(?:^|\s)-(?:exec|execdir|ok|okdir)(?:\s|$)/i,
    decision: 'review',
    reason: 'read_command_exec_flag_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)find(?:\.exe)?\b[\s\S]*?(?:^|\s)-(?:fprint|fprint0|fprintf|fls)(?:\s|$)/i,
    decision: 'review',
    reason: 'read_command_output_flag_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+(?:diff|log|show)\b[\s\S]*?(?:^|\s)--output(?:=|\s)/i,
    decision: 'review',
    reason: 'git_output_flag_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+diff\b[\s\S]*?(?:^|\s)--(?:ext-diff|textconv)(?:\s|$)/i,
    decision: 'review',
    reason: 'git_external_diff_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)(?:rg|ripgrep)(?:\.exe)?\b[\s\S]*?(?:^|\s)--pre(?:=|\s)/i,
    decision: 'review',
    reason: 'search_preprocessor_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+branch\b[\s\S]*?(?:^|\s)(?:-D|--delete)(?:\s|$)/,
    decision: 'block',
    reason: 'git_branch_delete_blocked',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+branch\b[\s\S]*?(?:^|\s)(?:-d|-m|-M|-c|-C|--move|--copy|--edit-description|--set-upstream-to|--unset-upstream)(?:=|\s|$)/,
    decision: 'review',
    reason: 'git_branch_mutation_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+remote\s+(?:add|remove|rename|set-head|set-branches|set-url|prune|update)(?:\s|$)/i,
    decision: 'review',
    reason: 'git_remote_mutation_review_required',
  }),
]);

const EXTERNAL_ACTION_REASONS = Object.freeze({
  ALLOWED: 'external_action_allowed',
  REVIEW: 'external_action_review_required',
  BLOCKED: 'external_action_blocked',
  MALFORMED: 'malformed_external_action_blocked',
  GATE_ERROR: 'external_action_gate_error',
  OUTSIDE_WORKSPACE: 'external_action_path_outside_workspace',
  CONTROL_PLANE: 'external_action_control_plane_blocked',
  RECEIPT_PERSISTENCE_FAILED: 'external_action_receipt_persistence_failed',
  DATA_RESIDENCY: 'external_action_data_residency_blocked',
});

module.exports = {
  DECISION_RANK,
  EXTERNAL_ACTION_DECISIONS,
  EXTERNAL_ACTION_REASONS,
  SHELL_SIDE_EFFECT_RULES,
};
