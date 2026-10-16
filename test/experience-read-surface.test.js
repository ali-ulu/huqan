'use strict';

/**
 * Experience E6 — shared read projection and surface parity (#2400).
 *
 * One projection authority (`lib/experience/read-model.js`) rendered by
 * three thin adapters (CLI, MCP, HTTP). The parity tests prove the
 * acceptance core: the same workspace/run yields the same hash and
 * manifest on every surface, and every surface refuses the same way.
 * Hermetic: in-memory journal only, no I/O, no network, no server.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createExperienceJournal } = require('../lib/experience/journal');
const { buildExperienceRead, projectionHash } = require('../lib/experience/read-model');
const { formatExperienceReadText, runExperienceReadCommand } = require('../lib/cli-experience-read');
const { executeMcpExperienceRead } = require('../lib/mcp/experience-read-tool');
const { handleExperienceReadRequest, EXPERIENCE_READ_PREFIX } = require('../lib/http/experience-read-route');

const ALLOW = { decision: 'allow', reason: 'read_only', requiredReview: false, canExecute: true };

function seedJournal() {
  const journal = createExperienceJournal();
  journal.append({ runId: 'run-1', workspaceId: 'ws', eventId: 'e1', type: 'run_started' });
  journal.append({ runId: 'run-1', workspaceId: 'ws', eventId: 'e2', type: 'execution_finished', executionStatus: 'completed' });
  journal.append({
    runId: 'run-1', workspaceId: 'ws', eventId: 'e3', type: 'verification', verdict: 'verified',
    proofs: { integrity: true, coverage: true, verification: true, provenance: true, permission: true },
  });
  return journal;
}

function httpCall(journal, search) {
  const reqUrl = { pathname: EXPERIENCE_READ_PREFIX, searchParams: new Map(Object.entries(search)) };
  let status = null;
  let body = null;
  const writeJson = (_req, _res, code, payload) => { status = code; body = payload; };
  const handled = handleExperienceReadRequest({
    req: { method: 'GET' }, res: {}, reqUrl, journal, writeJson,
  });
  assert.equal(handled, true);
  return { status, body };
}

describe('E6: three surfaces, one projection', () => {
  it('CLI, MCP and HTTP return the same hash and manifest', () => {
    const journal = seedJournal();
    const direct = buildExperienceRead(journal, { runId: 'run-1', workspaceId: 'ws' });
    assert.equal(direct.ok, true);

    const text = runExperienceReadCommand({
      args: { runId: 'run-1', workspaceId: 'ws' }, experienceJournal: journal,
    });
    assert.match(text, new RegExp(direct.hash, 'u'));
    assert.match(text, /outcome: verified/u);

    const tool = executeMcpExperienceRead({
      journal, name: 'huqan.experience_read',
      args: { runId: 'run-1', workspaceId: 'ws' }, gate: ALLOW,
    });
    assert.equal(tool.ok, true);
    assert.equal(tool.data.hash, direct.hash);
    assert.deepEqual(tool.data.manifest, direct.manifest);

    const { status, body } = httpCall(journal, { runId: 'run-1', workspaceId: 'ws' });
    assert.equal(status, 200);
    assert.equal(body.hash, direct.hash);
    assert.deepEqual(body.manifest, direct.manifest);
  });

  it('unauthorized scope is refused the same way everywhere', () => {
    const journal = seedJournal();
    assert.deepEqual(buildExperienceRead(journal, { runId: 'run-1', workspaceId: 'nope' }),
      { ok: false, code: 'workspace_mismatch' });
    assert.match(runExperienceReadCommand({
      args: { runId: 'run-1', workspaceId: 'nope' }, experienceJournal: journal,
    }), /workspace_mismatch/u);
    const tool = executeMcpExperienceRead({
      journal, name: 'huqan.experience_read',
      args: { runId: 'run-1', workspaceId: 'nope' }, gate: ALLOW,
    });
    assert.equal(tool.ok, false);
    assert.match(tool.error.message, /workspace_mismatch/u);
    const { status, body } = httpCall(journal, { runId: 'run-1', workspaceId: 'nope' });
    assert.equal(status, 403);
    assert.equal(body.code, 'workspace_mismatch');
  });

  it('unknown runs are not_found everywhere', () => {
    const journal = seedJournal();
    assert.deepEqual(buildExperienceRead(journal, { runId: 'ghost', workspaceId: 'ws' }),
      { ok: false, code: 'run_not_found' });
    const { status } = httpCall(journal, { runId: 'ghost', workspaceId: 'ws' });
    assert.equal(status, 404);
  });

  it('a tampered record is refused, never rendered', () => {
    const journal = createExperienceJournal();
    journal.append({ runId: 'run-1', workspaceId: 'ws', eventId: 'e1', type: 'run_started' });
    // Simulate an out-of-band edit the way the journal tests do: rebuild
    // over corrupted state is covered there; here the projection must
    // surface the code instead of throwing through the adapters.
    const broken = {
      read() {
        const err = new Error('tampered');
        err.code = 'INTEGRITY_MISMATCH';
        throw err;
      },
      manifest() { return {}; },
    };
    assert.deepEqual(buildExperienceRead(broken, { runId: 'run-1', workspaceId: 'ws' }),
      { ok: false, code: 'integrity_mismatch' });
    const tool = executeMcpExperienceRead({
      journal: broken, name: 'huqan.experience_read',
      args: { runId: 'run-1', workspaceId: 'ws' }, gate: ALLOW,
    });
    assert.equal(tool.ok, false);
    const { status } = httpCall(broken, { runId: 'run-1', workspaceId: 'ws' });
    assert.equal(status, 502);
  });

  it('reordered or truncated events change the hash', () => {
    const journal = seedJournal();
    const projection = buildExperienceRead(journal, { runId: 'run-1', workspaceId: 'ws' });
    const reordered = { ...projection, events: [...projection.events].reverse() };
    assert.notEqual(projectionHash(reordered), projection.hash);
    const truncated = { ...projection, events: projection.events.slice(0, 1) };
    assert.notEqual(projectionHash(truncated), projection.hash);
  });

  it('the HTTP surface owns only its prefix and method', () => {
    const journal = seedJournal();
    let called = false;
    const handled = handleExperienceReadRequest({
      req: { method: 'GET' }, res: {},
      reqUrl: { pathname: '/api/something-else', searchParams: new Map() },
      journal, writeJson: () => { called = true; },
    });
    assert.equal(handled, false);
    assert.equal(called, false);
  });
});
