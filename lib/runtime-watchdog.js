'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AUDIT_VERSION = 'huqan-watchdog-audit-v1';
const GENESIS_HASH = '0'.repeat(64);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_MISSED_HEARTBEATS = 3;
const DEFAULT_STARTUP_GRACE_MS = 30_000;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventHash(event) {
  return crypto.createHash('sha256').update(stableJson(event)).digest('hex');
}

function readAndVerifyAudit(auditPath, fileSystem = fs) {
  if (!fileSystem.existsSync(auditPath)) return { lastHash: GENESIS_HASH, count: 0 };
  const lines = fileSystem.readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean);
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch (cause) {
      const error = new Error(`Watchdog audit line ${index + 1} is not valid JSON.`);
      error.code = 'WATCHDOG_AUDIT_CORRUPT';
      error.cause = cause;
      throw error;
    }
    const { hash, ...unsigned } = record;
    if (record.version !== AUDIT_VERSION || record.previousHash !== previousHash || hash !== eventHash(unsigned)) {
      const error = new Error(`Watchdog audit chain verification failed at line ${index + 1}.`);
      error.code = 'WATCHDOG_AUDIT_CORRUPT';
      throw error;
    }
    previousHash = hash;
  }
  return { lastHash: previousHash, count: lines.length };
}

function createAuditJournal({ auditPath, fileSystem = fs, now = () => new Date() }) {
  if (!path.isAbsolute(auditPath || '')) {
    const error = new TypeError('HUQAN watchdog audit path must be absolute and outside the source tree.');
    error.code = 'WATCHDOG_AUDIT_PATH_INVALID';
    throw error;
  }
  fileSystem.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  let { lastHash, count } = readAndVerifyAudit(auditPath, fileSystem);

  function append(type, details = {}) {
    const unsigned = {
      version: AUDIT_VERSION,
      sequence: count + 1,
      timestamp: now().toISOString(),
      type,
      details,
      previousHash: lastHash,
    };
    const record = { ...unsigned, hash: eventHash(unsigned) };
    fileSystem.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    lastHash = record.hash;
    count += 1;
    return record;
  }

  return Object.freeze({ append, inspect: () => ({ auditPath, lastHash, count }) });
}

function createRuntimeWatchdog({
  serverPath,
  healthUrl,
  audit,
  spawnProcess = spawn,
  healthCheck = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    const body = await response.json();
    if (body?.ok !== true || body?.service !== 'huqan') throw new Error('health identity mismatch');
  },
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  missedHeartbeats = DEFAULT_MISSED_HEARTBEATS,
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
  timers = { setInterval, clearInterval },
  clock = Date.now,
  environment = process.env,
  onTerminal = () => {},
} = {}) {
  if (!path.isAbsolute(serverPath || '')) throw new TypeError('serverPath must be absolute');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\//i.test(healthUrl || '')) {
    throw new TypeError('healthUrl must target loopback');
  }
  if (!audit || typeof audit.append !== 'function') throw new TypeError('audit journal is required');

  let child = null;
  let timer = null;
  let misses = 0;
  let shutdownApproval = null;
  let terminal = false;
  let heartbeatInProgress = false;
  let startedAt = null;
  let healthyOnce = false;

  function finish(type, details, exitCode) {
    if (terminal) return;
    terminal = true;
    if (timer) timers.clearInterval(timer);
    timer = null;
    audit.append(type, details);
    onTerminal({ type, exitCode, details });
  }

  async function heartbeat() {
    if (terminal || !child || heartbeatInProgress) return;
    heartbeatInProgress = true;
    try {
      await healthCheck(healthUrl);
      if (misses > 0) audit.append('heartbeat_recovered', { missed: misses });
      misses = 0;
      healthyOnce = true;
    } catch (error) {
      if (!healthyOnce && clock() - startedAt < startupGraceMs) {
        return;
      }
      misses += 1;
      audit.append('heartbeat_missed', { missed: misses, errorCode: error?.code || 'HEALTH_CHECK_FAILED' });
      if (misses >= missedHeartbeats) {
        audit.append('heartbeat_lost_fail_closed', { missed: misses });
        try { child.kill('SIGTERM'); } catch (_) {}
      }
    } finally {
      heartbeatInProgress = false;
    }
  }

  function start() {
    if (child) throw new Error('watchdog already started');
    startedAt = clock();
    audit.append('watchdog_started', { serverPath, healthUrl });
    child = spawnProcess(process.execPath, [serverPath], {
      cwd: path.dirname(serverPath),
      env: { ...environment, HUQAN_WATCHDOG_MANAGED: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });
    audit.append('huqan_process_started', { pid: child.pid || null });
    child.once('exit', (code, signal) => {
      const details = { pid: child.pid || null, code, signal, approvalId: shutdownApproval?.approvalId || null };
      if (shutdownApproval) finish('authorized_shutdown_completed', details, code || 0);
      else finish('unauthorized_huqan_termination', details, 1);
    });
    child.once('error', (error) => finish('huqan_process_start_failed', { errorCode: error?.code || 'SPAWN_FAILED' }, 1));
    timer = timers.setInterval(heartbeat, heartbeatIntervalMs);
    timer.unref?.();
    return child;
  }

  function approveAndShutdown({ approvedBy, approvalId }) {
    if (terminal || !child) throw new Error('watchdog is not running');
    if (shutdownApproval) throw new Error('shutdown approval has already been consumed');
    if (typeof approvedBy !== 'string' || !approvedBy.trim()) throw new TypeError('approvedBy is required');
    if (typeof approvalId !== 'string' || !approvalId.trim()) throw new TypeError('approvalId is required');
    shutdownApproval = Object.freeze({ approvedBy: approvedBy.trim(), approvalId: approvalId.trim() });
    audit.append('human_shutdown_approved', shutdownApproval);
    const sent = child.kill('SIGTERM');
    if (sent === false) {
      shutdownApproval = null;
      const error = new Error('HUQAN process rejected the shutdown signal.');
      error.code = 'WATCHDOG_SHUTDOWN_SIGNAL_FAILED';
      throw error;
    }
    return shutdownApproval;
  }

  function denyShutdown(reason = 'human approval missing') {
    audit.append('shutdown_denied', { reason });
    return Object.freeze({ allowed: false, reason });
  }

  return Object.freeze({ start, heartbeat, approveAndShutdown, denyShutdown, state: () => ({ terminal, misses, approved: Boolean(shutdownApproval), pid: child?.pid || null }) });
}

module.exports = {
  AUDIT_VERSION,
  GENESIS_HASH,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MISSED_HEARTBEATS,
  DEFAULT_STARTUP_GRACE_MS,
  createAuditJournal,
  createRuntimeWatchdog,
  readAndVerifyAudit,
};
