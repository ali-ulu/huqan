#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook entry point for the external agent action gate (AB-EXT).
 *
 * A coding-agent host runs this before it executes a tool call, hands it the
 * proposed call as JSON on stdin, and reads the decision back from stdout. It
 * is the enforcement point `lib/agent-action-gate-adapter.js` needs: the gates
 * have always been able to judge an action, but nothing put them in front of
 * one an outside agent was about to run.
 *
 * The output contract is deliberately one-directional. Only `deny` is stated as
 * a permission decision; `ask` is expressed by staying silent about permission
 * and explaining the concern in `systemMessage`, which leaves the host's own
 * prompt in charge. This gate never emits `allow`, because doing so would
 * approve a call the host might otherwise have asked about — subtracting
 * permission is a safety decision, granting it is not.
 *
 * Install (Claude Code, .claude/settings.json):
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [
 *       { "type": "command", "command": "node scripts/agent-action-gate-hook.js" } ] } ] } }
 *
 * Environment:
 *   HUQAN_AGENT_GATE_LOG        append-only JSONL decision log (optional)
 *   HUQAN_AGENT_GATE_ALLOWLIST  extra write roots, ':'-separated
 *
 * Both are read through lib/environment-compat, which is what resolves the
 * AXIOM_ legacy spelling and rejects a conflicting pair.
 */

const fs = require('node:fs');
const path = require('node:path');
const { evaluateAgentAction, AGENT_GATE_DECISIONS } = require('../lib/agent-action-gate-adapter');
const { readCompatibleEnvironmentVariable } = require('../lib/environment-compat');

const MAX_STDIN_BYTES = 1024 * 1024;

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        reject(new Error('hook payload exceeds 1 MiB'));
        process.stdin.pause();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function resolveAllowlist(cwd) {
  const roots = [];
  if (typeof cwd === 'string' && cwd.trim()) roots.push(path.resolve(cwd.trim()));
  const extra = readCompatibleEnvironmentVariable('AGENT_GATE_ALLOWLIST');
  if (typeof extra === 'string' && extra.trim()) {
    for (const entry of extra.split(':')) {
      if (entry.trim()) roots.push(path.resolve(entry.trim()));
    }
  }
  return roots;
}

/**
 * Human-readable text for the host to show. It names the gate and what it
 * matched, never the payload: the command string, file contents and URL may be
 * attacker-supplied, and this text is surfaced and logged.
 */
function explain(verdict) {
  const parts = [`HUQAN ${verdict.decision.toUpperCase()}: ${verdict.reason}`];
  for (const finding of verdict.findings || []) {
    if (finding.gate === 'AB8' && finding.denylistMatch) {
      parts.push(`AB8 denylist: ${finding.denylistMatch.name || finding.denylistMatch}`);
    }
    if (finding.gate === 'AB8' && finding.outOfWorkspaceTarget) {
      parts.push('AB8: write target outside the workspace root');
    }
    if (finding.gate === 'AB1' && Array.isArray(finding.flags) && finding.flags.length > 0) {
      parts.push(`AB1 flags: ${finding.flags.join(', ')}`);
    }
    if (finding.gate === 'AB9' && (finding.piiDetected || finding.secretDetected)) {
      const kinds = [...(finding.piiTypes || [])];
      if (finding.secretDetected) kinds.push('secret');
      parts.push(`AB9: ${kinds.join(', ') || 'sensitive value'} in payload`);
    }
  }
  return parts.join(' | ');
}

/** Best-effort decision log. Records the verdict, never the tool payload. */
function appendAuditLine(payload, verdict) {
  const target = readCompatibleEnvironmentVariable('AGENT_GATE_LOG');
  if (!target) return;
  try {
    fs.appendFileSync(target, `${JSON.stringify({
      ts: new Date().toISOString(),
      sessionId: payload.session_id || null,
      tool: payload.tool_name || null,
      decision: verdict.decision,
      reason: verdict.reason,
      risk: verdict.risk?.level || null,
      adapterVersion: verdict.metadata?.adapterVersion || null,
    })}\n`, 'utf8');
  } catch {
    // A log that cannot be written must not change a safety decision.
  }
}

function emit(verdict) {
  if (verdict.decision === AGENT_GATE_DECISIONS.deny) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: explain(verdict),
      },
    })}\n`);
    return;
  }
  if (verdict.decision === AGENT_GATE_DECISIONS.ask) {
    process.stdout.write(`${JSON.stringify({ systemMessage: explain(verdict) })}\n`);
  }
  // allow: no output, so the host's own permission flow runs untouched.
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch (err) {
    // An unreadable payload is not an approvable one. Same rule the MCP
    // adapter applies to malformed input, stated here so the host shows the
    // user why rather than failing silently.
    emit({
      decision: AGENT_GATE_DECISIONS.deny,
      reason: `unreadable_hook_payload: ${err.message}`,
      findings: [],
    });
    return;
  }

  const verdict = evaluateAgentAction({
    toolName: payload.tool_name,
    toolInput: payload.tool_input,
    context: { cwd: payload.cwd, workspaceRoot: payload.cwd },
  }, { allowlistedPaths: resolveAllowlist(payload.cwd) });

  appendAuditLine(payload, verdict);
  emit(verdict);
}

main().catch((err) => {
  // Crashing here exits non-zero, which the host treats as a non-blocking
  // error and continues through its normal permission flow. Say so on stderr
  // rather than pretending a decision was made.
  process.stderr.write(`HUQAN agent action gate failed to run: ${err.message}\n`);
  process.exitCode = 1;
});

module.exports = { explain, resolveAllowlist };
