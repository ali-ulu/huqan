'use strict';

/**
 * Experience — Personal Execution Model (#2396, design comment on #2396,
 * R3 Phase 8).
 *
 * A `PersonalExecutionModel` (PEM) is a versioned composition of
 * REFERENCES, not a trained artifact. No weights, no gradient step, no
 * neural net anywhere in this file. "Model" is used the way
 * `trustPolicyVersion` or `capabilityTrustSchemaVersion` already use it: a
 * named, versioned snapshot of configuration this repo's runtime already
 * produces elsewhere. PEM's only job is to bundle things that already exist
 * as separate modules into one addressable, versioned unit a request can be
 * evaluated against — `lib/trust-policy.js` (policy), a small preference
 * reference (`lib/human-approval-toggle.js` plus an explicit router
 * tiebreak override), an environment fingerprint (declared capability set +
 * tool registry + paranoid mode), `lib/experience/capability-trust.js`
 * (capability trust snapshot) and `lib/experience/router.js` (routing rule
 * versions).
 *
 * Every field folded into `modelId` is a pointer with a version, never a
 * copy of the referenced state: `composePersonalExecutionModel()` calls no
 * new storage, no new gate, no new trust primitive. Two composition calls
 * with identical inputs produce the identical `modelId` — same determinism
 * discipline as #2384's router.
 *
 * ## Scope note: `experienceReadRef` intentionally omitted
 *
 * #2396's design comment lists a sixth composed reference,
 * `experienceReadRef: { projectionHash }` from `lib/experience/read-model.js`
 * (#2400). That field names a specific *closed run's* projection hash, which
 * does not exist yet at compose time — a PEM is composed before any request
 * is evaluated through it, so there is no run to project. Folding it in
 * would either force a chicken-and-egg dependency (composing a PEM requires
 * a prior run that itself required a PEM) or silently degrade to a
 * meaningless placeholder, neither of which the design intends. This is
 * flagged as a resolved ambiguity, not a silent trim: the five references
 * that are genuinely available pre-request (policy, preference, environment,
 * capability trust, routing rules) are folded; `experienceReadRef` is left
 * for whatever surface eventually threads a specific prior run's projection
 * into a later composition, if the product ever wants that.
 *
 * ## Preconditions: no Capability Catalog exists yet
 *
 * The Procedure Registry (#2393) has not shipped in this branch, so nothing
 * in this repo owns "what preconditions does capability X declare." The
 * `capabilityTrust` argument to `composePersonalExecutionModel()` therefore
 * carries `preconditions` on each entry as caller-supplied data (alongside
 * the real fields `lib/experience/capability-trust.js`'s registry already
 * returns) — exactly the shape `lib/experience/router.js`'s `candidates`
 * already expects. This mirrors how `capability-trust.js` itself treats
 * `boundProcedureVersion` as an opaque, caller-supplied string.
 *
 * ## Workspace isolation
 *
 * `workspaceId` is part of `modelId`'s hash input. `composePersonalExecutionModel`
 * hard-asserts (throws) if any composed capability-trust reference belongs
 * to a workspace other than the one requested — not just a convention, a
 * real check, because every reference PEM composes is already
 * workspace-scoped in its own module and no code path may read one
 * workspace's trust snapshot while resolving a request tagged another.
 *
 * ## Environment fingerprint
 *
 * `environmentFingerprint = sha256(stableJson({ declaredCapabilityIds,
 * toolRegistryVersion, paranoidMode }))`, computed fresh from live state on
 * every call — never asserted by the caller. `evaluatePersonalExecutionModel()`
 * recomputes it first, before doing anything else, and compares against the
 * PEM's stored one: a mismatch is a refusal, not a stale execution and not a
 * soft warning.
 */

const crypto = require('node:crypto');

const { getTrustPolicyVersion } = require('../trust-policy');
const { isHumanApprovalDisabled } = require('../human-approval-toggle');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { CAPABILITY_TRUST_SCHEMA_VERSION } = require('./capability-trust');
const {
  decideRoute, MATCH_RULE_VERSION, TIEBREAK_RULE_VERSION, SCORE_NOT_USED_VERSION,
} = require('./router');

const MODEL_SCHEMA_VERSION = 'huqan-personal-execution-model-v1';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Same canonical-JSON convention as read-model.js / journal.js / compiler.js. */
function stableJson(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function byCapabilityId(a, b) {
  return a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0;
}

/**
 * Assert every capability-trust entry belongs to `workspaceId`. Throws, does
 * not silently narrow — see the module doc's Workspace isolation section.
 */
function assertSameWorkspace(entries, workspaceId) {
  for (const entry of entries) {
    if (isRecord(entry) && nonEmptyString(entry.workspaceId) && entry.workspaceId !== workspaceId) {
      const err = new Error(
        `composePersonalExecutionModel: capability trust entry "${entry.capabilityId}" belongs to `
        + `workspace "${entry.workspaceId}", not the requested workspace "${workspaceId}"`,
      );
      err.code = 'PEM_CROSS_WORKSPACE_REFERENCE';
      throw err;
    }
  }
}

/** A stable hash of the registered-tool set, per #2396's design note on workflow-tool-registry.js. */
function toolRegistryVersionOf(toolRegistry) {
  const tools = toolRegistry && typeof toolRegistry.listTools === 'function' ? toolRegistry.listTools() : [];
  const stable = tools
    .map((t) => ({ name: t.name, kind: t.kind, cost: t.cost }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256(stableJson(stable));
}

/**
 * `environmentFingerprint = sha256(stableJson({ declaredCapabilityIds,
 * toolRegistryVersion, paranoidMode }))`. Always recomputed from live
 * inputs — `entries` is the capability-trust snapshot in scope right now,
 * `toolRegistry` a live `ToolRegistry` (lib/workflow-tool-registry.js), `env`
 * the environment map `paranoidMode` is read from (default `process.env`).
 */
function computeEnvironmentFingerprint({ entries, toolRegistry, env } = {}) {
  const declaredCapabilityIds = [...new Set(
    (Array.isArray(entries) ? entries : []).map((e) => e && e.capabilityId).filter(nonEmptyString),
  )].sort();
  const toolRegistryVersion = toolRegistryVersionOf(toolRegistry);
  const paranoidMode = readCompatibleEnvironmentVariable('PARANOID', env || process.env) === '1';
  const environmentFingerprint = sha256(stableJson({ declaredCapabilityIds, toolRegistryVersion, paranoidMode }));
  return {
    environmentFingerprint, declaredCapabilityIds, toolRegistryVersion, paranoidMode,
  };
}

/**
 * `preferenceRef` covers exactly two things (#2396's design, scoped
 * narrowly): (a) per-policy auto-approve state from
 * `lib/human-approval-toggle.js`'s `autoApproved` mechanism — the toggle
 * itself is a single global switch, so the caller names which policy ids
 * this workspace's recorded auto-approve decisions apply to, and the
 * reference only counts them when the toggle is actually on; (b) an
 * explicit capability-preference override for the router's tiebreak hook
 * (step 2.5, see router.js). Unset preference falls through to the router's
 * existing tiebreak unchanged.
 */
function buildPreferenceRef({ autoApprovedPolicyIds, capabilityPreference } = {}, env) {
  const humanApprovalDisabled = isHumanApprovalDisabled(env || process.env);
  const normalizedAutoApproved = humanApprovalDisabled && Array.isArray(autoApprovedPolicyIds)
    ? [...new Set(autoApprovedPolicyIds.filter(nonEmptyString))].sort()
    : [];
  const normalizedPreference = nonEmptyString(capabilityPreference);
  const preferenceVersion = sha256(stableJson({
    humanApprovalDisabled, autoApprovedPolicyIds: normalizedAutoApproved, capabilityPreference: normalizedPreference,
  }));
  return Object.freeze({
    preferenceVersion,
    humanApprovalDisabled,
    autoApprovedPolicyIds: Object.freeze(normalizedAutoApproved),
    capabilityPreference: normalizedPreference,
  });
}

/** A versioned snapshot of the capability-trust entries in scope, not a copy of their history. */
function buildCapabilityTrustSnapshotVersion(entries) {
  const picked = entries
    .slice()
    .sort(byCapabilityId)
    .map((e) => ({
      capabilityId: e.capabilityId,
      trustState: e.trustState,
      boundProcedureVersion: e.boundProcedureVersion || null,
      trustPolicyVersion: e.trustPolicyVersion || null,
    }));
  return sha256(stableJson({ schemaVersion: CAPABILITY_TRUST_SCHEMA_VERSION, entries: picked }));
}

/**
 * Compose a PersonalExecutionModel. Pure with respect to storage (no writes,
 * no I/O beyond reading `env`/a live `toolRegistry`'s in-memory list) — see
 * acceptance test 7. Throws `PEM_CROSS_WORKSPACE_REFERENCE` on a
 * cross-workspace capability-trust entry (module doc, Workspace isolation).
 *
 * `capabilityTrust`: `[{ capabilityId, workspaceId, preconditions,
 * trustState, boundProcedureVersion, trustPolicyVersion }]` — the
 * capability-trust registry's own entries, each augmented with the
 * `preconditions` the router needs (see the module doc's Preconditions
 * note; no Capability Catalog module owns this yet).
 * `environment`: `{ toolRegistry, env }`.
 * `preferences`: `{ autoApprovedPolicyIds, capabilityPreference }`.
 * `policy`: the loaded trust policy object (or `null` for the default).
 * `router`: optional `{ matchRuleVersion, matchScoreVersion, tiebreakRuleVersion }`
 * overrides; defaults to router.js's own exported constants.
 */
function composePersonalExecutionModel({
  workspaceId, policy = null, preferences = {}, environment = {}, capabilityTrust = [], router: routerOverrides = {},
} = {}) {
  if (!nonEmptyString(workspaceId)) {
    return { ok: false, code: 'invalid_workspace_id' };
  }
  const entries = Array.isArray(capabilityTrust) ? capabilityTrust : [];
  assertSameWorkspace(entries, workspaceId);

  const trustPolicyVersion = getTrustPolicyVersion(policy);
  const preferenceRef = buildPreferenceRef(preferences, environment.env);
  const {
    environmentFingerprint, declaredCapabilityIds, toolRegistryVersion, paranoidMode,
  } = computeEnvironmentFingerprint({ entries, toolRegistry: environment.toolRegistry, env: environment.env });
  const capabilityTrustSnapshotVersion = buildCapabilityTrustSnapshotVersion(entries);
  const routingRuleVersions = Object.freeze({
    matchRuleVersion: nonEmptyString(routerOverrides.matchRuleVersion) || MATCH_RULE_VERSION,
    matchScoreVersion: nonEmptyString(routerOverrides.matchScoreVersion) || SCORE_NOT_USED_VERSION,
    tiebreakRuleVersion: nonEmptyString(routerOverrides.tiebreakRuleVersion) || TIEBREAK_RULE_VERSION,
  });

  const composed = {
    modelVersion: MODEL_SCHEMA_VERSION,
    workspaceId,
    trustPolicyVersion,
    preferenceRef,
    environmentRef: Object.freeze({
      environmentFingerprint,
      declaredCapabilityIds: Object.freeze(declaredCapabilityIds),
      toolRegistryVersion,
      paranoidMode,
    }),
    capabilityTrustSnapshotVersion,
    routingRuleVersions,
  };
  const modelId = sha256(stableJson(composed));

  const pem = Object.freeze({
    modelId,
    ...composed,
    // Retained so evaluatePersonalExecutionModel() can route without a
    // second lookup; not itself part of modelId's hash input beyond what
    // capabilityTrustSnapshotVersion already folds in.
    candidates: Object.freeze(entries.map((e) => Object.freeze({ ...e }))),
  });
  return { ok: true, pem };
}

/**
 * Evaluate a request against a composed PEM. Recomputes the environment
 * fingerprint from `live` state first, before doing anything else, and
 * compares it against `pem.environmentRef.environmentFingerprint` — a
 * mismatch is a refusal (`environment_fingerprint_mismatch`), never a stale
 * execution. On a match, routes through `decideRoute()` (#2395) using the
 * PEM's named rule versions and capability-trust snapshot, applying the
 * preference override at the router's tiebreak hook.
 *
 * `live`: `{ capabilityTrust, toolRegistry, env }` — the current state to
 * re-derive the fingerprint from; defaults to the PEM's own composed
 * candidates when `capabilityTrust` is omitted (so a caller who has not
 * changed anything need not re-supply it).
 */
function evaluatePersonalExecutionModel(pem, request, live = {}) {
  if (!isRecord(pem) || !nonEmptyString(pem.modelId) || !isRecord(pem.environmentRef)) {
    return { ok: false, code: 'invalid_pem' };
  }
  const entries = Array.isArray(live.capabilityTrust) ? live.capabilityTrust : pem.candidates;
  for (const entry of entries) {
    if (isRecord(entry) && nonEmptyString(entry.workspaceId) && entry.workspaceId !== pem.workspaceId) {
      return { ok: false, code: 'cross_workspace_capability_trust', modelId: pem.modelId };
    }
  }

  const fresh = computeEnvironmentFingerprint({ entries, toolRegistry: live.toolRegistry, env: live.env });
  if (fresh.environmentFingerprint !== pem.environmentRef.environmentFingerprint) {
    return {
      ok: false,
      code: 'environment_fingerprint_mismatch',
      modelId: pem.modelId,
      expected: pem.environmentRef.environmentFingerprint,
      actual: fresh.environmentFingerprint,
    };
  }

  const candidates = entries.map((e) => ({
    capabilityId: e.capabilityId,
    preconditions: e.preconditions,
    trustState: e.trustState,
    boundProcedureVersion: e.boundProcedureVersion,
    trustSnapshotVersion: pem.capabilityTrustSnapshotVersion,
  }));

  const routed = decideRoute({
    requestId: request && request.requestId,
    request: { declared: request && request.declared, riskTier: request && request.riskTier },
    candidates,
    trustSnapshotVersion: pem.capabilityTrustSnapshotVersion,
    policy: (request && request.policy) || {},
    matchRuleVersion: pem.routingRuleVersions.matchRuleVersion,
    matchScoreVersion: pem.routingRuleVersions.matchScoreVersion,
    tiebreakRuleVersion: pem.routingRuleVersions.tiebreakRuleVersion,
    preferredCapabilityId: pem.preferenceRef.capabilityPreference,
  });
  if (!routed.ok) return { ok: false, code: routed.code, modelId: pem.modelId };
  return { ok: true, modelId: pem.modelId, decision: routed.decision };
}

module.exports = Object.freeze({
  MODEL_SCHEMA_VERSION,
  composePersonalExecutionModel,
  evaluatePersonalExecutionModel,
  computeEnvironmentFingerprint,
  buildPreferenceRef,
  buildCapabilityTrustSnapshotVersion,
});
