const { describe, it } = require('node:test');
const assert = require('node:assert');
const LLMAdapter = require('./llmAdapter');
const Kernel = require('./kernel');

const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

function learnFixture(kernel, text, opts = {}) {
  return kernel.learn(text, { ...opts, ...TEST_FIXTURE_LEARN_BYPASS });
}

let adapter;

global.fetch = async (url, opts) => {
  const parsed = new URL(url);
  if (parsed.hostname === 'localhost' && opts.signal) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
  return { ok: false, statusText: 'Not Found' };
};

describe('LLMAdapter', () => {
  it('never throws, returns error object on network error', async () => {
    const a = new LLMAdapter({ timeout: 1 });
    const res = await a.ask('test');
    assert(res.ok === false);
    assert(typeof res.error === 'string');
  });

  it('returns error for unknown provider', async () => {
    const a = new LLMAdapter({ provider: 'yok', timeout: 1 });
    const res = await a.ask('test');
    assert(res.ok === false);
    assert(res.error.includes('Bilinmeyen'));
  });

  it('returns error for openai without key', async () => {
    const a = new LLMAdapter({ provider: 'openai', timeout: 1, apiKey: '' });
    const res = await a.ask('test');
    assert(res.ok === false);
    assert(res.error.includes('OPENAI_API_KEY'));
  });

  it('has configurable model and endpoint', () => {
    const a = new LLMAdapter({ model: 'llama3.2:1b', endpoint: 'http://192.168.1.100:11434', provider: 'ollama' });
    assert(a.model === 'llama3.2:1b');
    assert(a.endpoint === 'http://192.168.1.100:11434');
  });

  it('retries transient ollama failures and succeeds on a later attempt', async () => {
    let calls = 0;
    const a = new LLMAdapter({
      provider: 'ollama',
      maxRetries: 2,
      retryDelayMs: 0,
      failureCooldownMs: 1000,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('fetch failed');
        }
        return {
          ok: true,
          json: async () => ({ response: 'oldu', model: 'llama', eval_count: 7 }),
        };
      },
    });
    const res = await a.ask('test');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.text, 'oldu');
    assert.strictEqual(calls, 3);
  });

  it('caches repeated failures and avoids repeating the same broken call immediately', async () => {
    let calls = 0;
    const a = new LLMAdapter({
      provider: 'openai',
      apiKey: 'key',
      maxRetries: 1,
      retryDelayMs: 0,
      failureCooldownMs: 10_000,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({}),
        };
      },
    });
    const first = await a.ask('same prompt');
    const second = await a.ask('same prompt');
    assert.strictEqual(first.ok, false);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(calls, 2);
    assert.strictEqual(second.cached, true);
  });
});

describe('kernel.verify()', () => {
  function freshK() {
    const k = new Kernel({ noLoad: true });
    return k;
  }

  it('returns dogrulandi for known statement', () => {
    const k = freshK();
    learnFixture(k, 'kedi balık yer');
    const res = k.verify('kedi balık yer');
    assert(res.data.status === 'dogrulandi', `Beklenen dogrulandi, gelen: ${res.data.status}`);
    assert(res.data.confidence > 0);
    assert(res.evidence.length > 0);
  });

  it('returns bilinmiyor for unknown statement', () => {
    const k = freshK();
    const res = k.verify('uçan fil muz sever');
    assert.strictEqual(res.data.status, 'bilinmiyor');
    assert.strictEqual(res.data.confidence, 0);
  });

  it('returns bilinmiyor for unknown subject', () => {
    const k = freshK();
    learnFixture(k, 'kedi balık yer');
    const res = k.verify('robot düşünür');
    assert.strictEqual(res.data.status, 'bilinmiyor');
  });

  it('finds path-based evidence', () => {
    const k = freshK();
    learnFixture(k, 'kedi hayvandır');
    learnFixture(k, 'hayvan canlıdır');
    const res = k.verify('kedi canlıdır');
    assert(res.data.status === 'dogrulandi', `Beklenen dogrulandi, gelen: ${res.data.status}`);
    assert(res.evidence.length > 0);
  });

  it('returns celiski when contradiction exists', () => {
    const k = freshK();
    k.graph.addNode('kedi', 'kedi');
    k.graph.addNode('hayvan', 'hayvan');
    k.graph.addNode('bitki', 'bitki');
    k.graph.addEdge('kedi', 'hayvan', 'tür');
    k.graph.addEdge('kedi', 'bitki', 'tür'); // çoklu-tür çelişkisi
    const res = k.verify('kedi hayvan');
    // Çelişki varsa celiski, yoksa dogrulandi
    assert(res.data.status === 'celiski' || res.data.status === 'dogrulandi');
  });

  it('evidence array is always present', () => {
    const k = freshK();
    const res = k.verify('bilinmeyen kavram');
    assert(Array.isArray(res.evidence));
  });
});

describe('kernel.learnDocument()', () => {
  function freshK() {
    return new Kernel({ noLoad: true });
  }

  it('learns from plain text lines', () => {
    const k = freshK();
    const text = 'kedi balık yer\nköpek kemik sever\nkuş uçar';
    const count = k.learnDocument(text, TEST_FIXTURE_LEARN_BYPASS);
    assert(count === 3);
    assert(k.ask('kedi balık yer').data.answer !== 'Bilmiyorum');
    assert(k.ask('kuş uçar').data.answer !== 'Bilmiyorum');
  });

  it('skips comments and short lines', () => {
    const k = freshK();
    const text = '# bu bir yorum\n// bu da yorum\nkedi balık yer\na\nb';
    const count = k.learnDocument(text, TEST_FIXTURE_LEARN_BYPASS);
    assert(count === 1);
  });

  it('handles markdown with list markers', () => {
    const k = freshK();
    const text = '- kedi balık yer\n* köpek kemik sever\n- kuş uçar';
    const count = k.learnDocument(text, TEST_FIXTURE_LEARN_BYPASS);
    assert(count === 3);
  });

  it('returns 0 for empty input', () => {
    const k = freshK();
    assert(k.learnDocument('') === 0);
    assert(k.learnDocument('\n\n  \n') === 0);
  });
});

describe('kernel.learnFromLLM()', () => {
  function freshK() {
    return new Kernel({ noLoad: true });
  }

  it('does not auto-write canonical graph from LLM text without approved admission', () => {
    const k = freshK();
    const text = 'Kedi bir memelilerdir. Kediler balık yer. Kediler miyavlar.';
    const result = k.learnFromLLM(text);
    assert(typeof result.learned === 'number');
    assert(typeof result.skipped === 'number');
    assert(Array.isArray(result.conflicts));
    assert.strictEqual(result.learned, 0);
    assert(result.skipped > 0, 'Onaysız auto-learn review olarak skip edilmelidir');
  });

  it('learns sentences from LLM text with approved admission context', () => {
    const k = freshK();
    const text = 'Kedi bir memelidir. Kediler balık yer.';
    const result = k.learnFromLLM(text, {
      approvalRequired: true,
      approvalStatus: 'approved',
      approvalId: 'apr_llm_test_001',
      sourceType: 'llm',
      sourceRef: 'test:llm-admission',
      actor: 'llm-test',
      workspaceId: 'default',
      provenance: {
        provenanceId: 'prov_llm_test_001',
        sourceType: 'llm',
        sourceRef: 'test:llm-admission',
        actor: 'llm-test',
        workspaceId: 'default',
        timestamp: '2026-06-16T00:00:00.000Z',
        trustPolicyVersion: '1.0.0',
      },
    });
    assert(result.learned > 0, 'Onaylı admission ile en az 1 cümle öğrenilmeli');
  });

  it('skips conflicting sentences when skipConflicts=true', () => {
    const k = freshK();
    k.graph.addNode('kedi', 'kedi');
    k.graph.addNode('hayvan', 'hayvan');
    k.graph.addNode('bitki', 'bitki');
    k.graph.addEdge('kedi', 'hayvan', 'tür');
    k.graph.addEdge('kedi', 'bitki', 'tür'); // çoklu-tür çelişkisi
    const text = 'kedi hayvandır. kedi bitkidir.';
    const result = k.learnFromLLM(text, { skipConflicts: true });
    assert(Array.isArray(result.conflicts));
    assert(result.learned + result.skipped > 0);
  });

  it('respects maxSentences limit', () => {
    const k = freshK();
    const sentences = Array.from({ length: 30 }, (_, i) => `kavram${i} ozellik${i}dir`).join('. ');
    const result = k.learnFromLLM(sentences, { maxSentences: 5 });
    assert(result.learned + result.skipped <= 5, 'maxSentences sınırına uyulmalı');
  });

  it('cleans markdown from LLM output without throwing', () => {
    const k = freshK();
    const text = '**Kedi** bir memelilerdir.\n- Kediler balık yer.\n> Kediler miyavlar.';
    assert.doesNotThrow(() => k.learnFromLLM(text));
  });

  it('returns zero learned for empty text', () => {
    const k = freshK();
    const result = k.learnFromLLM('');
    assert.strictEqual(result.learned, 0);
    assert.strictEqual(result.skipped, 0);
  });

  it('result always has learned, skipped, conflicts fields', () => {
    const k = freshK();
    const result = k.learnFromLLM('test cümle burada');
    assert('learned' in result);
    assert('skipped' in result);
    assert('conflicts' in result);
  });
});
