const test = require('node:test');
const assert = require('node:assert/strict');

const { teachCommand } = require('../lib/cli-knowledge-commands');
const { createMcpToolHandlers } = require('../lib/mcp/tool-handlers');

const cliWith = (learnResult) => ({ kernel: { learn: () => learnResult } });
const allowEnvelope = (learned, admission) => ({ ok: true, data: { learned, admission } });

test('teachCommand reports a queued review instead of claiming success', () => {
  const output = teachCommand(
    cliWith(allowEnvelope(0, { outcome: 'review', reason: 'mutating_requires_review' })),
    'kedi hayvandir', {}, 'öğret',
  );
  assert.match(output, /Onay bekliyor/);
  assert.match(output, /mutating_requires_review/);
  assert.doesNotMatch(output, /OK/);
});

test('teachCommand reports a rejection instead of claiming success', () => {
  const output = teachCommand(
    cliWith(allowEnvelope(0, { outcome: 'reject', reason: 'policy' })),
    'kedi hayvandir', {}, 'öğret',
  );
  assert.match(output, /Reddedildi/);
  assert.doesNotMatch(output, /OK/);
});

test('teachCommand does not claim success when nothing was learned', () => {
  const output = teachCommand(
    cliWith(allowEnvelope(0, { outcome: 'allow' })),
    'kedi hayvandir', {}, 'öğret',
  );
  assert.match(output, /0 fact/);
  assert.doesNotMatch(output, /OK/);
});

test('teachCommand still confirms a genuine write', () => {
  const output = teachCommand(
    cliWith(allowEnvelope(2, { outcome: 'allow' })),
    'kedi hayvandir', {}, 'öğret',
  );
  assert.match(output, /^OK "kedi" öğrendim\.$/);
});

test('teachCommand surfaces a failed learn envelope', () => {
  const output = teachCommand(
    cliWith({ ok: false, error: { message: 'patladi' } }),
    'kedi hayvandir', {}, 'öğret',
  );
  assert.match(output, /patladi/);
  assert.doesNotMatch(output, /OK/);
});

test('the MCP huqan.learn handler forwards workspaceId and provenance to kernel.learn', () => {
  const handlers = createMcpToolHandlers({ withTransientAgent: () => undefined });
  let received = null;
  const kernel = { learn: (_text, opts) => { received = opts; return { ok: true, data: {} }; } };
  handlers['huqan.learn']({
    kernel,
    name: 'huqan.learn',
    args: {
      text: 'kedi hayvandir',
      workspaceId: 'team-x',
      provenance: { provenanceId: 'prov_gh_1', sourceType: 'github', sourceRef: 'ali-ulu/huqan#1234', actor: 'reviewer@example.com' },
    },
    gate: {},
  });
  assert.equal(received.workspaceId, 'team-x');
  assert.equal(received.provenance.provenanceId, 'prov_gh_1');
  assert.equal(received.provenance.sourceType, 'github');
  assert.equal(received.provenance.actor, 'reviewer@example.com');
});

test('the MCP huqan.learn handler drops unknown provenance fields', () => {
  const handlers = createMcpToolHandlers({ withTransientAgent: () => undefined });
  let received = null;
  const kernel = { learn: (_text, opts) => { received = opts; return { ok: true, data: {} }; } };
  handlers['huqan.learn']({
    kernel,
    name: 'huqan.learn',
    args: { text: 't', provenance: { provenanceId: 'p1', injected: 'nope' } },
    gate: {},
  });
  assert.equal(received.provenance.provenanceId, 'p1');
  assert.equal(received.provenance.injected, undefined);
});
