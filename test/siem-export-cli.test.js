'use strict';

// #4093 PR-B3/PR-B4: the real `huqan-gate-hook siem-export` entry, end to end.
// The file sink runs as shipped; the push sinks run with `fetch` and
// `tls.connect` replaced by a preloaded recorder (test/helpers/siem-push-stub.js),
// so argument parsing, the destination policy, the sink and the cursor are all
// the production path and only the wire is stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'bin', 'huqan-gate-hook.js');
const STUB = path.join(__dirname, 'helpers', 'siem-push-stub.js');
const TOKEN = 'cli-hec-token-0123456789';

function receipt(index, decision = 'allow') {
  return {
    receiptId: `xact_adm_${String(index).padStart(4, '0')}`,
    receiptKind: 'external_action_admission_receipt',
    decision,
    status: decision === 'block' ? 'blocked' : 'admitted',
    workspaceId: 'ws-alpha',
    actor: 'codex',
    agentId: 'agent-7',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    reason: 'no_sensitive_payload',
    riskScore: 12,
    createdAt: `2026-10-21T15:0${index}:00.000Z`,
    receiptHash: String(index).repeat(64),
    metadata: { agentName: 'codex', toolName: 'fetch_page', toolKind: 'browser', inputDigest: 'b'.repeat(64), ruleIdentity: { ruleId: 'r' } },
  };
}

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-siem-cli-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const receipts = path.join(base, 'receipts.jsonl');
  fs.writeFileSync(receipts, `${[receipt(1), receipt(2, 'block')].map(entry => JSON.stringify(entry)).join('\n')}\n`);
  const stubLog = path.join(base, 'stub.jsonl');
  const run = (args, extraEnv = {}) => {
    const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state'), SIEM_STUB_LOG: stubLog, ...extraEnv };
    for (const name of ['HUQAN_SIEM_HTTP_TOKEN', 'HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS', 'HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS',
      'HUQAN_EXTERNAL_GUARD_POLICY', 'HUQAN_EXTERNAL_GUARD_RECEIPTS', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
      if (!(name in extraEnv)) delete env[name];
    }
    const result = spawnSync(process.execPath, ['--require', STUB, HOOK, 'siem-export', '--receipt-log', receipts, ...args], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 60_000,
    });
    return { ...result, json: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })() };
  };
  const calls = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  return { base, run, calls };
}

test('file sink: the CLI writes the events and advances the cursor without a network', t => {
  const { base, run, calls } = setup(t);
  const siemLog = path.join(base, 'siem.jsonl');
  const result = run(['--siem-log', siemLog]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.exported, 2);
  assert.equal(fs.readFileSync(siemLog, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.deepEqual(calls(), [], 'the file sink touched neither fetch nor tls');
  assert.equal(run(['--siem-log', siemLog]).json.pending, 0, 'a second run finds nothing new');
});

test('http sink: the CLI pushes HEC with the token from the environment and never prints it', t => {
  const { run, calls } = setup(t);
  const result = run(['--sink', 'http', '--url', 'https://siem.example.com:8088/services/collector/event', '--format', 'hec'], { HUQAN_SIEM_HTTP_TOKEN: TOKEN });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.exported, 2);
  assert.equal(result.json.siemLog, '');
  const [call] = calls();
  assert.equal(call.url, 'https://siem.example.com:8088/services/collector/event');
  assert.equal(call.headers.Authorization, `Splunk ${TOKEN}`);
  assert.equal(call.body.split('\n').length, 2);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TOKEN));
  assert.equal(run(['--sink', 'http', '--url', 'https://siem.example.com:8088/services/collector/event', '--format', 'hec'], { HUQAN_SIEM_HTTP_TOKEN: TOKEN }).json.pending, 0);
});

test('http sink: a refused delivery exits non-zero and leaves the events pending', t => {
  const { run } = setup(t);
  const args = ['--sink', 'http', '--url', 'https://siem.example.com/services/collector/event', '--format', 'hec'];
  const refused = run(args, { HUQAN_SIEM_HTTP_TOKEN: TOKEN, SIEM_STUB_STATUS: '403' });
  assert.equal(refused.status, 1);
  assert.match(refused.json.failure.message, /status 403/);
  assert.doesNotMatch(refused.stdout, new RegExp(TOKEN));
  const retry = run(args, { HUQAN_SIEM_HTTP_TOKEN: TOKEN });
  assert.equal(retry.json.exported, 2, 'the refused events were not lost');
});

test('http sink: without a token the CLI refuses before reading or sending anything', t => {
  const { run, calls } = setup(t);
  const result = run(['--sink', 'http', '--url', 'https://siem.example.com/x', '--format', 'hec']);
  assert.equal(result.status, 2);
  assert.equal(result.json.error, 'SIEM_HTTP_TOKEN_REQUIRED');
  assert.deepEqual(calls(), []);
});

test('syslog sink: the CLI sends RFC 5424 frames over TLS with verification on', t => {
  const { run, calls } = setup(t);
  const result = run(['--sink', 'syslog', '--url', 'syslog+tls://siem.example.com', '--format', 'cef']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.exported, 2);
  const [call] = calls();
  assert.equal(call.transport, 'syslog');
  assert.equal(call.options.port, 6514);
  assert.equal(call.options.rejectUnauthorized, true);
  assert.match(call.payload, /^\d+ <134>1 /);
  assert.match(call.payload, /\d+ <132>1 .* CEF:0\|HUQAN\|/, 'the blocked decision is sent at warning severity');
});

test('refuses non-tls syslog and plain http endpoints at the CLI', t => {
  const { run, calls } = setup(t);
  const syslog = run(['--sink', 'syslog', '--url', 'udp://siem.example.com:514']);
  assert.equal(syslog.status, 2);
  assert.equal(syslog.json.error, 'SIEM_SYSLOG_INVALID_CONFIG');
  const http = run(['--sink', 'http', '--url', 'http://siem.example.com/x', '--format', 'hec'], { HUQAN_SIEM_HTTP_TOKEN: TOKEN });
  assert.equal(http.status, 2);
  assert.equal(http.json.error, 'SIEM_HTTP_INVALID_CONFIG');
  assert.deepEqual(calls(), []);
});

test('a destination blocked by expected egress is refused before any connection', t => {
  const { run, calls } = setup(t);
  const result = run(['--sink', 'syslog', '--url', 'syslog+tls://siem.example.com'], {
    HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'block',
    HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: 'api.github.com',
  });
  assert.equal(result.status, 2);
  assert.equal(result.json.error, 'SIEM_PUSH_DESTINATION_BLOCKED');
  assert.deepEqual(calls(), []);
});

test('an unknown sink is refused, not defaulted', t => {
  const { run } = setup(t);
  const result = run(['--sink', 'kafka']);
  assert.equal(result.status, 2);
  assert.equal(result.json.error, 'UNKNOWN_SIEM_SINK');
});

test('a --policy file that does not exist refuses the push instead of dropping residency', t => {
  const { base, run, calls } = setup(t);
  const result = run(['--sink', 'syslog', '--url', 'syslog+tls://siem.example.com', '--policy', path.join(base, 'typo.json')]);
  assert.equal(result.status, 2);
  assert.equal(result.json.error, 'SIEM_PUSH_DESTINATION_BLOCKED');
  assert.deepEqual(calls(), []);
});

test('a host expected egress would review is refused unless the operator accepts it', t => {
  const { run, calls } = setup(t);
  const review = { HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'review', HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: 'api.github.com' };
  const refused = run(['--sink', 'syslog', '--url', 'syslog+tls://siem.example.com'], review);
  assert.equal(refused.status, 2);
  assert.equal(refused.json.error, 'SIEM_PUSH_DESTINATION_BLOCKED');
  assert.deepEqual(calls(), []);
  const accepted = run(['--sink', 'syslog', '--url', 'syslog+tls://siem.example.com', '--allow-unreviewed-host'], review);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal(accepted.json.warnings.length, 1);
  assert.equal(accepted.json.destination.expectedEgress.decision, 'review');
});

test('http sink: refuses to run with TLS verification switched off by the environment', t => {
  const { run, calls } = setup(t);
  const result = run(['--sink', 'http', '--url', 'https://siem.example.com/x', '--format', 'hec'], { HUQAN_SIEM_HTTP_TOKEN: TOKEN, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  assert.equal(result.status, 2);
  assert.equal(result.json.error, 'SIEM_HTTP_TLS_VERIFICATION_DISABLED');
  assert.deepEqual(calls(), []);
});
