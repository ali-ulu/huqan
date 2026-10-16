'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { applyDerivation } = require('../lib/coder/apply-derivation');
const { SELF_HEALER_DECISIONS } = require('../lib/self-healer/safety-decision');
const { FIX_PRODUCER_REFUSALS, proposeConcreteFix } = require('../lib/self-healer/fix-producer');

function verifiedFailure(overrides = {}) {
  return {
    kind: 'failure_record',
    schemaVersion: '1.0.0',
    failureId: 'failure-fix-1',
    verificationStatus: 'verified',
    action: { operation: 'replace_text', path: 'docs/notes.md' },
    observed: 'version v1.0.0\n',
    expected: 'version v1.1.0\n',
    evidence: [],
    ...overrides,
  };
}

function finding(overrides = {}) {
  return {
    findingId: 'finding-1',
    kind: 'stale_docs',
    severity: 'low',
    title: 'stale docs',
    summary: 'a doc file is stale',
    evidence: [{ type: 'file', ref: 'docs/notes.md', detail: 'stale' }],
    affectedFiles: ['docs/notes.md'],
    suggestedFix: { summary: 'update the doc', allowedFiles: ['docs/notes.md'], forbiddenFiles: [], risk: 'low' },
    riskFlags: [],
    workspaceId: 'default',
    ...overrides,
  };
}

describe('self-healer fix producer', () => {
  it('produces a concrete coder task when the decision permits review and a record is supplied', () => {
    const result = proposeConcreteFix(finding(), { failure: verifiedFailure() });

    assert.equal(result.applied, false);
    assert.equal(result.decision, SELF_HEALER_DECISIONS.PROPOSE);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.proposal.operation.type, 'replace_text');
    assert.equal(result.proposal.operation.find, 'version v1.0.0\n');
    assert.equal(result.proposal.operation.replace, 'version v1.1.0\n');
    assert.equal(result.refusal, null);
  });

  it('refuses a permitted decision whose finding names no verified record', () => {
    const result = proposeConcreteFix(finding());

    assert.equal(result.applied, false);
    assert.equal(result.proposal, null);
    assert.equal(result.refusal.reason, FIX_PRODUCER_REFUSALS.NO_FAILURE_RECORD);
  });

  it('refuses an observe/block/quarantine decision without this module adding a rule', () => {
    // No evidence -> observe. A destructive flag -> block. Insufficient
    // evidence -> quarantine. None carries `human_review`, so all refuse.
    const noEvidence = proposeConcreteFix(finding({ evidence: [] }), { failure: verifiedFailure() });
    assert.equal(noEvidence.decision, SELF_HEALER_DECISIONS.OBSERVE);
    assert.equal(noEvidence.proposal, null);
    assert.equal(noEvidence.refusal.reason, FIX_PRODUCER_REFUSALS.DECISION_DOES_NOT_PERMIT_PROPOSAL);

    const blocked = proposeConcreteFix(finding({ riskFlags: ['destructive_action'] }), { failure: verifiedFailure() });
    assert.equal(blocked.decision, SELF_HEALER_DECISIONS.BLOCK);
    assert.equal(blocked.proposal, null);

    const quarantined = proposeConcreteFix(finding({ riskFlags: ['insufficient_evidence'] }), { failure: verifiedFailure() });
    assert.equal(quarantined.decision, SELF_HEALER_DECISIONS.QUARANTINE);
    assert.equal(quarantined.proposal, null);
  });

  it('refuses when the record cannot be projected, naming the producer reason', () => {
    const result = proposeConcreteFix(finding(), { failure: verifiedFailure({ verificationStatus: 'candidate' }) });

    assert.equal(result.proposal, null);
    assert.equal(result.refusal.reason, FIX_PRODUCER_REFUSALS.NO_FAILURE_RECORD);
    assert.equal(result.refusal.producerReason, 'FAILURE_NOT_VERIFIED');
  });

  it('refuses a proposal that lands outside the finding\'s own allowed files', () => {
    const result = proposeConcreteFix(
      finding({ suggestedFix: { summary: 'x', allowedFiles: ['docs/other.md'], forbiddenFiles: [], risk: 'low' } }),
      { failure: verifiedFailure() },
    );

    assert.equal(result.proposal, null);
    assert.equal(result.refusal.reason, FIX_PRODUCER_REFUSALS.PROPOSAL_OUTSIDE_ALLOWED_FILES);
  });

  it('never applies: a produced proposal still has to clear the coder gate', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-fix-'));
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib', 'example.js'), 'const VERSION = "1.0.0";\n');

    const result = proposeConcreteFix(
      finding({
        affectedFiles: ['lib/example.js'],
        suggestedFix: { summary: 'bump version', allowedFiles: ['lib/example.js'], forbiddenFiles: [], risk: 'low' },
      }),
      {
        failure: verifiedFailure({
          action: { operation: 'replace_text', path: 'lib/example.js' },
          observed: 'const VERSION = "1.0.0";\n',
          expected: 'const VERSION = "1.1.0";\n',
        }),
      },
    );
    assert.equal(result.applied, false);
    assert.equal(result.proposal.operation.path, 'lib/example.js');

    // The proposal is an ordinary task; the gate decides it, not this module.
    // A source-file change without an explicit review authorisation is refused.
    const decision = applyDerivation({
      task: result.proposal,
      root,
      repoState: { branch: 'feat/self-healer-fix', dirty: false, hasUntracked: false },
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'GATE_REFUSED');
    assert.equal(decision.detail, 'SOURCE_CHANGE_REQUIRES_REVIEW');
  });
});
