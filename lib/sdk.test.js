const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  createAxiomClient,
  evaluateShieldLikeResponse,
  runAxiomSdkCommand,
  toLangChainTool,
  toVercelAiMiddleware,
} = require('./sdk');

function createKernel(overrides = {}) {
  return {
    verify(statement) {
      return {
        ok: true,
        data: {
          status: 'dogrulandi',
          confidence: 0.91,
          statement,
        },
        evidence: [{ text: `verify:${statement}` }],
      };
    },
    reason(subject) {
      return {
        ok: true,
        data: {
          status: 'reasoned',
          confidence: 0.73,
          subject,
        },
        evidence: [{ text: `reason:${subject}` }],
      };
    },
    async runCapability(name, input, opts) {
      return {
        ok: true,
        data: {
          capability: name,
          input,
          opts,
        },
        evidence: [{ text: `capability:${name}` }],
        confidence: 0.66,
      };
    },
    hasCapability(name) {
      return name === 'evidenceRanking';
    },
    learnFromLLM(text, opts) {
      return {
        learned: text ? 1 : 0,
        text,
        opts,
      };
    },
    graph: {
      save() {
        return true;
      },
    },
    ...overrides,
  };
}

describe('sdk', () => {
  it('createAxiomClient exposes the SDK surface', () => {
    const client = createAxiomClient(createKernel());

    assert.strictEqual(typeof client.verify, 'function');
    assert.strictEqual(typeof client.reason, 'function');
    assert.strictEqual(typeof client.runCapability, 'function');
    assert.strictEqual(typeof client.shield, 'function');
    assert.strictEqual(typeof client.toLangChainTool, 'function');
    assert.strictEqual(typeof client.toVercelAiMiddleware, 'function');
  });

  it('createAxiomClient.runCapability falls back to kernel.plugins.runCapability', async () => {
    const kernel = {
      verify: () => ({ ok: true, data: { status: 'dogrulandi', confidence: 0.9 }, evidence: [] }),
      reason: () => ({ ok: true, data: { status: 'reasoned', confidence: 0.7 }, evidence: [] }),
      plugins: {
        async runCapability(name, input, opts) {
          return {
            ok: true,
            data: {
              capability: name,
              input,
              opts,
            },
            evidence: [{ text: `fallback:${name}` }],
          };
        },
      },
    };
    const client = createAxiomClient(kernel);
    const result = await client.runCapability('devilAdvocate', { text: 'AXIOM' }, { mode: 'fallback' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.capability, 'devilAdvocate');
    assert.deepStrictEqual(result.data.input, { text: 'AXIOM' });
    assert.deepStrictEqual(result.data.opts, { mode: 'fallback' });
  });

  it('toLangChainTool returns a plain tool object and dispatches known commands', async () => {
    const kernel = createKernel();
    const tool = toLangChainTool(kernel, { name: 'axiom-sdk' });

    assert.strictEqual(tool.name, 'axiom-sdk');
    assert.strictEqual(typeof tool.call, 'function');

    const verifyResult = await tool.call({ command: 'verify', input: 'kedi hayvandir' });
    assert.strictEqual(verifyResult.ok, true);
    assert.strictEqual(verifyResult.data.status, 'dogrulandi');

    const devilResult = await tool.call({ command: 'devil', input: 'AXIOM ana urun olmali' });
    assert.strictEqual(devilResult.ok, true);
    assert.strictEqual(devilResult.data.capability, 'devilAdvocate');

    const mriResult = await tool.call({ command: 'mri', input: 'AXIOM fikir yargilar' });
    assert.strictEqual(mriResult.ok, true);
    assert.strictEqual(mriResult.data.capability, 'ideaMri');
  });

  it('runAxiomSdkCommand rejects unknown commands', async () => {
    await assert.rejects(
      () => runAxiomSdkCommand(createKernel(), { command: 'unknown', input: 'x' }),
      /Unknown Axiom SDK command/
    );
  });

  it('toVercelAiMiddleware evaluates shield responses and keeps autoLearn off by default', async () => {
    const middleware = toVercelAiMiddleware(createKernel(), {});
    const result = await middleware({
      prompt: 'kedi neden uyur?',
      answer: 'kedi hayvandır',
    });

    assert.strictEqual(result.label, 'graph-backed');
    assert.strictEqual(result.shield.autoLearn, false);
    assert.strictEqual(result.shield.shouldLearn, false);
  });

  it('evaluateShieldLikeResponse returns shield metadata with disabled autoLearn', () => {
    const result = evaluateShieldLikeResponse(createKernel(), {
      question: 'kedi neden uyur?',
      answer: 'kedi hayvandır',
    });

    assert.strictEqual(result.label, 'graph-backed');
    assert.strictEqual(result.shield.autoLearn, false);
    assert.strictEqual(result.shield.source, 'graph');
  });
});
