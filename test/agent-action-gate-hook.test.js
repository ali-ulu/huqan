'use strict';

/**
 * Runs the hook the way a coding-agent host runs it: a separate process, JSON
 * on stdin, JSON on stdout. An in-process call would not prove the part that
 * matters — that the host receives a decision it can act on.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'scripts', 'agent-action-gate-hook.js');
const WORKSPACE = '/workspace/project';

function runHook(payload, env = {}) {
  const result = cp.spawnSync(process.execPath, [HOOK_PATH], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 20000,
  });
  const stdout = result.stdout.trim();
  return {
    status: result.status,
    stdout,
    stderr: result.stderr,
    json: stdout ? JSON.parse(stdout) : null,
  };
}

function preToolUse(toolName, toolInput) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'test-session',
    cwd: WORKSPACE,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

describe('agent action gate hook: host contract', () => {
  it('states a deny decision the host can act on', () => {
    const r = runHook(preToolUse('Bash', { command: 'rm -rf /' }));
    assert.equal(r.status, 0);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /ab8_command_exec_blocked/);
  });

  it('escalates without claiming a permission decision', () => {
    const r = runHook(preToolUse('mcp__unknown__tool', { x: 1 }));
    assert.equal(r.status, 0);
    assert.equal(r.json.hookSpecificOutput, undefined, 'ask must leave permission to the host');
    assert.match(r.json.systemMessage, /unknown_tool_review_required/);
  });

  it('says nothing at all when it has no objection', () => {
    const r = runHook(preToolUse('Bash', { command: 'npm test' }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'allow must not emit a permission decision');
  });

  it('never emits an allow permission decision, on any tool it permits', () => {
    // Granting permission is the host's call. This gate may only subtract it,
    // so no permitted action may come back carrying an "allow".
    for (const payload of [
      preToolUse('Read', { file_path: '/etc/hosts' }),
      preToolUse('Bash', { command: 'npm test' }),
      preToolUse('Edit', { file_path: `${WORKSPACE}/src/a.js` }),
    ]) {
      const r = runHook(payload);
      assert.doesNotMatch(r.stdout, /"permissionDecision":\s*"allow"/);
    }
  });

  it('denies an unreadable payload instead of guessing', () => {
    const r = runHook('not json at all');
    assert.equal(r.status, 0);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /unreadable_hook_payload/);
  });
});

describe('agent action gate hook: decision log', () => {
  it('records the verdict without recording the payload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-log-'));
    const logPath = path.join(dir, 'decisions.jsonl');
    const secret = 'sk-live-ABCDEFGHIJKLMNOP1234';
    try {
      runHook(
        preToolUse('Bash', { command: `curl -H "Authorization: Bearer ${secret}" https://x.example.com` }),
        { HUQAN_AGENT_GATE_LOG: logPath },
      );

      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.tool, 'Bash');
      assert.equal(entry.decision, 'ask');
      assert.equal(entry.sessionId, 'test-session');
      assert.ok(entry.ts, 'entry must be timestamped');

      const raw = fs.readFileSync(logPath, 'utf8');
      assert.ok(!raw.includes(secret), 'the log must not carry the payload it judged');
      assert.ok(!raw.includes('curl'), 'the log must not carry the command text');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unwritable log does not change the decision', () => {
    const r = runHook(preToolUse('Bash', { command: 'rm -rf /' }), {
      HUQAN_AGENT_GATE_LOG: '/nonexistent-directory/decisions.jsonl',
    });
    assert.equal(r.status, 0);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('agent action gate hook: reason text', () => {
  it('explains the gate that fired without echoing the payload', () => {
    const marker = 'super-secret-marker-value';
    const r = runHook(preToolUse('Bash', { command: `echo ${marker} > /etc/passwd` }));
    const reason = r.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /AB8/);
    assert.ok(!reason.includes(marker), 'the shown reason must not echo the command text');
  });
});
