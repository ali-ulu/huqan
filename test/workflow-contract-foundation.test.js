'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WORKFLOW_CAPABILITIES,
  WORKFLOW_STATUSES,
  COMPATIBILITY_COMMANDS,
  compatibilityHelpText,
  publicWorkflowManifest,
} = require('../lib/workflow-contract');
const { workflowEnvelope, unavailableWorkflowEnvelope } = require('../lib/http/workflow-envelope');
const { PUBLIC_ROUTES } = require('../lib/http/route-auth-policy');
const { parseCommand } = require('../lib/command-parser');
const { normalizePublicApiCommandText } = require('../requestGuards');

test('workflow manifest uses unique versioned ids and explicitly declares every surface', () => {
  assert.equal(new Set(WORKFLOW_CAPABILITIES.map(item => item.workflowId)).size, WORKFLOW_CAPABILITIES.length);
  for (const item of WORKFLOW_CAPABILITIES) {
    assert.match(item.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(item.availability).sort(), ['api', 'cli', 'mcp', 'ui']);
    assert.equal(typeof item.authRequired, 'boolean');
    assert.equal(typeof item.workspaceRequired, 'boolean');
    if (item.mcpTool) {
      assert.ok(item.requestSchema, `${item.workflowId} reuses its MCP request schema`);
      assert.ok(item.responseSchema, `${item.workflowId} reuses its MCP response schema`);
    }
  }
});

test('compatibility help is generated only from the compatibility command contract', () => {
  const help = compatibilityHelpText();
  for (const item of COMPATIBILITY_COMMANDS) {
    assert.match(help, new RegExp(`"${item.usage || item.command}"`));
  }
  for (const unsupported of ['backup', 'restore', 'yukle', 'ajan:', 'plan:']) {
    assert.doesNotMatch(help, new RegExp(unsupported));
  }
});

/**
 * The assertion above only proves the help text is generated from the contract.
 * It used to require the *bare* `command` identifier verbatim, which is what
 * kept `"sor"` printed as if it were the syntax while the parser accepts only
 * `sor: <soru>` — the help was pinned to advertise a call that answers
 * "Anlamadim". Listing a command is a promise that typing it works, so that is
 * what this checks: every spelling the surface prints has to round-trip back to
 * the command it names.
 *
 * The identifiers are compared through the same normalizer requestGuards uses
 * for its allowlists, because the contract holds ASCII names ('yardim') while
 * the parser returns canonical Turkish ones ('yardım') — RFC-001 decision 7's
 * "a reader accepts both, a writer emits one" applies to both directions here.
 */
test('every command the compatibility help advertises is one the parser accepts', () => {
  for (const item of COMPATIBILITY_COMMANDS) {
    const typed = (item.usage || item.command).replace(/<[^>]+>/g, 'kanser');
    const parsed = parseCommand(typed);
    assert.equal(
      normalizePublicApiCommandText(parsed.command),
      normalizePublicApiCommandText(item.command),
      `typing ${JSON.stringify(typed)} must reach the "${item.command}" command`,
    );
  }
});

/**
 * The fixed-word command lists compared against the raw lowercased input while
 * holding diacritic entries, so only the Turkish spelling reached them and the
 * ASCII spelling the surfaces actually print fell through to 'anlamadım'.
 * Both spellings are permanent input per RFC-001 decision 7.
 */
test('fixed-word commands accept both the Turkish and the folded spelling', () => {
  const pairs = [
    ['yardım', 'yardim'],
    ['rüya', 'ruya'],
    ['nasılsın', 'nasilsin'],
    ['başla', 'basla'],
    ['güle güle', 'gule gule'],
    ['birleştir', 'birlestir'],
    ['hafızayı kaydet', 'hafizayi kaydet'],
    ['açık düşün', 'acik dusun'],
    ['çıkış', 'cikis'],
  ];

  for (const [turkish, folded] of pairs) {
    const fromTurkish = parseCommand(turkish).command;
    const fromFolded = parseCommand(folded).command;
    assert.notEqual(fromTurkish, 'anlamadım', `${turkish} must resolve to a command`);
    assert.equal(fromFolded, fromTurkish, `${folded} must resolve exactly like ${turkish}`);
  }
});

test('public manifest is detached and its endpoint is explicitly public read-only', () => {
  const manifest = publicWorkflowManifest();
  const originalAvailability = WORKFLOW_CAPABILITIES[0].availability.api;
  manifest.workflows[0].availability.api = !originalAvailability;
  assert.equal(WORKFLOW_CAPABILITIES[0].availability.api, originalAvailability);
  const route = PUBLIC_ROUTES.find(item => item.id === 'workflow-capabilities');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.match.pathname, '/api/v2/workflows');
});

test('workflow envelope has stable statuses and fail-closed unsupported error', () => {
  const completed = workflowEnvelope({ ok: true, status: 'completed', data: { answer: 42 } });
  assert.equal(completed.status, 'completed');
  assert.match(completed.traceId, /^[0-9a-f-]{36}$/);
  assert.equal(completed.error, null);
  assert.ok(WORKFLOW_STATUSES.includes(completed.status));

  const unsupported = unavailableWorkflowEnvelope('trace-fixed');
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.status, 'capability_not_available');
  assert.equal(unsupported.error.code, 'UNSUPPORTED_WORKFLOW');
  assert.equal(unsupported.traceId, 'trace-fixed');
});
