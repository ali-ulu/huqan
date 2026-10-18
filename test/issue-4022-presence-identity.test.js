'use strict';

// #4022: presence attribution must not follow a substring of an untrusted,
// self-reported MCP client name. `agentIdForClient` used to match substrings,
// so a client declaring `unrelated-codex-helper` refreshed Codex's presence
// file and the Control Room showed the wrong agent as connected.
//
// Scope: this pins the substring fix on the current stdio surface. Presence is
// still derived from the untrusted `clientInfo.name`; binding it to an
// enrolled MCP client identity is the #3999 client-envelope work and is not
// claimed here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { agentIdForClient, createPresenceRecorder, readPresence } = require('../lib/mcp/agent-presence');

const KNOWN_AGENT_IDS = Object.freeze([
  'claude-code', 'codex', 'cline', 'opencode', 'cursor', 'freebuff', 'gemini-cli', 'windsurf',
]);

// Names that merely *contain* a known agent's name. Each one used to be
// attributed to that agent.
const MISLEADING_NAMES = Object.freeze([
  'unrelated-codex-helper',
  'not-codex',
  'xcodex',
  'codex-ish-tool',
  'my-cline-tool',
  'cline-helper',
  'cursor-helper',
  'windsurf-tool',
  'gemini-helper',
  'opencode-helper',
  'freebuff-tool',
  'claude-code-clone',
  'fake-claude-code',
]);

test('a misleading client name is never attributed to a known agent (#4022)', () => {
  for (const name of MISLEADING_NAMES) {
    const id = agentIdForClient(name);
    assert.equal(KNOWN_AGENT_IDS.includes(id), false,
      `${name} was attributed to the known agent ${id}`);
  }
});

test('the reported example resolves to its own identity, not Codex (#4022)', () => {
  assert.equal(agentIdForClient('unrelated-codex-helper'), 'unrelated-codex-helper');
});

test('honest client names keep their known attribution (#4022)', () => {
  assert.equal(agentIdForClient('claude-code'), 'claude-code');
  assert.equal(agentIdForClient('codex'), 'codex');
  assert.equal(agentIdForClient('codex-mcp-client'), 'codex');
  assert.equal(agentIdForClient('Cline'), 'cline');
  assert.equal(agentIdForClient('CLINE'), 'cline');
  assert.equal(agentIdForClient('  windsurf  '), 'windsurf');
  assert.equal(agentIdForClient('gemini'), 'gemini-cli');
  assert.equal(agentIdForClient('gemini-cli'), 'gemini-cli');
  assert.equal(agentIdForClient('opencode'), 'opencode');
});

test('a differently-decorated Claude client keeps its own identity (#4022)', () => {
  assert.equal(agentIdForClient('claude-ai'), 'claude-ai',
    'Claude Desktop must not refresh Claude Code');
});

test('an unknown client is recorded under its own slug, or not at all (#4022)', () => {
  assert.equal(agentIdForClient('Research Crew!'), 'research-crew');
  assert.equal(agentIdForClient(''), '');
  assert.equal(agentIdForClient('!!!'), '', 'a name with no alphanumerics has no id');
});

test('a misleading name writes its own presence file, never the known agent\u2019s (#4022)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4022-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const presence = path.join(dir, '.huqan-agent-presence');
  let now = Date.parse('2026-10-18T12:00:00Z');
  const record = createPresenceRecorder({ directory: presence, now: () => now });

  record({ clientName: 'unrelated-codex-helper' });
  now += 1000;
  record({ clientName: 'my-cline-tool' });

  const seen = readPresence(presence);
  assert.deepEqual([...seen.keys()].sort(), ['my-cline-tool', 'unrelated-codex-helper']);
  assert.equal(fs.existsSync(path.join(presence, 'codex.json')), false,
    'a misleading name must not refresh Codex');
  assert.equal(fs.existsSync(path.join(presence, 'cline.json')), false,
    'a misleading name must not refresh Cline');
  assert.equal(seen.get('unrelated-codex-helper').client, 'unrelated-codex-helper');
});

test('an honest client still refreshes its own known agent file (#4022)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4022-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const presence = path.join(dir, '.huqan-agent-presence');
  const record = createPresenceRecorder({ directory: presence, now: () => Date.parse('2026-10-18T12:00:00Z') });

  record({ clientName: 'codex-mcp-client' });
  assert.deepEqual([...readPresence(presence).keys()], ['codex']);
});
