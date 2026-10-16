'use strict';

// Hash-chained ledger mechanics for the emergency stop (#2584).
//
// Single responsibility: the append-only chain file format — hashing,
// reading, verification, replay and the filesystem scan it is compared
// against. Policy (stop/lift/quorum/auto-containment) lives in
// lib/emergency-stop.js, which is the only importer. Pure mechanics here:
// every function takes explicit arguments, nothing reads process state.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('./receipt/canonical-receipt');

const SCOPES = Object.freeze({ AGENT: 'agent', WORKSPACE: 'workspace' });
const RECORD_SUFFIX = '.stop.json';
const LEDGER_FILE = 'ledger.jsonl';

function scopeKey(scope, workspaceId, agentId) {
  const material = scope === SCOPES.WORKSPACE ? `workspace\n${workspaceId}` : `agent\n${workspaceId}\n${agentId}`;
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

function ledgerPath(root) {
  return path.join(root, LEDGER_FILE);
}

function computeEntryHash(payload, prevHash) {
  return crypto.createHash('sha256').update(stableStringify({ ...payload, prevHash }), 'utf8').digest('hex');
}

function readLedgerEntries(root) {
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath(root), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    return [{ __unreadable: true }];
  }
  if (!raw.trim()) return [];
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (_) {
      entries.push({ __corrupt: true });
    }
  }
  return entries;
}

function verifyLedgerEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { ok: true, entries: [] };
  for (const entry of entries) {
    if (entry.__unreadable || entry.__corrupt) return { ok: false, reason: 'ledger_unreadable_or_corrupt', entries };
  }
  let prevHash = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (typeof entry.seq !== 'number' || entry.seq !== i) {
      return { ok: false, reason: 'ledger_seq_gap', index: i, entries };
    }
    if ((entry.prevHash ?? null) !== prevHash) {
      return { ok: false, reason: 'ledger_prevhash_mismatch', index: i, entries };
    }
    const { hash, seq, prevHash: storedPrev, ...payload } = entry;
    if (hash !== computeEntryHash(payload, prevHash)) {
      return { ok: false, reason: 'ledger_hash_mismatch', index: i, entries };
    }
    if (!entry.action || !['stop', 'lift', 'integrity_violation'].includes(entry.action)) {
      return { ok: false, reason: 'ledger_invalid_action', index: i, entries };
    }
    prevHash = hash;
  }
  return { ok: true, entries };
}

function replayLedgerState(entries, schemaVersion) {
  const state = new Map();
  for (const entry of entries) {
    const key = scopeKey(entry.scope, entry.workspaceId, entry.agentId ?? null);
    if (entry.action === 'stop') {
      state.set(key, {
        stopped: true,
        lastStopActor: entry.actor,
        // Operator identity of the stop author, beside the role actor: the
        // quorum rule's future input (#2601). Absent reads as null.
        lastStopOperatorIdentity: entry.operatorIdentity ?? null,
        record: {
          schemaVersion: entry.schemaVersion || schemaVersion,
          scope: entry.scope, workspaceId: entry.workspaceId, agentId: entry.agentId ?? null,
          actor: entry.actor, operatorIdentity: entry.operatorIdentity ?? null,
          stoppedAt: entry.createdAt, reason: entry.reason,
        },
      });
    } else if (entry.action === 'lift') {
      state.set(key, { stopped: false, lastStopActor: null, lastStopOperatorIdentity: null, record: null });
    } else if (entry.action === 'integrity_violation') {
      state.set(key, { stopped: true, lastStopActor: 'system:integrity-violation', record: null, violation: true });
    }
  }
  return state;
}

function scanFileState(root, schemaVersion) {
  const state = new Map();
  let files = [];
  try {
    files = fs.readdirSync(root).filter((name) => name.endsWith(RECORD_SUFFIX));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state, unreadable: false };
    return { state, unreadable: true };
  }
  for (const file of files) {
    const full = path.join(root, file);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (_) {
      state.set(file.replace(RECORD_SUFFIX, ''), { stopped: true, unreadable: true, record: null });
      continue;
    }
    try {
      const record = JSON.parse(raw);
      if (!record || record.schemaVersion !== schemaVersion || !record.scope || !record.workspaceId) {
        state.set(file.replace(RECORD_SUFFIX, ''), { stopped: true, unreadable: true, record: null });
        continue;
      }
      state.set(scopeKey(record.scope, record.workspaceId, record.agentId ?? null),
        { stopped: true, unreadable: false, record });
    } catch (_) {
      state.set(file.replace(RECORD_SUFFIX, ''), { stopped: true, unreadable: true, record: null });
    }
  }
  return { state, unreadable: false };
}

module.exports = {
  EMERGENCY_STOP_CHAIN_SCOPES: SCOPES,
  EMERGENCY_STOP_CHAIN_RECORD_SUFFIX: RECORD_SUFFIX,
  EMERGENCY_STOP_CHAIN_LEDGER_FILE: LEDGER_FILE,
  scopeKey,
  ledgerPath,
  computeEntryHash,
  readLedgerEntries,
  verifyLedgerEntries,
  replayLedgerState,
  scanFileState,
};
