'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const CLI = require('../cli');
const Kernel = require('../kernel');
const MemoryStore = require('../lib/memory-store');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { buildMemoryQueryRead, normalizeMemoryQueryInput } = require('../lib/memory-query-read');
const { createCliCommandHandlers } = require('../lib/cli-command-handlers');
const { parseCommand } = require('../lib/command-parser');
const { createReadWorkflowHttpRouter, NO_CAPABILITY_ENSURE } = require('../lib/http/read-workflow-actions');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const { callTool, TOOL_SCHEMAS } = require('../mcpServer');

const PAST = '2020-01-01T00:00:00.000Z';

// A real in-memory store, written through its own write path, plus records
// placed directly to exercise the recall gate: one without provenance (withheld)
// and one whose declared expiry has passed (degraded, still returned).
function seededKernel() {
  const memory = new MemoryStore({ useSQLite: false });
  for (const content of [
    'The recall gate withholds memories that lack provenance',
    'Degraded recall results stay in the page',
    'Trust receipts chain each approval to the previous receipt hash',
  ]) {
    assert.equal(memory.store({ content, workspaceId: 'ws-a' }).ok, true);
  }
  assert.equal(memory.store({ content: 'recall gate provenance in another workspace', workspaceId: 'ws-b' }).ok, true);
  const base = { workspaceId: 'ws-a', kind: 'memory-record', status: 'active', createdAt: PAST, metadata: {} };
  memory._memories.set(memory.makeMemoryKey('ws-a', 'm-unprovenanced'), {
    ...base, memoryId: 'm-unprovenanced', content: 'recall gate provenance unprovenanced', provenance: {},
  });
  memory._memories.set(memory.makeMemoryKey('ws-a', 'm-expired'), {
    ...base, memoryId: 'm-expired', content: 'recall gate provenance expired note',
    provenance: { provenanceId: 'p-expired', sourceRef: 'doc://old', sourceType: 'document', actor: 'agent-1' },
    metadata: { expiresAt: PAST },
  });
  return { memory };
}

// The CLI command drives huqan.memory_query, so its handlers get the real
// MCP callTool -- the same collaborator cli.js hands them.
const cliHandlers = createCliCommandHandlers({
  callMcpTool: callTool,
  createApprovalStoreFromKernel() { return null; },
});

async function httpGet(kernel, query) {
  let status = null;
  let body = null;
  const router = createReadWorkflowHttpRouter({
    kernel,
    parseJsonRequest: async () => ({}),
    writeJson: (_req, _res, code, payload) => { status = code; body = payload; },
    writeApiError() { throw new Error('not used by the memory query GET'); },
    ensureCapabilities: NO_CAPABILITY_ENSURE,
  });
  const handled = await router({ method: 'GET' }, {}, new URL(`http://local/api/memory/query?${query}`));
  return { handled, status, body };
}

describe('memory query projection', () => {
  test('defaults to bm25, ranks multi-word matches and keeps the workspace boundary', () => {
    const result = buildMemoryQueryRead(seededKernel().memory, { text: 'recall gate provenance', workspaceId: 'ws-a' });
    assert.equal(result.ok, true);
    assert.equal(result.retrievalMode, 'bm25');
    const contents = result.items.map((item) => item.content);
    // Relevance order is kept even for a degraded record: it ranks first here
    // (short, every query term) and comes back marked, not reordered.
    assert.deepEqual(contents.slice(0, 2), ['recall gate provenance expired note', 'The recall gate withholds memories that lack provenance']);
    assert.equal(contents.some((content) => content.includes('another workspace')), false);
    assert.ok(result.items.every((item) => typeof item.score === 'number' && item.terms === undefined));
  });

  test('withholds unprovenanced records and returns degraded ones marked', () => {
    const result = buildMemoryQueryRead(seededKernel().memory, { text: 'recall gate provenance', workspaceId: 'ws-a' });
    assert.equal(result.items.some((item) => item.memoryId === 'm-unprovenanced'), false);
    const expired = result.items.find((item) => item.memoryId === 'm-expired');
    assert.deepEqual(expired.recall, { decision: 'degrade', reason: 'expired_record' });
    assert.equal(result.recall.withheld, 1);
    assert.ok(result.items.filter((item) => item.memoryId !== 'm-expired').every((item) => item.recall.decision === 'admit'));
  });

  test('substring mode keeps exact-phrase matching and carries no scores', () => {
    const result = buildMemoryQueryRead(seededKernel().memory, { text: 'Degraded recall', workspaceId: 'ws-a', retrievalMode: 'substring' });
    assert.deepEqual(result.items.map((item) => item.content), ['Degraded recall results stay in the page']);
    assert.equal(result.items[0].score, undefined);
  });

  test('explain adds per-term contributions; limit and offset page by rank', () => {
    const memory = seededKernel().memory;
    const full = buildMemoryQueryRead(memory, { text: 'recall gate provenance', workspaceId: 'ws-a', explain: true });
    assert.ok(full.items[0].terms.length > 0);
    const second = buildMemoryQueryRead(memory, { text: 'recall gate provenance', workspaceId: 'ws-a', limit: '1', offset: '1' });
    assert.equal(second.total, full.total);
    assert.deepEqual(second.items.map((item) => item.memoryId), [full.items[1].memoryId]);
  });

  test('refuses malformed requests and a missing store', () => {
    for (const [input, message] of [
      [{ workspaceId: 'ws-a' }, /text is required/],
      [{ text: 'x' }, /workspaceId is required/],
      [{ text: 'x'.repeat(501), workspaceId: 'ws-a' }, /text exceeds 500/],
      [{ text: 'x', workspaceId: 'ws-a', retrievalMode: 'vector' }, /retrievalMode must be one of/],
      [{ text: 'x', workspaceId: 'ws-a', limit: 0 }, /limit must be an integer from 1 to 100/],
      [{ text: 'x', workspaceId: 'ws-a', limit: '101' }, /limit must be an integer from 1 to 100/],
      [{ text: 'x', workspaceId: 'ws-a', limit: '2.5' }, /limit must be an integer/],
      [{ text: 'x', workspaceId: 'ws-a', offset: -1 }, /offset must be a non-negative integer/],
      [{ text: 'x', workspaceId: 'ws-a', explain: 'yes' }, /explain must be a boolean/],
      [{ text: 'x', workspaceId: 'ws-a', retrievalMode: 'substring', explain: true }, /explain requires retrievalMode bm25/],
      // An explicitly empty value is malformed, not a request for the default.
      [{ text: 'x', workspaceId: 'ws-a', limit: '' }, /limit must be an integer/],
      [{ text: 'x', workspaceId: 'ws-a', offset: '' }, /offset must be a non-negative integer/],
      [{ text: 'x', workspaceId: 'ws-a', explain: '' }, /explain must be a boolean/],
      [{ text: 'x', workspaceId: 'ws-a', retrievalMode: '' }, /retrievalMode must be one of/],
    ]) {
      const result = normalizeMemoryQueryInput(input);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'invalid_request');
      assert.match(result.message, message);
    }
    assert.deepEqual(buildMemoryQueryRead(null, { text: 'x', workspaceId: 'ws-a' }).code, 'memory_unavailable');
  });
});

describe('memory query surfaces', () => {
  // The real Kernel, its MemoryStore and the real CLI -- no stubs -- so the
  // cli.js wiring of `memoryQuery` is exercised, not re-created here.
  test('CLI, MCP and HTTP return the same projection from a real kernel', async (t) => {
    const cli = new CLI({ kernelInstance: new Kernel(isolatedKernelOptions('memory-query-surfaces')) });
    t.after(() => cli.kernel.memory.close());
    const kernel = cli.kernel;
    for (const content of ['The recall gate withholds memories that lack provenance', 'Degraded recall results stay in the page', 'Trust receipts chain approvals']) {
      assert.equal(kernel.memory.store({ content, workspaceId: 'ws-a' }).ok, true);
    }
    const input = { text: 'recall gate provenance', workspaceId: 'ws-a', limit: 3 };
    const direct = buildMemoryQueryRead(kernel.memory, input);
    assert.equal(direct.ok, true);
    assert.equal(direct.items.length, 2);

    const mcp = callTool(kernel, { name: 'huqan.memory_query', arguments: input });
    assert.equal(mcp.ok, true);
    assert.deepEqual(mcp.data, direct);

    const http = await httpGet(kernel, 'text=recall%20gate%20provenance&workspaceId=ws-a&limit=3');
    assert.equal(http.handled, true);
    assert.equal(http.status, 200);
    assert.deepEqual(http.body, direct);

    const parsed = parseCommand('memory-query recall gate provenance --workspace ws-a --limit 3 --json');
    assert.equal(parsed.command, 'memory-query');
    // The CLI asks for `storeTotal` so the text surface can name an empty
    // store (#3640); every other field still matches the shared projection.
    assert.deepEqual(JSON.parse(cli.execute('memory-query', parsed.args)), buildMemoryQueryRead(kernel.memory, { ...input, storeTotal: true }));
  });

  test('the CLI renders ranked text, explanations and refusals', () => {
    const kernel = seededKernel();
    const cliContext = { kernel };
    const text = cliHandlers['memory-query'](cliContext, parseCommand('memory-query recall gate provenance --workspace ws-a --explain').args);
    assert.match(text, /^memory-query \[ws-a\] bm25: \d+ of \d+ for "recall gate provenance"/);
    assert.match(text, /\n {2}1\. m-expired score [\d.]+ \[degrade: expired_record\] {2}recall gate provenance expired note/);
    assert.match(text, /\n {2}2\. \S+ score [\d.]+ {2}The recall gate withholds/);
    assert.match(text, /recall: tf 1 idf/);
    assert.match(text, /\[degrade: expired_record\]/);
    assert.match(text, /1 record\(s\) withheld by the recall gate/);
    assert.equal(cliHandlers['memory-query'](cliContext, parseCommand('memory-query x --workspace').args), 'memory-query: --workspace requires a value');
    assert.equal(cliHandlers['memory-query']({ kernel: {} }, parseCommand('memory-query x').args),
      'memory-query: memory_unavailable (no memory store is available)');
    assert.equal(cliHandlers['memory-query'](cliContext, parseCommand('memory-query x --workspace ws-a --limit many').args),
      'memory-query: invalid_request (limit must be an integer from 1 to 100)');
    const refusedJson = JSON.parse(cliHandlers['memory-query'](cliContext, parseCommand('memory-query x --workspace ws-a --mode vector --json').args));
    assert.deepEqual(refusedJson, { ok: false, code: 'invalid_request', message: 'retrievalMode must be one of: bm25, substring, recency' });
  });

  test('the CLI explains an empty record store without polluting the JSON projection', () => {
    // The graph is the CLI's primary surface, so an operator who only ran
    // `learn` sees 0 of 0 against a store `learn` never writes. The text
    // surface names that split; `--json` stays pure data (#3640).
    const empty = { kernel: { memory: new MemoryStore({ useSQLite: false }) } };
    const text = cliHandlers['memory-query'](empty, parseCommand('memory-query cats --workspace ws-a').args);
    assert.match(text, /^memory-query \[ws-a\] bm25: 0 of 0 for "cats"/);
    assert.match(text, /no records in this store for this workspace; `learn`\/`save` write the graph/);
    // The hint points at the CLI command that reads the graph, not at the MCP
    // tool name, which is not a CLI command (#3640).
    assert.match(text, /ask it with `sor <soru>`/);
    assert.match(text, /`huqan\.search` over MCP/);

    const json = JSON.parse(cliHandlers['memory-query'](empty, parseCommand('memory-query cats --workspace ws-a --json').args));
    assert.equal(json.total, 0);
    // The machine-readable emptiness flag rides on the projection for callers
    // that never see the text hint.
    assert.equal(json.storeTotal, 0);
    assert.equal(json.storeEmpty, true);
    assert.equal(JSON.stringify(json).includes('no records in this store'), false);
  });

  test('the empty-store hint needs an empty store, not just an unmatched query', () => {
    // `total` counts what survived filtering, so a populated store whose text
    // matched nothing also reports 0 of 0. The hint must not call that store
    // empty: the emptiness comes from the store's own unfiltered read.
    const memory = new MemoryStore({ useSQLite: false });
    assert.equal(memory.store({ content: 'the graph holds this, not the store', workspaceId: 'ws-a' }).ok, true);
    const populated = { kernel: { memory } };

    for (const command of ['memory-query no-such-word --workspace ws-a',
      'memory-query no-such-word --workspace ws-a --mode substring']) {
      const text = cliHandlers['memory-query'](populated, parseCommand(command).args);
      assert.match(text, /: 0 of 0 for "no-such-word"/);
      assert.equal(text.includes('no records in this store'), false, `${command} claimed a populated store was empty`);
    }

    // Records that exist but were all withheld by the recall gate already get
    // the withheld line; the empty-store hint must not claim the store is empty.
    memory._memories.set(memory.makeMemoryKey('ws-a', 'm-unprovenanced'), {
      workspaceId: 'ws-a', memoryId: 'm-unprovenanced', kind: 'memory-record', status: 'active',
      createdAt: PAST, metadata: {}, content: 'recall gate provenance unprovenanced', provenance: {},
    });
    const withheld = cliHandlers['memory-query'](populated, parseCommand('memory-query recall gate provenance --workspace ws-a').args);
    assert.match(withheld, /1 record\(s\) withheld by the recall gate/);
    assert.equal(withheld.includes('no records in this store'), false);
  });

  test('the emptiness answer rides on the query, so no second read can fail', () => {
    // #3640: the CLI used to ask the store a second time (`list`) for the
    // emptiness hint, so a store whose read threw took the whole command down
    // after the query had already succeeded. The count now comes from the same
    // `query` call, so a store that can answer the query can answer the hint.
    const memory = new MemoryStore({ useSQLite: false });
    assert.equal(memory.store({ content: 'cats like warm laps', workspaceId: 'ws-a' }).ok, true);
    const kernel = { memory };
    const calls = [];
    const original = memory.query.bind(memory);
    memory.query = (opts) => { calls.push(opts); return original(opts); };

    const text = cliHandlers['memory-query']({ kernel }, parseCommand('memory-query cats --workspace ws-a').args);
    assert.match(text, /^memory-query \[ws-a\] bm25: 1 of 1 for "cats"/);
    assert.equal(text.includes('no records in this store'), false);
    // One read, and it asked for the store count.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].storeTotal, true);
  });

  test('the CLI keeps quoted text out of flag parsing', () => {
    const args = (input) => parseCommand(input).args;
    assert.deepEqual([args('memory-query "use --explain in docs" --workspace ws').text, args('memory-query "use --explain in docs" --workspace ws').explain],
      ['use --explain in docs', false]);
    assert.deepEqual([args("memory-query 'a --workspace b' c").text, args("memory-query 'a --workspace b' c").workspaceId], ['a --workspace b c', 'default']);
    assert.equal(args('memory-query x --workspace "team a"').workspaceId, 'team a');
    assert.deepEqual([args('memory-query "--json"').text, args('memory-query "--json"').json], ['--json', false]);
    assert.equal(args('memory-query x --workspace ""').error, '--workspace requires a value');
  });

  test('the CLI sends huqan.memory_query arguments that match the declared input schema', () => {
    const sent = [];
    const spying = createCliCommandHandlers({
      callMcpTool: (kernel, request) => { sent.push(request); return callTool(kernel, request); },
      createApprovalStoreFromKernel() { return null; },
    });
    spying['memory-query']({ kernel: seededKernel() }, parseCommand('memory-query recall gate --workspace ws-a --limit 5 --offset 1 --explain').args);
    assert.deepEqual(sent, [{
      name: 'huqan.memory_query',
      arguments: { text: 'recall gate', workspaceId: 'ws-a', limit: 5, offset: 1, explain: true, storeTotal: true },
    }]);
    const schema = TOOL_SCHEMAS.find((tool) => tool.name === 'huqan.memory_query').inputSchema;
    for (const [key, value] of Object.entries(sent[0].arguments)) {
      const expected = schema.properties[key].type;
      assert.equal(typeof value, expected === 'integer' ? 'number' : expected, key);
    }
  });

  test('MCP reports a refused request as MEMORY_QUERY_FAILED', () => {
    const result = callTool(seededKernel(), { name: 'huqan.memory_query', arguments: { text: '', workspaceId: 'ws-a' } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MEMORY_QUERY_FAILED');
    assert.match(result.error.message, /invalid_request: text is required/);
  });

  test('HTTP maps refusals to status codes and only answers GET', async () => {
    const kernel = seededKernel();
    assert.equal((await httpGet(kernel, 'workspaceId=ws-a')).status, 400);
    assert.equal((await httpGet(kernel, `text=${'x'.repeat(600)}&workspaceId=ws-a`)).body.message, 'text exceeds 500 characters');
    assert.equal((await httpGet({}, 'text=x&workspaceId=ws-a')).status, 503);
    // Neither truncated into a valid value nor defaulted when empty.
    const padded = await httpGet(kernel, 'text=x&workspaceId=ws-a&limit=0000000101');
    assert.deepEqual([padded.status, padded.body.message], [400, 'limit must be an integer from 1 to 100']);
    assert.equal((await httpGet(kernel, 'text=x&workspaceId=ws-a&limit=')).status, 400);
    assert.equal((await httpGet(kernel, 'text=x&workspaceId=ws-a&offset=')).status, 400);
    let status = null;
    const router = createReadWorkflowHttpRouter({
      kernel,
      parseJsonRequest: async () => ({}),
      writeJson: (_req, _res, code) => { status = code; },
      writeApiError() { throw new Error('not used'); },
      ensureCapabilities: NO_CAPABILITY_ENSURE,
    });
    assert.equal(await router({ method: 'POST' }, {}, new URL('http://local/api/memory/query?text=x&workspaceId=ws-a')), true);
    assert.equal(status, 405);
  });

  test('the route requires authentication and the tool is advertised read-only', () => {
    const auth = resolveRouteAuthPolicy('/api/memory/query', 'GET');
    assert.equal(auth.known, true);
    assert.equal(auth.authRequired, true);
    assert.equal(auth.ruleId, 'memory-query');
    const tool = TOOL_SCHEMAS.find((schema) => schema.name === 'huqan.memory_query');
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, true);
    // `text` stays optional in the schema because recency mode is a pure
    // time ordering that needs no query; every other mode still refuses an
    // empty text at the projection, so nothing is silently searched.
    assert.deepEqual(tool.inputSchema.required, ['workspaceId']);
  });
});
