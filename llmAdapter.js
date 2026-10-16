const crypto = require('crypto');

// Upper bound on distinct failure entries kept in memory (#730). Sustained
// provider failure with unique prompts would otherwise grow the map forever.
const DEFAULT_MAX_FAILURE_CACHE_ENTRIES = 500;

class LLMAdapter {
  constructor(opts = {}) {
    // `PARANOID=1` is the same environment switch kernel.js reads for
    // kernel.paranoidMode, so the adapter refuses under exactly the setting
    // the operator turned on.
    this.paranoidMode = opts.paranoidMode === true || process.env.PARANOID === '1';
    this.provider = opts.provider || 'ollama';
    this.model = opts.model || (this.provider === 'ollama' ? 'llama3.2:3b' : 'gpt-4o-mini');
    this.endpoint = opts.endpoint || 'http://localhost:11434';
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : (process.env.OPENAI_API_KEY || '');
    this.timeout = opts.timeout || 30000;
    this.maxRetries = Number.isInteger(opts.maxRetries) ? Math.max(0, opts.maxRetries) : 3;
    this.retryDelayMs = Number.isInteger(opts.retryDelayMs) ? Math.max(0, opts.retryDelayMs) : 250;
    this.failureCooldownMs = Number.isInteger(opts.failureCooldownMs) ? Math.max(0, opts.failureCooldownMs) : 60_000;
    this.fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
    this.sleepImpl = typeof opts.sleepImpl === 'function'
      ? opts.sleepImpl
      : (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.maxFailureCacheEntries = Number.isInteger(opts.maxFailureCacheEntries)
      ? Math.max(1, opts.maxFailureCacheEntries)
      : DEFAULT_MAX_FAILURE_CACHE_ENTRIES;
    this._recentFailures = new Map();
  }

  async ask(prompt, system) {
    try {
      // Second guard, at the boundary that actually reaches the network. The
      // plugin above checks kernel.paranoidMode; this catches any other caller
      // that forgets, for the environment-variable form of the same setting.
      // A refusal here never sends the prompt anywhere.
      if (this.paranoidMode) {
        return { ok: false, error: 'Paranoid mode is active: outbound LLM calls are blocked.', provider: this.provider };
      }
      const key = this._failureKey(prompt, system);
      const cachedFailure = this._getCachedFailure(key);
      if (cachedFailure) {
        return { ok: false, error: cachedFailure.error, cached: true, provider: this.provider };
      }
      if (this.provider === 'ollama') return await this._ollama(prompt, system);
      if (this.provider === 'openai') return await this._openai(prompt, system);
      return { ok: false, error: 'Bilinmeyen sağlayıcı: ' + this.provider };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Fixed-width digest, not the request text (#730).
   *
   * The key used to be provider|endpoint|model|prompt|system concatenated
   * verbatim, so every failed request left its full prompt and system message
   * resident in the Map — reachable long after failureCooldownMs, since
   * expired entries were only dropped when that exact prompt was retried.
   * Prompts can carry user and company text (plugins/company-brain.js routes
   * questions through this adapter), so that was unbounded retention of
   * potentially sensitive material as well as unbounded growth.
   *
   * The digest keeps identical requests colliding on the same entry while
   * storing no plaintext. Lengths are prefixed so that a '|' inside a prompt
   * cannot make two different requests hash alike.
   */
  _failureKey(prompt, system) {
    const parts = [this.provider, this.endpoint, this.model, String(prompt || '').trim(), String(system || '').trim()];
    const payload = parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  /**
   * Drop every entry past its cooldown, then hold the map under its cap.
   *
   * The sweep runs on write rather than only on lookup, so an entry whose
   * prompt is never retried still leaves. Eviction is insertion-ordered:
   * oldest first, which is deterministic for a given sequence of failures.
   */
  _pruneFailures(now = Date.now()) {
    for (const [key, entry] of this._recentFailures) {
      if (now > entry.until) this._recentFailures.delete(key);
    }
    while (this._recentFailures.size >= this.maxFailureCacheEntries) {
      const oldest = this._recentFailures.keys().next();
      if (oldest.done) break;
      this._recentFailures.delete(oldest.value);
    }
  }

  _cacheFailure(key, error) {
    const now = Date.now();
    // Delete first so a refreshed entry moves to the back of the eviction
    // order instead of keeping its original position.
    this._recentFailures.delete(key);
    this._pruneFailures(now);
    this._recentFailures.set(key, {
      error,
      until: now + this.failureCooldownMs,
    });
  }

  _getCachedFailure(key) {
    const entry = this._recentFailures.get(key);
    if (!entry) return null;
    if (Date.now() > entry.until) {
      this._recentFailures.delete(key);
      return null;
    }
    return entry;
  }

  _sleep(ms) {
    return this.sleepImpl(Math.max(0, ms));
  }

  _isRetryableError(err) {
    if (!err) return false;
    const text = String(err.message || err.error || err).toLowerCase();
    return /abort|timeout|fetch|network|econn|enotfound|etimedout|eai_again|503|502|504|429/.test(text);
  }

  async _withRetry(key, fn) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const result = await fn(attempt);
        if (result && result.ok === false) {
          lastError = new Error(result.error || 'Bilinmeyen hata');
          if (!this._isRetryableError(lastError) || attempt >= this.maxRetries) {
            this._cacheFailure(key, lastError.message);
            return result;
          }
        } else {
          this._recentFailures.delete(key);
          return result;
        }
      } catch (err) {
        lastError = err;
        if (!this._isRetryableError(err) || attempt >= this.maxRetries) {
          this._cacheFailure(key, err.message);
          return { ok: false, error: err.message };
        }
      }

      const wait = this.retryDelayMs * Math.max(1, attempt + 1);
      await this._sleep(wait);
    }
    this._cacheFailure(key, lastError ? lastError.message : 'Bilinmeyen hata');
    return { ok: false, error: lastError ? lastError.message : 'Bilinmeyen hata' };
  }

  async _ollama(prompt, system) {
    const key = this._failureKey(prompt, system);
    return this._withRetry(key, async () => {
      const body = { model: this.model, prompt, stream: false };
      if (system) body.system = system;
      const res = await this.fetchImpl(this.endpoint + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!res.ok) return { ok: false, error: 'Ollama ' + res.status + ': ' + res.statusText };
      const json = await res.json();
      return { ok: true, data: { text: json.response, model: json.model, tokens: json.eval_count } };
    });
  }

  async _openai(prompt, system) {
    if (!this.apiKey) return { ok: false, error: 'OPENAI_API_KEY gerekli' };
    const key = this._failureKey(prompt, system);
    return this._withRetry(key, async () => {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const res = await this.fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.apiKey,
        },
        body: JSON.stringify({ model: this.model, messages }),
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!res.ok) return { ok: false, error: 'OpenAI ' + res.status + ': ' + res.statusText };
      const json = await res.json();
      const choice = json.choices && json.choices[0];
      return { ok: true, data: { text: choice.message.content, model: json.model, tokens: json.usage?.total_tokens } };
    });
  }
}

module.exports = LLMAdapter;
module.exports.DEFAULT_MAX_FAILURE_CACHE_ENTRIES = DEFAULT_MAX_FAILURE_CACHE_ENTRIES;
