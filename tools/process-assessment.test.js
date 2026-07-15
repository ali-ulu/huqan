'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTION_CATEGORIES, ACTION_DECISIONS } = require('../lib/action-risk-classifier');
const { RECOMMENDATIONS, assess } = require('./process-assessment');
const FIXED_NOW = '2026-07-15T20:00:00.000Z';

test('Cognera production ERP write remains BLOCK even when human approval is requested', () => {
  const result = assess({ profile: 'cognera', name: 'Fatura onayı', sourceRef: 'cognera:synthetic:invoice-approval-v1', workspaceId: 'cognera-pilot', now: FIXED_NOW, steps: [
    { description: 'Faturayı oku', actionType: ACTION_CATEGORIES.READ_ONLY, target: { path: 'invoices/sample.pdf' } },
    { description: 'ERP fatura kaydı oluştur', actionType: ACTION_CATEGORIES.PRODUCTION_MUTATION, target: { system: 'erp' }, humanApproval: true },
  ] });
  assert.equal(result.product, 'HUQAN'); assert.equal(result.engine, 'AXIOM'); assert.equal(result.profile.id, 'cognera'); assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.steps[1].policy.decision, ACTION_DECISIONS.BLOCK); assert.equal(result.steps[1].effectiveDecision, ACTION_DECISIONS.BLOCK); assert.equal(result.steps[1].recommendation, RECOMMENDATIONS.DO_NOT_AUTOMATE);
  assert.ok(result.steps[1].policy.trustReceipt); assert.equal(result.steps[1].trace.workspaceId, 'cognera-pilot'); assert.equal(result.steps[1].trace.sourceRef, 'cognera:synthetic:invoice-approval-v1');
});

test('Cognera allowlisted read-only step is ALLOW and contributes to potential savings', () => {
  const result = assess({ profile: 'cognera', name: 'Teknik talep kaynak kontrolü', allowlistedPaths: ['docs/request.md'], now: FIXED_NOW, monthlyVolume: 60, minutesPerCase: 20, steps: [{ description: 'Kaynak dokümanı oku', actionType: ACTION_CATEGORIES.READ_ONLY, target: { path: 'docs/request.md' } }] });
  assert.equal(result.verdict, 'ALLOW'); assert.equal(result.steps[0].policy.decision, ACTION_DECISIONS.ALLOW); assert.equal(result.steps[0].recommendation, RECOMMENDATIONS.AUTOMATE); assert.equal(result.summary.estimatedPotentialMonthlyHoursSaved, 20); assert.equal(result.summary.savingsCalculation.assumption, 'all process steps have equal effort');
});

test('BeeMagnetics missing engineering input escalates an otherwise read-only step to REVIEW', () => {
  const result = assess({ profile: 'beemagnetics', name: 'Magnetic design request review', allowlistedPaths: ['requests/design-42.json'], now: FIXED_NOW, steps: [{ description: 'Tasarım talebini değerlendir', actionType: ACTION_CATEGORIES.READ_ONLY, target: { path: 'requests/design-42.json' }, engineering: { requiredInputs: ['inputVoltage', 'outputVoltage', 'switchingFrequency'], suppliedInputs: ['inputVoltage', 'outputVoltage'] } }] });
  assert.equal(result.profile.id, 'beemagnetics'); assert.equal(result.steps[0].policy.decision, ACTION_DECISIONS.ALLOW); assert.equal(result.steps[0].effectiveDecision, ACTION_DECISIONS.HUMAN_REVIEW); assert.equal(result.steps[0].verdict, 'REVIEW'); assert.deepEqual(result.steps[0].profileAssessment.details.missingInputs, ['switchingFrequency']); assert.equal(result.steps[0].recommendation, RECOMMENDATIONS.AUTOMATE_WITH_HUMAN_APPROVAL);
});

test('BeeMagnetics customer-facing combined report requires engineer review and source references', () => {
  const result = assess({ profile: 'beemagnetics', name: 'System Level + Magnetic + EMI report', now: FIXED_NOW, steps: [{ description: 'Mühendislik araç çıktılarından müşteri raporu hazırla', actionType: ACTION_CATEGORIES.READ_ONLY, engineering: { requiredInputs: [], suppliedInputs: [], combinesToolOutputs: true, customerFacing: true, sourceRefs: [] } }] });
  assert.equal(result.verdict, 'REVIEW'); assert.match(result.steps[0].profileAssessment.reasons.join(' '), /source references/i); assert.match(result.steps[0].profileAssessment.reasons.join(' '), /engineer approval/i);
});

test('malformed process step fails closed as REVIEW', () => {
  const result = assess({ profile: 'cognera', now: FIXED_NOW, steps: ['not-an-object'] });
  assert.equal(result.verdict, 'REVIEW'); assert.equal(result.steps[0].policy.decision, ACTION_DECISIONS.HUMAN_REVIEW); assert.equal(result.steps[0].recommendation, RECOMMENDATIONS.AUTOMATE_WITH_HUMAN_APPROVAL);
});

test('aggregate precedence is BLOCK over REVIEW over DRY-RUN-ONLY over ALLOW', () => {
  const result = assess({ profile: 'cognera', allowlistedPaths: ['docs/ok.md'], now: FIXED_NOW, steps: [
    { description: 'Oku', actionType: ACTION_CATEGORIES.READ_ONLY, target: { path: 'docs/ok.md' } },
    { description: 'Simüle et', actionType: ACTION_CATEGORIES.SANDBOX_SIMULATION },
    { description: 'Tool chain çalıştır', actionType: ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION },
    { description: 'Production kaydı değiştir', actionType: ACTION_CATEGORIES.PRODUCTION_MUTATION },
  ] });
  assert.equal(result.verdict, 'BLOCK'); assert.equal(result.summary.allowed, 1); assert.equal(result.summary.dryRunOnly, 1); assert.equal(result.summary.reviewRequired, 1); assert.equal(result.summary.blocked, 1);
});

test('assessment output is deterministic for the same fixed input', () => {
  const input = { profile: 'beemagnetics', name: 'Determinism check', sourceRef: 'bee:fixture:v1', workspaceId: 'bee-pilot', now: FIXED_NOW, steps: [{ description: 'EMI sonucu incele', actionType: ACTION_CATEGORIES.READ_ONLY, engineering: { requiredInputs: ['emiPlot'], suppliedInputs: ['emiPlot'], sourceRefs: ['emi-tool:run-7'] } }] };
  assert.deepEqual(assess(input), assess(input));
});

test('assessment requires between one and fifteen steps', () => {
  assert.throws(() => assess({ profile: 'cognera', steps: [] }), /at least one/);
  assert.throws(() => assess({ profile: 'cognera', steps: Array.from({ length: 16 }, () => ({ description: 'read' })) }), /at most 15/);
});
