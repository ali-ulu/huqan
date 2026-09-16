'use strict';

/**
 * Experience E6 — shared Experience read projection (#2400).
 *
 * One projection authority for the CLI, MCP and HTTP read surfaces. The
 * three adapters (`lib/cli-experience-read.js`,
 * `lib/mcp/experience-read-tool.js`, `lib/http/experience-read-route.js`)
 * all render this projection and nothing else, so the surfaces cannot
 * answer differently for the same workspace/run. No separate format
 * authorities: text, tool envelope and JSON are views, never sources.
 *
 * The projection carries its own seal: `hash` covers the run identity,
 * the manifest and the ordered event bodies. Any consumer can recompute
 * it with `projectionHash` — a reordered, truncated or edited event list
 * yields a different hash rather than a quieter truth.
 *
 * Failure shape, not exceptions: an unknown run, a workspace the caller
 * may not see, and a tampered record all return `{ ok: false, code }`.
 * The journal's throwing read is translated here so every surface shares
 * the same three codes (`run_not_found`, `workspace_mismatch`,
 * `integrity_mismatch`).
 */

const crypto = require('node:crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableJson(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Canonical seal over identity, manifest and ordered events. */
function projectionHash({ runId, workspaceId, manifest, events }) {
  return sha256([
    runId, workspaceId,
    stableJson(manifest),
    (Array.isArray(events) ? events : []).map((e) => `${e.sequence}:${e.eventId}:${e.type}:${stableJson(e)}`).join('\n'),
  ].join('|'));
}

/**
 * Build the read projection for one run. `journal` is the E2 journal
 * (injected, never constructed here). Throws nothing.
 */
function buildExperienceRead(journal, { runId, workspaceId } = {}) {
  const id = nonEmptyString(runId);
  const ws = nonEmptyString(workspaceId);
  if (!id || !ws) return { ok: false, code: 'invalid_request' };
  if (!journal || typeof journal.read !== 'function' || typeof journal.manifest !== 'function') {
    return { ok: false, code: 'unavailable' };
  }
  let events;
  try {
    events = journal.read(id, { workspaceId: ws });
  } catch (err) {
    if (err && err.code === 'INTEGRITY_MISMATCH') return { ok: false, code: 'integrity_mismatch' };
    throw err;
  }
  if (!Array.isArray(events) || events.length === 0) {
    // Distinguish "no such run" from "not your workspace" without leaking
    // which runs exist elsewhere: an unscoped read that finds the run
    // means the workspace was wrong.
    let unscoped = [];
    try {
      unscoped = journal.read(id);
    } catch (err) {
      if (err && err.code === 'INTEGRITY_MISMATCH') return { ok: false, code: 'integrity_mismatch' };
      throw err;
    }
    return { ok: false, code: unscoped.length > 0 ? 'workspace_mismatch' : 'run_not_found' };
  }
  const manifest = journal.manifest(id);
  const projection = { runId: id, workspaceId: ws, manifest, events };
  return Object.freeze({ ok: true, ...projection, hash: projectionHash(projection) });
}

module.exports = Object.freeze({ buildExperienceRead, projectionHash });
