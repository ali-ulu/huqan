'use strict';

const { sha256Hex, stableStringify } = require('./receipt/canonical-receipt');

const ACTION_BINDING_SCHEMA_VERSION = 'huqan.action-binding.v1';

/**
 * The workspace-scoped action binding: the exact action an approval is granted
 * for, as one deterministic digest.
 *
 * Scope is deliberately narrow -- actionType, toolName, command, cwd and
 * workspaceId -- and it is named for what it covers rather than for the two
 * fields that happen to read most naturally. `workspaceId` is inside the
 * digest because an approval given in one workspace must not authorize the
 * same command in another; without it the binding would be a coupon the
 * workspace boundary cannot check.
 *
 * `env` is outside the digest on purpose. Hashing the environment would
 * invalidate an approval on any unrelated variable change, so an operator
 * could not approve a command they would still see run. Environment
 * manipulation is a real boundary, but it is a separate one this digest does
 * not claim to cover; saying so here is the honest reading, and a digest that
 * silently implied otherwise would be worse than the narrow one.
 *
 * The digest is taken over `stableStringify`, the same canonicalization the
 * receipt chain uses, so key order cannot make two observers disagree about
 * the same action.
 *
 * This is an additional claim beside the receipt's existing `metadata.
 * inputDigest`, which digests `args` alone and is left untouched: this binding
 * narrows it, it does not replace it.
 */
function buildExternalActionBinding(envelope = {}) {
  const source = envelope && typeof envelope === 'object' ? envelope : {};
  const tool = source.tool && typeof source.tool === 'object' ? source.tool : {};
  const components = {
    actionType: text(source.kind),
    toolName: text(tool.name),
    command: text(source.command),
    cwd: text(source.cwd),
    workspaceId: text(source.workspaceId, 'default'),
  };
  return {
    schemaVersion: ACTION_BINDING_SCHEMA_VERSION,
    digest: sha256Hex(stableStringify(components)),
    components,
  };
}

/**
 * Compare a stored binding against the action about to run. A mismatch means
 * the approval does not cover this action, which is a refusal rather than a
 * finding: the caller decides what to do with it, but the answer is never
 * "close enough".
 */
function actionBindingMatches(binding, envelope) {
  if (!binding || typeof binding !== 'object' || !text(binding.digest)) return false;
  return binding.digest === buildExternalActionBinding(envelope).digest;
}

function text(value, fallback = '') {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  return raw || fallback;
}

module.exports = {
  ACTION_BINDING_SCHEMA_VERSION,
  actionBindingMatches,
  buildExternalActionBinding,
};
