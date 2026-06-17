const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLlmSor, evaluateLlmSor, normalizeCheck } = require('./shield');

function makeKernel(overrides = {}) {
  let saveCalls = 0;
  const learnCalls = [];
  const verifyCalls = [];
  const kernel = {
    verify(text) {
      verifyCalls.push(text);
      if (typeof overrides.verify === 'function') return overrides.verify(text);
      return { data: { status: 'bilinmiyor', confidence: 0 } };
    },
    learnFromLLM(text, opts = {}) {
      learnCalls.push({ text, opts });
      if (typeof overrides.learnFromLLM === 'function') return overrides.learnFromLLM(text, opts);
      return { learned: 1, skipped: 0, conflicts: [] };
    },
    graph: {
      save() {
        saveCalls += 1;
      },
    },
  };
  return { kernel, learnCalls, verifyCalls, getSaveCalls: () => saveCalls };
}

test('normalizeCheck reads envelope data', () => {
  const normalized = normalizeCheck({ data: { status: 'dogrulandi', confidence: 0.8 } });
  assert.strictEqual(normalized.status, 'dogrulandi');
  assert.strictEqual(normalized.confidence, 0.8);
});

test('classifyLlmSor returns graph-backed, llm-assisted, unsupported, contradicted', () => {
  assert.strictEqual(
    classifyLlmSor({ data: { status: 'dogrulandi', confidence: 0.9 } }, { data: { status: 'dogrulandi', confidence: 0.7 } }),
    'graph-backed',
  );
  assert.strictEqual(
    classifyLlmSor({ data: { status: 'dogrulandi', confidence: 0.9 } }, { data: { status: 'bilinmiyor', confidence: 0 } }),
    'llm-assisted',
  );
  assert.strictEqual(
    classifyLlmSor({ data: { status: 'bilinmiyor', confidence: 0 } }, { data: { status: 'bilinmiyor', confidence: 0 } }),
    'unsupported',
  );
  assert.strictEqual(
    classifyLlmSor({ data: { status: 'celiski', confidence: 0.9 } }, { data: { status: 'dogrulandi', confidence: 0.7 } }),
    'contradicted',
  );
});

test('evaluateLlmSor keeps autoLearn off by default', () => {
  const { kernel, learnCalls, verifyCalls, getSaveCalls } = makeKernel({
    verify(text) {
      if (text.includes('question')) return { data: { status: 'dogrulandi', confidence: 0.9 } };
      return { data: { status: 'dogrulandi', confidence: 0.8 } };
    },
  });

  const result = evaluateLlmSor({
    kernel,
    question: 'question',
    llmText: 'answer',
    axiomCheck: { data: { status: 'dogrulandi', confidence: 0.9 } },
    llmCheck: { data: { status: 'dogrulandi', confidence: 0.8 } },
  });

  assert.strictEqual(result.label, 'graph-backed');
  assert.strictEqual(result.shield.autoLearn, false);
  assert.strictEqual(result.shield.shouldLearn, false);
  assert.strictEqual(result.learnResult, null);
  assert.strictEqual(learnCalls.length, 0);
  assert.strictEqual(getSaveCalls(), 0);
  assert.strictEqual(verifyCalls.length, 0);
});

test('evaluateLlmSor returns partialVerification=null when llmText fits within verified prefix', () => {
  const { kernel } = makeKernel();
  const result = evaluateLlmSor({
    kernel,
    question: 'question',
    llmText: 'short answer',
    axiomCheck: { data: { status: 'dogrulandi', confidence: 0.95 } },
    llmCheck: { data: { status: 'dogrulandi', confidence: 0.75 } },
    autoLearn: true,
  });
  assert.strictEqual(result.partialVerification, null);
});

test('evaluateLlmSor marks partialVerification when llmText exceeds 300 chars', () => {
  const { kernel } = makeKernel();
  const longText = 'a'.repeat(450);
  const result = evaluateLlmSor({
    kernel,
    question: 'question',
    llmText: longText,
    axiomCheck: { data: { status: 'dogrulandi', confidence: 0.95 } },
    llmCheck: { data: { status: 'dogrulandi', confidence: 0.75 } },
    autoLearn: true,
  });
  assert.ok(result.partialVerification, 'partialVerification should be set for long text');
  assert.strictEqual(result.partialVerification.verifiedPrefix, 300);
  assert.strictEqual(result.partialVerification.totalLength, 450);
  assert.strictEqual(result.partialVerification.fullTextVerified, true);
});

test('evaluateLlmSor does not treat safe prefix as safe when contradiction appears after 300 chars', () => {
  const safePrefix = 'g'.repeat(300);
  const unsafeTail = ' sonrasinda celiski var';
  const longText = `${safePrefix}${unsafeTail}`;
  const { kernel, verifyCalls } = makeKernel({
    verify(text) {
      if (text === 'question') {
        return { data: { status: 'dogrulandi', confidence: 0.95 } };
      }
      if (text.includes('celiski var')) {
        return { data: { status: 'celiski', confidence: 0.95 } };
      }
      return { data: { status: 'dogrulandi', confidence: 0.8 } };
    },
  });

  const result = evaluateLlmSor({
    kernel,
    question: 'question',
    llmText: longText,
    axiomCheck: { data: { status: 'dogrulandi', confidence: 0.95 } },
    autoLearn: false,
  });

  assert.strictEqual(result.llmCheck.status, 'celiski');
  assert.strictEqual(result.label, 'contradicted');
  assert.ok(result.partialVerification);
  assert.strictEqual(verifyCalls.length, 1);
  assert.strictEqual(verifyCalls[0], longText);
});

test('evaluateLlmSor returns structured failure when kernel.learnFromLLM throws', () => {
  const { kernel } = makeKernel({
    learnFromLLM() {
      throw new Error('memory store is corrupt');
    },
  });
  const result = evaluateLlmSor({
    kernel,
    question: 'question',
    llmText: 'answer',
    axiomCheck: { data: { status: 'dogrulandi', confidence: 0.95 } },
    llmCheck: { data: { status: 'dogrulandi', confidence: 0.75 } },
    autoLearn: true,
  });
  assert.strictEqual(result.shield.shouldLearn, true);
  assert.ok(result.learnResult, 'learnResult must be present even on failure');
  assert.strictEqual(result.learnResult.ok, false);
  assert.strictEqual(result.learnResult.error.code, 'LEARN_FAILED');
  assert.match(result.learnResult.error.message, /memory store is corrupt/);
});

test('evaluateLlmSor learns only when explicitly enabled and never for unsupported or contradicted', () => {
  const graphBacked = makeKernel({
    verify(text) {
      if (text.includes('question')) return { data: { status: 'dogrulandi', confidence: 0.95 } };
      return { data: { status: 'dogrulandi', confidence: 0.75 } };
    },
  });

  const learned = evaluateLlmSor({
    kernel: graphBacked.kernel,
    question: 'question',
    llmText: 'answer',
    axiomCheck: { data: { status: 'dogrulandi', confidence: 0.95 } },
    llmCheck: { data: { status: 'dogrulandi', confidence: 0.75 } },
    autoLearn: true,
  });
  assert.strictEqual(learned.shield.shouldLearn, true);
  assert.strictEqual(learned.learnResult.learned, 1);
  assert.strictEqual(graphBacked.learnCalls[0].opts.source, 'graph');
  assert.strictEqual(graphBacked.getSaveCalls(), 1);

  const unsupported = makeKernel();
  const unsupportedResult = evaluateLlmSor({
    kernel: unsupported.kernel,
    question: 'question',
    llmText: 'answer',
    axiomCheck: { data: { status: 'bilinmiyor', confidence: 0 } },
    llmCheck: { data: { status: 'bilinmiyor', confidence: 0 } },
    autoLearn: true,
  });
  assert.strictEqual(unsupportedResult.label, 'unsupported');
  assert.strictEqual(unsupportedResult.shield.shouldLearn, false);
  assert.strictEqual(unsupportedResult.learnResult, null);
  assert.strictEqual(unsupported.learnCalls.length, 0);

  const contradicted = makeKernel();
  const contradictedResult = evaluateLlmSor({
    kernel: contradicted.kernel,
    question: 'question',
    llmText: 'answer',
    axiomCheck: { data: { status: 'celiski', confidence: 0.9 } },
    llmCheck: { data: { status: 'dogrulandi', confidence: 0.8 } },
    autoLearn: true,
  });
  assert.strictEqual(contradictedResult.label, 'contradicted');
  assert.strictEqual(contradictedResult.shield.shouldLearn, false);
  assert.strictEqual(contradictedResult.learnResult, null);
  assert.strictEqual(contradicted.learnCalls.length, 0);
});

test('evaluateLlmSor surfaces review-only autoLearn results without saving graph state', () => {
  const { kernel, getSaveCalls } = makeKernel({
    verify(text) {
      if (text.includes('question')) return { data: { status: 'dogrulandi', confidence: 0.95 } };
      return { data: { status: 'dogrulandi', confidence: 0.75 } };
    },
    learnFromLLM() {
      return {
        learned: 0,
        skipped: 1,
        conflicts: [],
        data: {
          admission: {
            outcome: 'review',
            reason: 'approval_required',
          },
        },
      };
    },
  });

  const result = evaluateLlmSor({
    kernel,
    question: 'question',
    llmText: 'answer',
    axiomCheck: { data: { status: 'dogrulandi', confidence: 0.95 } },
    llmCheck: { data: { status: 'dogrulandi', confidence: 0.75 } },
    autoLearn: true,
  });

  assert.strictEqual(result.shield.shouldLearn, true);
  assert.ok(result.learnResult);
  assert.strictEqual(result.learnResult.learned, 0);
  assert.strictEqual(result.learnResult.data.admission.outcome, 'review');
  assert.strictEqual(getSaveCalls(), 0);
});
