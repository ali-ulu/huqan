'use strict';

/**
 * Experience — promotion / rollback admission for canary candidates.
 *
 * Moved out of `./canary.js` (which re-exports it unchanged) to keep that
 * file inside its line budget when #3469 (I5) added the authority boundary.
 * Mirrors `lib/human-approval-toggle.js`'s pattern: an explicit approval, or
 * a standing receipted toggle — never a silent default.
 *
 * ## Self-authorization boundary (#3469)
 *
 * A learner may not authorize its own change. `resolveAdmission()` takes the
 * candidate's `proposerIds`; an approval whose `approverId`, or a toggle
 * whose `adminId`, is one of them is refused with
 * `self_authorization_refused`, and the approval is consumed so it cannot be
 * laundered by asking again without the list.
 *
 * Every admission this module grants is recorded in a module-private set.
 * `isIssuedAdmission()` lets a consumer (the capability trust ladder) accept
 * only an object this module produced — a caller cannot hand-write
 * `{ admitted: true }` — and `spendAdmission()` makes it single use, so one
 * approval authorizes exactly one promotion or rollback.
 *
 * ## Verified authority identities (#3552)
 *
 * An `approverId` or `adminId` used to be accepted as any string the caller
 * typed. It is now a *subject reference*: the host injects a
 * `resolvePrincipal(reference)` resolver (its authentication boundary) at
 * registry creation, and a request whose approver/admin cannot be resolved
 * to a verified human principal is refused — `unverified_approver` /
 * `unverified_admin` — before anything is recorded. With no resolver
 * injected the registry refuses every authority identity: fail-closed.
 */

const crypto = require('node:crypto');

const ISSUED = new WeakSet();
const SPENT = new WeakSet();

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function stableKey(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
}

function receiptId(prefix, payload) {
  return `${prefix}_${crypto.createHash('sha256').update(stableKey(payload), 'utf8').digest('hex').slice(0, 16)}`;
}

const SUBJECT_KINDS = Object.freeze(['promotion', 'rollback']);

/** What one admission may authorize: a move of one kind to/from one version. */
function validSubject(subject) {
  return Boolean(subject) && typeof subject === 'object' && SUBJECT_KINDS.includes(subject.kind)
    && nonEmptyString(subject.candidateVersion);
}

function sameSubject(left, right) {
  return Boolean(left) && Boolean(right) && left.kind === right.kind && left.candidateVersion === right.candidateVersion;
}

function compositeKey(workspaceId, capabilityId) {
  return `${workspaceId}::${capabilityId}`;
}

/**
 * Resolve an authority subject reference through the host's identity layer.
 * The default resolver verifies nothing, so it refuses everything — a
 * registry created without a host resolver has no authority to grant.
 */
function refuseAllPrincipals() {
  return { ok: false, code: 'principal_resolver_unavailable' };
}

function issue(admission) {
  const frozen = Object.freeze(admission);
  ISSUED.add(frozen);
  return frozen;
}

/** True only for an admitted object this module issued, never for a copy. */
function isIssuedAdmission(admission) {
  return Boolean(admission) && typeof admission === 'object' && ISSUED.has(admission) && admission.admitted === true;
}

/** Mark an issued admission used; false if it was not issued or already spent. */
function spendAdmission(admission) {
  if (!isIssuedAdmission(admission) || SPENT.has(admission)) return false;
  SPENT.add(admission);
  return true;
}

function isAdmissionSpent(admission) {
  return Boolean(admission) && typeof admission === 'object' && SPENT.has(admission);
}

/**
 * Per-capability admission registry: a standing "auto-promote candidates
 * that clear canary" toggle (admin-only — the toggle's `adminId` is a
 * subject reference the injected `resolvePrincipal` must verify), or a
 * one-time explicit approval consumed by the promotion/rollback it names
 * (`approverId`, verified the same way). Every resolution that admits a
 * promotion — toggle-driven or explicit — produces its own fresh receipt for
 * that promotion event; "auto" changes who approves, never whether an
 * approval record exists.
 *
 * @param {object} [options]
 * @param {(reference: string) => { ok: true, principal?: object } | { ok: false, code?: string }} [options.resolvePrincipal]
 *   the host's authentication boundary; a reference it cannot vouch for
 *   must resolve to `{ ok: false }`.
 */
function createPromotionAdmissionRegistry({ resolvePrincipal = refuseAllPrincipals } = {}) {
  /** @type {Map<string, { enabled: boolean, adminId: string, reason: string, at: number, receiptId: string }>} */
  const toggles = new Map();
  /** @type {Map<string, { approverId: string, reason: string, at: number, receiptId: string }>} */
  const explicitApprovals = new Map();

  function setAutoPromoteToggle({
    workspaceId, capabilityId, adminId, enabled, reason = 'admin_toggle', at = Date.now(),
  } = {}) {
    if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityId) || !nonEmptyString(adminId)) {
      return { ok: false, code: 'invalid_toggle_request' };
    }
    const verified = resolvePrincipal(adminId);
    if (!verified || verified.ok !== true) {
      return { ok: false, code: 'unverified_admin' };
    }
    const key = compositeKey(workspaceId, capabilityId);
    const record = {
      enabled: enabled === true,
      adminId,
      reason,
      at,
      receiptId: receiptId('canary_toggle', { workspaceId, capabilityId, adminId, enabled: enabled === true, at }),
    };
    toggles.set(key, record);
    return { ok: true, receipt: Object.freeze({ ...record, workspaceId, capabilityId }) };
  }

  function getToggle(workspaceId, capabilityId) {
    return toggles.get(compositeKey(workspaceId, capabilityId)) || null;
  }

  /** Records a one-time explicit approval for exactly one promotion/rollback
   * event, named by `promotionId`. Consumed (removed) the moment
   * `resolveAdmission` uses it, so it cannot be silently replayed for a
   * later, different promotion. */
  function recordExplicitApproval({
    workspaceId, capabilityId, promotionId, approverId, reason = 'explicit_approval', at = Date.now(), subject,
  } = {}) {
    if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityId)
      || !nonEmptyString(promotionId) || !nonEmptyString(approverId)
      || (subject !== undefined && !validSubject(subject))) {
      return { ok: false, code: 'invalid_approval_request' };
    }
    const verified = resolvePrincipal(approverId);
    if (!verified || verified.ok !== true) {
      return { ok: false, code: 'unverified_approver' };
    }
    const key = `${compositeKey(workspaceId, capabilityId)}::${promotionId}`;
    const bound = subject === undefined ? {} : { subject: Object.freeze({ kind: subject.kind, candidateVersion: subject.candidateVersion }) };
    const record = {
      approverId,
      reason,
      at,
      // An unbound approval keeps its pre-#3469 receipt id.
      receiptId: receiptId('canary_approval', { workspaceId, capabilityId, promotionId, approverId, at, ...bound }),
      ...bound,
    };
    explicitApprovals.set(key, record);
    return { ok: true, receipt: Object.freeze({ ...record, workspaceId, capabilityId, promotionId }) };
  }

  /**
   * Resolve whether a promotion/rollback named `promotionId` is admitted.
   * `admitted: false` (with no receipt) is the fail-closed default — this
   * is the codepath acceptance test 5 exercises: no explicit approval and
   * no active toggle means no promotion event may occur. `proposerIds`
   * names who proposed the candidate; none of them may be the authority.
   */
  function resolveAdmission({ workspaceId, capabilityId, promotionId, proposerIds = [], subject } = {}) {
    if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityId) || !nonEmptyString(promotionId)
      || !Array.isArray(proposerIds) || !proposerIds.every(nonEmptyString)
      || (subject !== undefined && !validSubject(subject))) {
      return { ok: false, code: 'invalid_admission_request' };
    }
    const proposers = new Set(proposerIds);
    const approvalKey = `${compositeKey(workspaceId, capabilityId)}::${promotionId}`;
    const approval = explicitApprovals.get(approvalKey);
    if (approval) {
      // A request for a subject the approval does not name leaves it in place:
      // a wrong guess must not burn a reviewer's decision.
      if (subject !== undefined && !approval.subject) return { ok: true, admitted: false, code: 'unbound_approval' };
      if (subject !== undefined && !sameSubject(approval.subject, subject)) {
        return { ok: true, admitted: false, code: 'admission_subject_mismatch' };
      }
      explicitApprovals.delete(approvalKey);
      if (proposers.has(approval.approverId)) {
        return { ok: true, admitted: false, code: 'self_authorization_refused', authorityId: approval.approverId };
      }
      return issue({
        ok: true, admitted: true, mode: 'explicit_approval',
        receipt: Object.freeze({ ...approval, workspaceId, capabilityId, promotionId }),
      });
    }
    const toggle = getToggle(workspaceId, capabilityId);
    if (toggle && toggle.enabled) {
      if (proposers.has(toggle.adminId)) {
        return { ok: true, admitted: false, code: 'self_authorization_refused', authorityId: toggle.adminId };
      }
      // Fresh receipt for THIS promotion event, referencing the standing
      // toggle's own receipt — the toggle authorizes the mode, it is not
      // itself the promotion's receipt.
      const promotionReceipt = {
        receiptId: receiptId('canary_auto_promotion', { workspaceId, capabilityId, promotionId, at: Date.now() }),
        toggleReceiptId: toggle.receiptId,
        adminId: toggle.adminId,
        at: Date.now(),
      };
      return issue({
        ok: true, admitted: true, mode: 'auto_promote_toggle',
        // The admin's standing policy covers this capability; the event it
        // admits is bound to the subject the caller asked for.
        receipt: Object.freeze({ ...promotionReceipt, workspaceId, capabilityId, promotionId,
          ...(subject === undefined ? {} : { subject: Object.freeze({ kind: subject.kind, candidateVersion: subject.candidateVersion }) }) }),
      });
    }
    return { ok: true, admitted: false, code: 'no_admission_record' };
  }

  return Object.freeze({ setAutoPromoteToggle, recordExplicitApproval, resolveAdmission, getToggle });
}

module.exports = Object.freeze({
  createPromotionAdmissionRegistry, isIssuedAdmission, spendAdmission, isAdmissionSpent,
});
