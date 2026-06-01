const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildDemoReport, formatDemoReport, runDemo } = require('./demo-causal-autolearn');

function pickStableFields(report) {
  return {
    title: report.title,
    input: report.input,
    mode: report.mode,
    causalChain: report.causalChain,
    relationProfile: report.relationProfile,
    affectedNodes: report.affectedNodes,
    riskLevel: report.riskLevel,
    conclusion: report.conclusion,
    recommendation: report.recommendation,
    nextQuestions: report.nextQuestions,
    evidence: report.evidence,
    unknowns: report.unknowns,
    lines: report.lines,
    text: report.text,
  };
}

describe('Causal demo - autoLearn default true', () => {
  it('buildDemoReport deterministic ve critical risk verir', () => {
    const first = buildDemoReport();
    const second = buildDemoReport();

    assert.deepStrictEqual(pickStableFields(second), pickStableFields(first));
    assert.strictEqual(first.mode, 'causal');
    assert.strictEqual(first.riskLevel, 'critical');
    assert.ok(first.causalChain.includes('autoLearn default true'));
    assert.ok(first.causalChain.includes('AXIOM reliability promise is damaged'));
    assert.ok(first.relationProfile.endsWith('PREVENTS'));
    assert.ok(first.recommendation.includes('not recommended'));
    assert.ok(first.conclusion.includes('Change is not recommended'));
    assert.ok(first.nextQuestions.length >= 2);
    assert.ok(first.evidence.length >= 4);
  });

  it('formatDemoReport stable text üretir', () => {
    const report = buildDemoReport();
    const firstText = formatDemoReport(report);
    const secondText = formatDemoReport(report);

    assert.strictEqual(secondText, firstText);
    assert.ok(firstText.includes('AXIOM v0.7 - What breaks if you do this?'));
    assert.ok(firstText.includes('Input: autoLearn default true olursa ne bozulur?'));
    assert.ok(firstText.includes('Risk level: critical'));
    assert.ok(firstText.includes('Recommendation: Change is not recommended.'));
    assert.ok(firstText.includes('Causal chain: autoLearn default true -> unsupported LLM output can enter graph -> graph trust degradation -> Shield claim weakens -> AXIOM reliability promise is damaged'));
  });

  it('runDemo print kapalıyken deterministik döner', () => {
    const first = runDemo({ print: false });
    const second = runDemo({ print: false });

    assert.deepStrictEqual(pickStableFields(second.report), pickStableFields(first.report));
    assert.strictEqual(second.text, first.text);
    assert.ok(first.text.includes('Risk level: critical'));
    assert.ok(first.text.includes('Evidence:'));
  });
});
