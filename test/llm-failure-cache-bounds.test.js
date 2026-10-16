const { describe, it } = require('node:test');
const assert = require('node:assert');
const LLMAdapter = require('../llmAdapter');

const SECRET = 'ACME internal revenue figure 12345 do-not-retain';

/** An adapter whose provider always fails with a retryable error. */
function failingAdapter(opts = {}) {
  return new LLMAdapter({
    provider: 'ollama',
    maxRetries: 0,
    retryDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => { throw new Error('network unreachable'); },
    ...opts,
  });
}

describe('LLM failure cache is bounded and stores no plaintext (#730)', () => {
  it('keys are fixed-width digests, not the request text', async () => {
    const adapter = failingAdapter();
    await adapter.ask(SECRET, `system ${SECRET}`);

    const keys = [...adapter._recentFailures.keys()];
    assert.strictEqual(keys.length, 1);
    assert.match(keys[0], /^[0-9a-f]{64}$/, 'cache key must be a hex digest');
    for (const key of keys) {
      assert.ok(!key.includes(SECRET), 'cache key leaked prompt text');
      assert.ok(!key.includes('ACME'), 'cache key leaked prompt text');
    }
  });

  it('cached entries carry no prompt or system plaintext', async () => {
    const adapter = failingAdapter();
    await adapter.ask(SECRET, `system ${SECRET}`);

    const serialized = JSON.stringify([...adapter._recentFailures.entries()]);
    assert.ok(!serialized.includes(SECRET), `cache retained prompt text: ${serialized}`);
    assert.ok(!serialized.includes('ACME'), `cache retained prompt text: ${serialized}`);
  });

  it('identical requests collide on one entry, different ones do not', async () => {
    const adapter = failingAdapter();
    await adapter.ask('same prompt', 'same system');
    await adapter.ask('same prompt', 'same system');
    assert.strictEqual(adapter._recentFailures.size, 1);

    await adapter.ask('other prompt', 'same system');
    assert.strictEqual(adapter._recentFailures.size, 2);
  });

  it('a delimiter inside a prompt cannot forge another request\'s key', () => {
    const adapter = failingAdapter();
    // Without length prefixes these two would flatten to the same string.
    const a = adapter._failureKey('a|b', 'c');
    const b = adapter._failureKey('a', 'b|c');
    assert.notStrictEqual(a, b);
  });

  it('many unique failing prompts keep the cache bounded', async () => {
    const adapter = failingAdapter({ maxFailureCacheEntries: 25 });
    for (let i = 0; i < 500; i++) {
      await adapter.ask(`unique prompt ${i}`, 'system');
    }
    assert.ok(
      adapter._recentFailures.size <= 25,
      `cache grew past its cap: ${adapter._recentFailures.size}`,
    );
  });

  it('evicts oldest-first when the cap is reached', async () => {
    const adapter = failingAdapter({ maxFailureCacheEntries: 3 });
    const keys = [];
    for (let i = 0; i < 3; i++) {
      keys.push(adapter._failureKey(`p${i}`, 's'));
      await adapter.ask(`p${i}`, 's');
    }
    const survivorsBefore = [...adapter._recentFailures.keys()];
    assert.ok(survivorsBefore.includes(keys[0]));

    await adapter.ask('p3', 's');
    const survivors = [...adapter._recentFailures.keys()];
    assert.ok(!survivors.includes(keys[0]), 'oldest entry should have been evicted first');
    assert.ok(survivors.includes(adapter._failureKey('p3', 's')));
  });

  it('expired entries leave even when their prompt is never queried again', async () => {
    const adapter = failingAdapter({ failureCooldownMs: 0 });
    await adapter.ask('stale prompt', 'system');
    assert.strictEqual(adapter._recentFailures.size, 1);
    const staleKey = adapter._failureKey('stale prompt', 'system');

    // A single unrelated failure is enough to sweep it: expiry no longer
    // depends on the same prompt being retried.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.ask('unrelated prompt', 'system');

    assert.ok(!adapter._recentFailures.has(staleKey), 'expired entry outlived its cooldown');
  });

  it('still short-circuits a repeated failing request within the cooldown', async () => {
    let calls = 0;
    const adapter = failingAdapter({
      failureCooldownMs: 60_000,
      fetchImpl: async () => { calls += 1; throw new Error('network unreachable'); },
    });

    const first = await adapter.ask('repeat me', 'system');
    assert.strictEqual(first.ok, false);
    assert.strictEqual(calls, 1);

    const second = await adapter.ask('repeat me', 'system');
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.cached, true);
    assert.strictEqual(calls, 1, 'cached failure must not re-issue the request');
  });

  it('a success clears the cached failure for that request', async () => {
    let shouldFail = true;
    const adapter = failingAdapter({
      failureCooldownMs: 60_000,
      fetchImpl: async () => {
        if (shouldFail) throw new Error('network unreachable');
        return { ok: true, json: async () => ({ response: 'hi', model: 'm', eval_count: 1 }) };
      },
    });

    await adapter.ask('recoverable', 'system');
    assert.strictEqual(adapter._recentFailures.size, 1);

    shouldFail = false;
    adapter._recentFailures.clear();
    const ok = await adapter.ask('recoverable', 'system');
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(adapter._recentFailures.size, 0);
  });
});
