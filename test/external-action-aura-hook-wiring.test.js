'use strict';

// #3843: the live AURA producer on the hook path.
//
// Step A (lib/external-action-guard.js) made the egress seam reachable: the
// gate plants a canary only when `options.signalProvider` names AURA signals.
// These tests drive the real CLI (bin/huqan-gate-hook.js) end to end and prove
// the producer is wired: with `--aura-signals` an AURA-flagged context reaches
// AB14 and blocks, and without it the same call is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'bin', 'huqan-gate-hook.js');
const pack = require('../fixtures/aura/aura-signal-pack.json');
const AURA_TEXT = pack.cases.find((entry) => entry.case_id === 'M-CASE-001').scenario_texts[0];

// The identity default is owned elsewhere (test/external-action-identity.test.js);
// these tests are about the egress plant, so opt out the way the other hook
// tests do.
const ENV = Object.freeze({
  ...process.env,
  HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: 'allow',
  HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: 'allow',
  HUQAN_GATE_AURA_SIGNALS: '',
});

function runHook(payload, extraArgs = [], env = ENV) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-hook-'));
  const receiptLog = path.join(dir, 'receipts.jsonl');
  const result = spawnSync(process.execPath, [
    hook,
    '--profile', 'generic',
    '--workspace-root', root,
    '--receipt-log', receiptLog,
    '--memory-path', path.join(dir, 'memory.json'),
    '--db-path', path.join(dir, 'memory.db'),
    ...extraArgs,
  ], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8', env });
  return { ...result, receiptLog };
}

// A generic-profile invocation: the payload is the envelope itself. `text`
// under args is what plugins/aura-risk.js#candidateTextFromEvent reads.
function genericPayload(args) {
  return {
    invocationId: `aura-cli-${Date.now()}`,
    agentName: 'aura-cli-agent',
    sessionId: 'aura-cli-session',
    toolName: 'shell',
    args,
    cwd: root,
    workspaceRoot: root,
  };
}

function decisionOf(process) {
  const out = `${process.stdout || ''}`.trim().split('\n').filter(Boolean);
  for (let i = out.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(out[i]);
      if (parsed && typeof parsed.decision === 'string') return parsed;
    } catch (_) { /* not a JSON line */ }
  }
  return null;
}

test('with --aura-signals an AURA-flagged egress action is blocked by the canary plant', () => {
  const process = runHook(genericPayload({ text: AURA_TEXT }), ['--aura-signals']);
  const projected = decisionOf(process);
  assert.equal(projected.decision, 'block');
  assert.equal(projected.reason, 'context_canary_tripwire');
  // The receipt proves the plant: AB14 carries the fingerprint, never the marker.
  const receipt = JSON.parse(fs.readFileSync(process.receiptLog, 'utf8').trim().split('\n').pop());
  const ab14 = (receipt.metadata.findings || []).find((finding) => finding.gate === 'AB14');
  assert.equal(ab14.decision, 'block');
  assert.equal(ab14.reason, 'context_canary_tripwire');
  assert.ok((ab14.canaryFingerprints || []).length > 0, 'a canary fingerprint is recorded');
  assert.doesNotMatch(fs.readFileSync(process.receiptLog, 'utf8'), /huqan-canary-v/);
});

test('without --aura-signals the same AURA-flagged call is unchanged', () => {
  const process = runHook(genericPayload({ text: AURA_TEXT }));
  const projected = decisionOf(process);
  assert.notEqual(projected.decision, 'block');
  assert.equal(projected.reason, 'external_action_review_required');
});

test('a benign call is allowed even with --aura-signals', () => {
  const process = runHook(genericPayload({ text: 'list the files in the repo' }), ['--aura-signals']);
  const projected = decisionOf(process);
  assert.notEqual(projected.decision, 'block');
});
