'use strict';

// Emergency stop (#2505 F + #2584 tamper-evidence): durable ledger that stops an
// agent or every agent/MCP call in a workspace, and that every enforcement point
// reads before it acts. Chain mechanics live in lib/emergency-stop-chain.js;
// this module owns policy: stop/lift/quorum/auto-containment on tamper.
// Fail-closed: unreadable record OR ledger integrity violation => stopped:true.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { defaultStateRoot } = require('./huqan-state-root');
const { stableStringify } = require('./receipt/canonical-receipt');
const { normalizeWorkspaceId } = require('./workspace-id');
const {
  EMERGENCY_STOP_CHAIN_SCOPES: SCOPES,
  scopeKey,
  ledgerPath,
  computeEntryHash,
  readLedgerEntries,
  verifyLedgerEntries,
  replayLedgerState,
  scanFileState,
} = require('./emergency-stop-chain');

const EMERGENCY_STOP_SCHEMA_VERSION = 'huqan.emergency-stop.v1';
const EMERGENCY_STOP_REASON = 'agent_emergency_stopped';
const UNREADABLE_REASON = 'emergency_stop_record_unreadable';
const INTEGRITY_VIOLATION_REASON = 'emergency_stop_integrity_violation';
// Reserved for a future per-operator-identity quorum (#2592). Not enforced:
// role actors (operator:cli/http/mcp) cannot distinguish two humans, so a
// same-actor rule only blocks the legitimate single-surface workflow.
const QUORUM_REASON = 'emergency_stop_quorum_distinct_approver_required';
const RECEIPTS_FILE = 'receipts.jsonl';
const MAX_TEXT = 256;

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/** Trim-only shaping for operator envelopes (#2505 F-2b). Must stay byte-identical. */
function argText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function checkArguments({ workspaceId, agentId } = {}) {
  return { workspaceId: argText(workspaceId) || 'default', agentId: argText(agentId) };
}

function changeArguments(body = {}) {
  return {
    action: argText(body.action),
    scope: argText(body.scope),
    workspaceId: argText(body.workspaceId) || 'default',
    agentId: argText(body.agentId),
    reason: argText(body.reason),
  };
}

function defaultEmergencyStopDirectory(environment = process.env) {
  const override = text(environment.HUQAN_EMERGENCY_STOP_DIR);
  return override ? path.resolve(override) : path.join(defaultStateRoot(environment), 'emergency-stops');
}

function normalizeTarget({ scope, workspaceId, agentId } = {}) {
  if (scope !== SCOPES.AGENT && scope !== SCOPES.WORKSPACE) throw new TypeError(`unknown emergency stop scope: ${String(scope)}`);
  const workspace = normalizeWorkspaceId(workspaceId);
  const agent = text(agentId);
  if (scope === SCOPES.AGENT && !agent) throw new TypeError('an agent emergency stop needs an agent id');
  return { scope, workspaceId: workspace, agentId: scope === SCOPES.AGENT ? agent : null };
}

/** A ledger over one directory. */
function createEmergencyStop({ directory, environment = process.env, now = () => new Date().toISOString() } = {}) {
  const root = path.resolve(directory || defaultEmergencyStopDirectory(environment));
  const recordPath = (target) => path.join(root, `${scopeKey(target.scope, target.workspaceId, target.agentId)}.stop.json`);

  // Operator identity carrier (#2601, quorum prerequisite): an optional human
  // identity claim (e.g. 'human:alice') recorded beside the role actor
  // (operator:cli/http/mcp), which alone cannot distinguish two humans. The
  // quorum rule itself stays deferred; this only makes the claim visible and
  // tamper-evident wherever the actor is recorded. Absent reads as null.
  function operatorIdentityOf(value) {
    const claim = text(value);
    return claim === '' ? null : claim;
  }

  function appendReceipt(action, record, actor, reason, operatorIdentity) {
    const payload = {
      receiptKind: 'emergency_stop_receipt',
      schemaVersion: EMERGENCY_STOP_SCHEMA_VERSION,
      action, scope: record.scope, workspaceId: record.workspaceId, agentId: record.agentId,
      actor: text(actor), operatorIdentity: operatorIdentityOf(operatorIdentity),
      reason: text(reason), createdAt: now(),
    };
    const receipt = Object.freeze({
      ...payload,
      receiptHash: crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex'),
    });
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(path.join(root, RECEIPTS_FILE), `${JSON.stringify(receipt)}\n`, 'utf8');
    return receipt;
  }

  function appendLedgerEntry({ action, scope, workspaceId, agentId, actor, operatorIdentity, reason }) {
    fs.mkdirSync(root, { recursive: true });
    const entries = readLedgerEntries(root);
    let prevHash = null;
    let seq = 0;
    if (entries.length > 0 && !entries[0].__unreadable && !entries[0].__corrupt) {
      const last = entries[entries.length - 1];
      if (last && typeof last.hash === 'string') { prevHash = last.hash; seq = entries.length; }
      else seq = entries.length;
    }
    const payload = {
      schemaVersion: EMERGENCY_STOP_SCHEMA_VERSION, action, scope, workspaceId,
      agentId: agentId ?? null, actor: text(actor),
      operatorIdentity: operatorIdentityOf(operatorIdentity),
      reason: text(reason), createdAt: now(),
    };
    const entry = { seq, prevHash, hash: computeEntryHash(payload, prevHash), ...payload };
    fs.appendFileSync(ledgerPath(root), `${JSON.stringify(entry)}\n`, 'utf8');
    return Object.freeze(entry);
  }

  function readRecord(target) {
    let raw;
    try {
      raw = fs.readFileSync(recordPath(target), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { present: false };
      return { present: true, unreadable: true };
    }
    try {
      const record = JSON.parse(raw);
      const valid = record && record.schemaVersion === EMERGENCY_STOP_SCHEMA_VERSION
        && record.scope === target.scope && record.workspaceId === target.workspaceId
        && (record.agentId ?? null) === target.agentId;
      return valid ? { present: true, record } : { present: true, unreadable: true };
    } catch (_) {
      return { present: true, unreadable: true };
    }
  }

  function verifyIntegrity() {
    const entries = readLedgerEntries(root);
    const verified = verifyLedgerEntries(entries);
    if (!verified.ok) {
      return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: verified.reason, index: verified.index ?? null } });
    }
    if (entries.length > 0) {
      const ledgerState = replayLedgerState(entries, EMERGENCY_STOP_SCHEMA_VERSION);
      const { state: fileState, unreadable: fileUnreadable } = scanFileState(root, EMERGENCY_STOP_SCHEMA_VERSION);
      if (fileUnreadable) {
        return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'stop_record_unreadable' } });
      }
      for (const [key, ledgerVal] of ledgerState.entries()) {
        const fileVal = fileState.get(key);
        if (ledgerVal.stopped && !fileVal) {
          return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'ledger_stopped_but_file_missing', scopeKey: key } });
        }
        if (!ledgerVal.stopped && fileVal) {
          return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'ledger_not_stopped_but_file_present', scopeKey: key } });
        }
        if (fileVal && fileVal.unreadable) {
          return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'stop_record_unreadable', scopeKey: key } });
        }
      }
      for (const [key] of fileState.entries()) {
        if (!ledgerState.has(key)) {
          return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'file_without_ledger_entry', scopeKey: key } });
        }
      }
    } else {
      const { state: fileState, unreadable } = scanFileState(root, EMERGENCY_STOP_SCHEMA_VERSION);
      if (unreadable) {
        return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'stop_record_unreadable' } });
      }
      for (const [, fileVal] of fileState.entries()) {
        if (fileVal.unreadable) return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'stop_record_unreadable' } });
      }
    }
    return Object.freeze({ ok: true, reason: null, details: {} });
  }

  function handleIntegrityViolation({ workspaceId, agentId, violationReason }) {
    let scope = SCOPES.WORKSPACE;
    let targetWorkspace = workspaceId || 'default';
    let targetAgent = null;
    try { targetWorkspace = normalizeWorkspaceId(workspaceId || 'default'); } catch (_) { targetWorkspace = 'default'; }
    if (agentId && text(agentId)) { scope = SCOPES.AGENT; targetAgent = text(agentId); }
    try {
      appendLedgerEntry({ action: 'integrity_violation', scope, workspaceId: targetWorkspace, agentId: targetAgent, actor: 'system:integrity-violation', reason: String(violationReason || 'ledger_tamper_detected') });
    } catch (_) { /* ledger append failure must not hide the violation signal */ }
    try {
      fs.mkdirSync(root, { recursive: true });
      const target = { scope, workspaceId: targetWorkspace, agentId: targetAgent };
      const record = { schemaVersion: EMERGENCY_STOP_SCHEMA_VERSION, ...target, reason: INTEGRITY_VIOLATION_REASON, actor: 'system:integrity-violation', stoppedAt: now() };
      fs.writeFileSync(recordPath(target), JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
    } catch (_) { /* already exists: ledger entry above stays authoritative */ }
  }

  /** Stop a scope. A scope already stopped keeps its first record. */
  function stop({ scope, workspaceId, agentId, reason, actor, operatorIdentity } = {}) {
    const target = normalizeTarget({ scope, workspaceId, agentId });
    if (!text(actor)) throw new TypeError('an emergency stop needs the operator who issued it');
    const integrity = verifyIntegrity();
    if (!integrity.ok) {
      handleIntegrityViolation({ workspaceId: target.workspaceId, agentId: target.agentId, violationReason: integrity.details?.ledgerReason || 'pre_stop_integrity_failed' });
    }
    fs.mkdirSync(root, { recursive: true });
    const record = {
      schemaVersion: EMERGENCY_STOP_SCHEMA_VERSION, ...target,
      reason: text(reason), actor: text(actor),
      operatorIdentity: operatorIdentityOf(operatorIdentity), stoppedAt: now(),
    };
    try {
      fs.writeFileSync(recordPath(target), JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const existing = readRecord(target);
      const entries = readLedgerEntries(root).filter((entry) => !entry.__unreadable && !entry.__corrupt);
      const key = scopeKey(target.scope, target.workspaceId, target.agentId);
      const state = replayLedgerState(entries, EMERGENCY_STOP_SCHEMA_VERSION).get(key);
      if (state && state.stopped) {
        return Object.freeze({ ok: true, created: false, record: existing.record || null, receipt: null, ledgerEntry: null, integrityViolation: !integrity.ok });
      }
    }
    const ledgerEntry = appendLedgerEntry({ action: 'stop', scope: target.scope, workspaceId: target.workspaceId, agentId: target.agentId, actor, operatorIdentity, reason });
    return Object.freeze({ ok: true, created: true, record, receipt: appendReceipt('stop', record, actor, reason, operatorIdentity), ledgerEntry, integrityViolation: !integrity.ok });
  }

  /** Lift a stop. Lifting a scope that is not stopped records nothing. */
  function lift({ scope, workspaceId, agentId, reason, actor, operatorIdentity } = {}) {
    const target = normalizeTarget({ scope, workspaceId, agentId });
    if (!text(actor)) throw new TypeError('lifting an emergency stop needs the operator who lifted it');
    const integrity = verifyIntegrity();
    if (!integrity.ok) {
      handleIntegrityViolation({ workspaceId: target.workspaceId, agentId: target.agentId, violationReason: integrity.details?.ledgerReason || 'pre_lift_integrity_failed' });
      return Object.freeze({ ok: false, lifted: false, reason: INTEGRITY_VIOLATION_REASON, details: integrity.details, integrityViolation: true });
    }
    // NOTE (#2591, reverts #2584 quorum): a same-actor workspace lift was
    // refused here, but every surface hardcodes a role actor (operator:cli,
    // operator:http, operator:mcp) instead of a human identity -- so the rule
    // blocked the legitimate stop-then-lift workflow on one surface while a
    // tricked human holding all surfaces walked through. Real quorum needs
    // per-operator identity on these surfaces first (see #2592); until then
    // the stop author stays recorded in the ledger for that future rule.
    try {
      fs.unlinkSync(recordPath(target));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return Object.freeze({ ok: true, lifted: false, receipt: null, ledgerEntry: null });
      }
      throw error;
    }
    const ledgerEntry = appendLedgerEntry({ action: 'lift', scope: target.scope, workspaceId: target.workspaceId, agentId: target.agentId, actor, operatorIdentity, reason });
    return Object.freeze({ ok: true, lifted: true, receipt: appendReceipt('lift', target, actor, reason, operatorIdentity), ledgerEntry });
  }

  /** Whether an action by `agentId` in `workspaceId` is stopped (ledger replay; fail-closed). */
  function check({ workspaceId, agentId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const agent = text(agentId);
    const integrity = verifyIntegrity();
    if (!integrity.ok) {
      handleIntegrityViolation({ workspaceId: workspace, agentId: agent || null, violationReason: integrity.details?.ledgerReason || 'check_integrity_failed' });
      return Object.freeze({
        stopped: true,
        scope: integrity.details?.scopeKey ? null : (agent ? SCOPES.AGENT : SCOPES.WORKSPACE),
        reason: INTEGRITY_VIOLATION_REASON, record: null, integrityViolation: true, details: integrity.details,
      });
    }
    const entries = readLedgerEntries(root).filter((entry) => !entry.__unreadable && !entry.__corrupt);
    if (entries.length > 0) {
      const ledgerState = replayLedgerState(entries, EMERGENCY_STOP_SCHEMA_VERSION);
      const workspaceState = ledgerState.get(scopeKey(SCOPES.WORKSPACE, workspace, null));
      if (workspaceState && workspaceState.stopped) {
        return Object.freeze({ stopped: true, scope: SCOPES.WORKSPACE, reason: EMERGENCY_STOP_REASON, record: workspaceState.record || null });
      }
      if (agent) {
        const agentState = ledgerState.get(scopeKey(SCOPES.AGENT, workspace, agent));
        if (agentState && agentState.stopped) {
          return Object.freeze({ stopped: true, scope: SCOPES.AGENT, reason: EMERGENCY_STOP_REASON, record: agentState.record || null });
        }
      }
      return Object.freeze({ stopped: false, scope: null, reason: null, record: null });
    }
    const targets = [{ scope: SCOPES.WORKSPACE, workspaceId: workspace, agentId: null }];
    if (agent) targets.push({ scope: SCOPES.AGENT, workspaceId: workspace, agentId: agent });
    for (const target of targets) {
      const found = readRecord(target);
      if (!found.present) continue;
      return Object.freeze({
        stopped: true, scope: target.scope,
        reason: found.unreadable ? UNREADABLE_REASON : EMERGENCY_STOP_REASON, record: found.record || null,
      });
    }
    return Object.freeze({ stopped: false, scope: null, reason: null, record: null });
  }

  /**
   * Integrity-violation entries for the siren (#2591). Read-only: verifies
   * the chain first and returns [] when it does not verify, so a tampered
   * ledger never yields a forged "all clear" list. Never notifies itself --
   * notification lives in lib/integrity-violation-notifier.js, called
   * explicitly by the operator, never from check().
   */
  function listIntegrityViolations() {
    const entries = readLedgerEntries(root);
    if (verifyLedgerEntries(entries).ok !== true) return [];
    return Object.freeze(entries
      .filter((entry) => entry.action === 'integrity_violation')
      .map((entry) => Object.freeze({
        seq: entry.seq,
        hash: entry.hash,
        scope: entry.scope,
        workspaceId: entry.workspaceId,
        agentId: entry.agentId ?? null,
        actor: entry.actor,
        reason: entry.reason,
        createdAt: entry.createdAt,
      })));
  }

  return Object.freeze({ directory: root, stop, lift, check, verifyIntegrity, listIntegrityViolations, _readLedgerEntries: () => readLedgerEntries(root), _verifyLedgerEntries: (entries) => verifyLedgerEntries(entries) });
}

/**
 * The ledger an enforcement point should consult: an injected one
 * (`options.emergencyStop` with a `check`), or one over the configured
 * directory. Never taken from agent input.
 */
function emergencyStopLedger(options = {}) {
  const supplied = options && options.emergencyStop;
  if (supplied && typeof supplied.check === 'function') return supplied;
  return createEmergencyStop({
    directory: supplied && typeof supplied.directory === 'string' ? supplied.directory : undefined,
    environment: (options && options.environment) || process.env,
  });
}

module.exports = {
  EMERGENCY_STOP_REASON,
  EMERGENCY_STOP_SCHEMA_VERSION,
  EMERGENCY_STOP_SCOPES: SCOPES,
  EMERGENCY_STOP_UNREADABLE_REASON: UNREADABLE_REASON,
  EMERGENCY_STOP_INTEGRITY_VIOLATION_REASON: INTEGRITY_VIOLATION_REASON,
  changeArguments,
  checkArguments,
  createEmergencyStop,
  defaultEmergencyStopDirectory,
  emergencyStopLedger,
};
