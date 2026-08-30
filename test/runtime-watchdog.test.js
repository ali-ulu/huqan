'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAuditJournal,
  createRuntimeWatchdog,
  readAndVerifyAudit,
} = require('../lib/runtime-watchdog');
const { bindHumanApprovalConsole } = require('../scripts/huqan-watchdog');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-runtime-watchdog-'));
  const auditPath = path.join(dir, 'external', 'audit.jsonl');
  const audit = createAuditJournal({ auditPath, now: () => new Date('2026-08-30T00:00:00.000Z') });
  const child = new EventEmitter();
  child.pid = 4242;
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  const intervals = [];
  const terminals = [];
  const watchdog = createRuntimeWatchdog({
    serverPath: path.join(dir, 'server.js'),
    healthUrl: 'http://127.0.0.1:3000/health',
    audit,
    spawnProcess: () => child,
    healthCheck: async () => {},
    timers: {
      setInterval(callback) { intervals.push(callback); return { unref() {} }; },
      clearInterval() {},
    },
    onTerminal: (result) => terminals.push(result),
  });
  return { dir, auditPath, audit, child, intervals, terminals, watchdog };
}

function records(auditPath) {
  return fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
}

test('unexpected HUQAN termination is durable, chained, and fail-closed', () => {
  const f = fixture();
  try {
    f.watchdog.start();
    f.child.emit('exit', 0, null);
    const events = records(f.auditPath);
    assert.equal(events.at(-1).type, 'unauthorized_huqan_termination');
    assert.equal(f.terminals[0].exitCode, 1);
    assert.deepEqual(readAndVerifyAudit(f.auditPath), { lastHash: events.at(-1).hash, count: events.length });
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('shutdown needs a non-empty human identity and single-use approval id', () => {
  const f = fixture();
  try {
    f.watchdog.start();
    assert.throws(() => f.watchdog.approveAndShutdown({ approvedBy: '', approvalId: 'a' }), /approvedBy/);
    assert.deepEqual(f.child.signals, []);
    f.watchdog.approveAndShutdown({ approvedBy: 'Ali', approvalId: 'approval-1' });
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    assert.throws(() => f.watchdog.approveAndShutdown({ approvedBy: 'Ali', approvalId: 'approval-2' }), /already been consumed/);
    f.child.emit('exit', 0, 'SIGTERM');
    const events = records(f.auditPath);
    assert.equal(events.at(-2).type, 'human_shutdown_approved');
    assert.equal(events.at(-1).type, 'authorized_shutdown_completed');
    assert.equal(f.terminals[0].exitCode, 0);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('missed heartbeat locks execution path and terminates the managed HUQAN child', async () => {
  const f = fixture();
  let attempts = 0;
  const watchdog = createRuntimeWatchdog({
    serverPath: path.join(f.dir, 'server.js'),
    healthUrl: 'http://localhost:3000/health',
    audit: f.audit,
    spawnProcess: () => f.child,
    healthCheck: async () => { attempts += 1; throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); },
    missedHeartbeats: 2,
    startupGraceMs: 0,
    timers: { setInterval() { return { unref() {} }; }, clearInterval() {} },
  });
  try {
    watchdog.start();
    await watchdog.heartbeat();
    assert.deepEqual(f.child.signals, []);
    await watchdog.heartbeat();
    assert.equal(attempts, 2);
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    assert.equal(records(f.auditPath).at(-1).type, 'heartbeat_lost_fail_closed');
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('startup grace and single-flight heartbeat prevent a slow boot from looking dead', async () => {
  const f = fixture();
  let release;
  let checks = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const watchdog = createRuntimeWatchdog({
    serverPath: path.join(f.dir, 'server.js'),
    healthUrl: 'http://127.0.0.1:3000/health',
    audit: f.audit,
    spawnProcess: () => f.child,
    healthCheck: async () => { checks += 1; await pending; throw new Error('starting'); },
    startupGraceMs: 30_000,
    clock: () => 1_000,
    timers: { setInterval() { return { unref() {} }; }, clearInterval() {} },
  });
  try {
    watchdog.start();
    const first = watchdog.heartbeat();
    await watchdog.heartbeat();
    assert.equal(checks, 1, 'overlapping interval ticks must not launch another health request');
    release();
    await first;
    assert.equal(watchdog.state().misses, 0, 'startup failures inside grace must not consume the runtime miss budget');
    assert.deepEqual(f.child.signals, []);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('tampering with the external audit chain refuses watchdog initialization', () => {
  const f = fixture();
  try {
    f.audit.append('watchdog_started', { pid: 1 });
    const lines = fs.readFileSync(f.auditPath, 'utf8').trim().split(/\r?\n/);
    const record = JSON.parse(lines[0]);
    record.details.pid = 999;
    fs.writeFileSync(f.auditPath, `${JSON.stringify(record)}\n`);
    assert.throws(() => createAuditJournal({ auditPath: f.auditPath }), (error) => error.code === 'WATCHDOG_AUDIT_CORRUPT');
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('audit path and heartbeat target reject ambiguous trust boundaries', () => {
  assert.throws(() => createAuditJournal({ auditPath: 'relative.jsonl' }), (error) => error.code === 'WATCHDOG_AUDIT_PATH_INVALID');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-runtime-watchdog-boundary-'));
  try {
    const audit = createAuditJournal({ auditPath: path.join(dir, 'audit.jsonl') });
    assert.throws(() => createRuntimeWatchdog({ serverPath: path.join(dir, 'server.js'), healthUrl: 'https://example.com/health', audit }), /loopback/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('interactive shutdown console requires the exact confirmation and a human identity', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  const calls = [];
  const binding = bindHumanApprovalConsole({
    input,
    output,
    watchdog: {
      denyShutdown: (reason) => calls.push(['deny', reason]),
      approveAndShutdown: (approval) => calls.push(['approve', approval]),
    },
  });
  try {
    input.write('shutdown\nHAYIR\n');
    assert.equal(calls[0][0], 'deny');
    input.write('shutdown\nONAYLIYORUM\nAli\n');
    assert.equal(calls[1][0], 'approve');
    assert.equal(calls[1][1].approvedBy, 'Ali');
    assert.match(calls[1][1].approvalId, /^[0-9a-f-]{36}$/);
  } finally {
    binding.close();
  }
});
