'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { researchWeb, PROVIDERS, MAX_BODY_BYTES } = require('../lib/web-research');
const ok = (bodyText, status = 200) => async () => ({ status, bodyText });
function capErr(e) { return { name: e.name, code: e.code, status: e.status, message: e.message }; }
test('brave wire contract + normalize', async () => {
  let seen;
  const req = async (r) => { seen = r; return { status: 200, bodyText: JSON.stringify({ results: [{ title: '  T ', url: 'https://a.example/x', description: ' D ' }] }) }; };
  const out = await researchWeb({ provider: 'brave', query: ' q ', limit: 3 }, { env: { BRAVE_API_KEY: 'k' }, request: req });
  assert.equal(seen.method, 'GET');
  assert.ok(seen.url.startsWith(PROVIDERS.brave.endpoint + '?'));
  const u = new URL(seen.url);
  assert.equal(u.searchParams.get('q'), 'q');
  assert.equal(u.searchParams.get('count'), '3');
  assert.equal(seen.headers['X-Subscription-Token'], 'k');
  assert.equal(seen.body, undefined);
  assert.deepEqual(out.sources, [{ title: 'T', url: 'https://a.example/x', snippet: 'D' }]);
  assert.equal(out.canonicalWrite, false);
  assert.equal(out.evidenceStatus, 'external_unverified');
});

test('firecrawl wire', async () => {
  let seen;
  const req = async (r) => { seen = r; return { status: 200, bodyText: JSON.stringify({ data: { web: [{ title: 'F', url: 'http://b.example/', content: 'C' }] } }) }; };
  const out = await researchWeb({ provider: 'firecrawl', query: 'qq' }, { env: { FIRECRAWL_API_KEY: 'fk' }, request: req });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, PROVIDERS.firecrawl.endpoint);
  assert.equal(seen.headers.Authorization, 'Bearer fk');
  assert.deepEqual(JSON.parse(seen.body), { query: 'qq', limit: 5, sources: ['web'] });
  assert.deepEqual(out.sources, [{ title: 'F', url: 'http://b.example/', snippet: 'C' }]);
});
test('tavily wire', async () => {
  let seen;
  const req = async (r) => { seen = r; return { status: 200, bodyText: JSON.stringify({ results: [{ title: 1, url: 'https://c.example/', content: 'S' }] }) }; };
  const out = await researchWeb({ provider: 'tavily', query: 'tq', limit: 2 }, { env: { TAVILY_API_KEY: 'tk' }, request: req });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, PROVIDERS.tavily.endpoint);
  assert.equal(seen.headers.Authorization, 'Bearer tk');
  assert.deepEqual(JSON.parse(seen.body), { query: 'tq', max_results: 2, search_depth: 'basic', include_answer: false });
  assert.deepEqual(out.sources, [{ title: '', url: 'https://c.example/', snippet: 'S' }]);
});
test('filters bad urls caps limit', async () => {
  const req = async () => ({ status: 200, bodyText: JSON.stringify({ results: [{ title: 'a', url: 'ftp://x/y', snippet: 's' }, { title: 'b', url: 'https://user:pass@h/', snippet: 's' }, { title: 'c', url: 'https://ok.example/1', snippet: 's1' }, { title: 'd', url: 'https://ok.example/2', snippet: 's2' }] }) });
  const out = await researchWeb({ provider: 'tavily', query: 'q', limit: 1 }, { env: { TAVILY_API_KEY: 'k' }, request: req });
  assert.deepEqual(out.sources, [{ title: 'c', url: 'https://ok.example/1', snippet: 's1' }]);
});
test('missing key no request', async () => {
  let n = 0;
  const req = async () => { n += 1; return { status: 200, bodyText: '{}' }; };
  const e = await researchWeb({ provider: 'brave', query: 'q' }, { env: {}, request: req }).catch((x) => x);
  assert.deepEqual(capErr(e), { name: 'WebResearchError', code: 'MISSING_API_KEY', status: 500, message: 'Missing API key.' });
  assert.equal(n, 0);
});
test('bad input', async () => {
  const bad = [[{ provider: 'nope', query: 'q' }, 'INVALID_PROVIDER'], [{ provider: 'brave', query: ' ' }, 'INVALID_QUERY'], [{ provider: 'brave', query: 'q', limit: 0 }, 'INVALID_LIMIT'], [{ provider: 'brave', query: 'q', limit: 2.5 }, 'INVALID_LIMIT']];
  for (const [args, code] of bad) {
    const e = await researchWeb(args, { env: { BRAVE_API_KEY: 'k' }, request: ok('{}') }).catch((x) => x);
    assert.equal(e.code, code);
  }
  const e2 = await researchWeb({ provider: 'brave', query: 'q'.repeat(1001) }, { env: { BRAVE_API_KEY: 'k' }, request: ok('{}') }).catch((x) => x);
  assert.equal(e2.code, 'INVALID_QUERY');
});
test('provider errors safe', async () => {
  const cases = [[401, 'UPSTREAM_UNAUTHORIZED', 401], [403, 'UPSTREAM_FORBIDDEN', 403], [429, 'UPSTREAM_RATE_LIMITED', 429], [500, 'UPSTREAM_ERROR', 502]];
  for (const [st, code, ost] of cases) {
    const e = await researchWeb({ provider: 'brave', query: 'q' }, { env: { BRAVE_API_KEY: 'secret-k' }, request: ok('SECRET-BODY-secret-k', st) }).catch((x) => x);
    assert.equal(e.code, code);
    assert.equal(e.status, ost);
    assert.ok(!e.message.includes('secret'));
  }
  const bad = await researchWeb({ provider: 'tavily', query: 'q' }, { env: { TAVILY_API_KEY: 'k' }, request: ok('nope-json') }).catch((x) => x);
  assert.equal(bad.code, 'UPSTREAM_INVALID_PAYLOAD');
  const big = await researchWeb({ provider: 'tavily', query: 'q' }, { env: { TAVILY_API_KEY: 'k' }, request: ok('x'.repeat(MAX_BODY_BYTES + 1)) }).catch((x) => x);
  assert.equal(big.code, 'UPSTREAM_OVERSIZE');
  const to = await researchWeb({ provider: 'tavily', query: 'q' }, { env: { TAVILY_API_KEY: 'k' }, request: async () => { const e = new Error('socket timed out'); e.code = 'ETIMEDOUT'; throw e; } }).catch((x) => x);
  assert.deepEqual(capErr(to), { name: 'WebResearchError', code: 'UPSTREAM_TIMEOUT', status: 504, message: 'Upstream request timed out.' });
});

test('brave production web.results shape', async () => {
  const out = await researchWeb({ provider: 'brave', query: 'q' }, {
    env: { BRAVE_API_KEY: 'k' },
    request: async () => ({ status: 200, bodyText: JSON.stringify({ web: { results: [{ title: 'T', url: 'https://a.example', description: 'D' }] } }) }),
  });
  assert.deepEqual(out.sources, [{ title: 'T', url: 'https://a.example', snippet: 'D' }]);
});

test('native transport rejects redirects and aborted or oversized responses', async (t) => {
  for (const mode of ['redirect', 'aborted', 'oversize', 'success']) {
    let destroyed = false;
    const stub = t.mock.method(https, 'request', (_url, _options, callback) => {
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.destroy = () => { destroyed = true; };
        response.statusCode = mode === 'redirect' ? 302 : 200;
        callback(response);
        if (mode === 'aborted') response.emit('aborted');
        if (mode === 'oversize') response.emit('data', Buffer.alloc(MAX_BODY_BYTES + 1));
        if (mode === 'success') {
          response.emit('data', Buffer.from('{"results":[]}'));
          response.emit('end');
        }
      });
      return request;
    });
    try {
      const operation = researchWeb({ provider: 'tavily', query: 'q' }, { env: { TAVILY_API_KEY: 'fixture' } });
      if (mode === 'success') assert.deepEqual((await operation).sources, []);
      else {
        const code = { redirect: 'UPSTREAM_INVALID_PAYLOAD', aborted: 'UPSTREAM_ERROR', oversize: 'UPSTREAM_OVERSIZE' }[mode];
        await assert.rejects(operation, { code });
        assert.equal(destroyed, true);
      }
    } finally { stub.mock.restore(); }
  }
});

test('workflow blocks sensitive queries before transport and preserves unverified workspace results', async () => {
  const { runWebResearchWorkflow } = require('../lib/web-research-workflow');
  let calls = 0;
  const options = { env: { TAVILY_API_KEY: 'fixture' }, request: async () => {
    calls += 1;
    return { status: 200, bodyText: '{"results":[]}' };
  } };
  const blocked = await runWebResearchWorkflow({ workspaceId: 'default', provider: 'tavily', query: 'Contact alice@example.com' }, options);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.error.code, 'RESEARCH_EGRESS_BLOCKED');
  assert.equal(calls, 0);
  const completed = await runWebResearchWorkflow({ workspaceId: 'team-a', provider: 'tavily', query: 'Public research topic' }, options);
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.data.workspaceId, 'team-a');
  assert.equal(completed.body.data.canonicalWrite, false);
  assert.equal(completed.body.data.evidenceStatus, 'external_unverified');
  assert.equal(calls, 1);
});

test('maxSnippet trims sources and validates bounds', async () => {
  const long = 'x'.repeat(9000);
  const req = async () => ({ status: 200, bodyText: JSON.stringify({ results: [{ title: 'T', url: 'https://a.example/', snippet: long }] }) });
  const env = { TAVILY_API_KEY: 'k' };
  const trimmed = await researchWeb({ provider: 'tavily', query: 'q', maxSnippet: 1000 }, { env, request: req });
  assert.equal(trimmed.sources[0].snippet.length, 1000);
  assert.equal(trimmed.maxSnippet, 1000);
  const def = await researchWeb({ provider: 'tavily', query: 'q' }, { env, request: req });
  assert.equal(def.sources[0].snippet.length, 4000);
  assert.equal(def.maxSnippet, 4000);
  for (const bad of [0, 499, 8001, 2.5, 'a']) {
    const e = await researchWeb({ provider: 'tavily', query: 'q', maxSnippet: bad }, { env, request: req }).catch((x) => x);
    assert.equal(e.code, 'INVALID_SNIPPET_LENGTH');
  }
  const e2 = await researchWeb({ provider: 'tavily', query: 'q', summarize: 'yes' }, { env, request: req }).catch((x) => x);
  assert.equal(e2.code, 'INVALID_INPUT');
});

test('summarize attaches a HUQAN summary and fails soft', async () => {
  const body = JSON.stringify({ results: [{ title: 'T', url: 'https://a.example/', snippet: 'S' }] });
  const env = { TAVILY_API_KEY: 'k' };
  const req = async () => ({ status: 200, bodyText: body });
  const off = await researchWeb({ provider: 'tavily', query: 'q' }, { env, request: req });
  assert.equal(off.summary, null);
  assert.equal(off.summaryStatus, 'off');
  const ok = await researchWeb({ provider: 'tavily', query: 'q', summarize: true }, { env, request: req, summarize: async () => 'ozet metni' });
  assert.deepEqual(ok.summary, { text: 'ozet metni', by: 'huqan-llm', sources: 1 });
  assert.equal(ok.summaryStatus, 'ok');
  const down = await researchWeb({ provider: 'tavily', query: 'q', summarize: true }, { env, request: req, summarize: async () => { throw new Error('llm down'); } });
  assert.equal(down.summary, null);
  assert.equal(down.summaryStatus, 'unavailable');
  assert.equal(down.sources.length, 1);
  const empty = await researchWeb({ provider: 'tavily', query: 'q', summarize: true }, { env, request: async () => ({ status: 200, bodyText: '{"results":[]}' }), summarize: async () => 'x' });
  assert.equal(empty.summary, null);
  assert.equal(empty.summaryStatus, 'unavailable');
});

test('workflow wires summarize through and rejects bad flags', async () => {
  const { runWebResearchWorkflow } = require('../lib/web-research-workflow');
  const options = { env: { TAVILY_API_KEY: 'k' }, request: async () => ({ status: 200, bodyText: '{"results":[{"title":"T","url":"https://a.example/","snippet":"S"}]}' }), summarize: async () => 'wf ozeti' };
  const done = await runWebResearchWorkflow({ workspaceId: 'default', provider: 'tavily', query: 'q', limit: 3, maxSnippet: 1000, summarize: true }, options);
  assert.equal(done.statusCode, 200);
  assert.equal(done.body.data.limit, 3);
  assert.equal(done.body.data.maxSnippet, 1000);
  assert.equal(done.body.data.sources[0].snippet, 'S');
  assert.deepEqual(done.body.data.summary, { text: 'wf ozeti', by: 'huqan-llm', sources: 1 });
  assert.equal(done.body.data.summaryStatus, 'ok');
  const bad = await runWebResearchWorkflow({ workspaceId: 'default', provider: 'tavily', query: 'q', summarize: 'yes' }, options);
  assert.equal(bad.statusCode, 400);
});
