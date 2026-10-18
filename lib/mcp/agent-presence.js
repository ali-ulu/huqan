'use strict';

/**
 * Agent presence: when an MCP client last talked to HUQAN.
 *
 * Every agent runs its own HUQAN MCP process over stdio, so the HTTP server
 * cannot see them directly. Each MCP process therefore leaves one small file
 * per client beside the memory store -- `<dir>/.huqan-agent-presence/<id>.json`
 * holding only the agent id, the client name it declared and a timestamp --
 * and the Control Room reads those files to say "connected" or "last seen".
 *
 * It records presence, nothing else: no tool names, arguments or results.
 * Writes are throttled per client and best-effort: a presence file that
 * cannot be written must never fail or slow down a tool call.
 */

const fs = require('node:fs');
const path = require('node:path');

const PRESENCE_DIR_NAME = '.huqan-agent-presence';
const WRITE_INTERVAL_MS = 30_000;
const MAX_FILES = 200;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// MCP clientInfo.name -> catalog agent id. Matched as substrings because
// clients decorate their names ("claude-code", "codex-mcp-client", "Cline").
// The Claude Code needle is the exact client name on purpose: other Claude
// clients ("claude-ai" for Claude Desktop) must keep their own identity and
// show up as separate unregistered clients instead of refreshing this file.
const CLIENT_ALIASES = Object.freeze([
  ['claude-code', 'claude-code'],
  ['codex', 'codex'],
  ['cline', 'cline'],
  ['opencode', 'opencode'],
  ['cursor', 'cursor'],
  ['freebuff', 'freebuff'],
  ['gemini', 'gemini-cli'],
  ['windsurf', 'windsurf'],
]);

function agentIdForClient(clientName) {
  const name = String(clientName || '').toLowerCase().trim();
  if (!name) return '';
  const alias = CLIENT_ALIASES.find(([needle]) => name.includes(needle));
  if (alias) return alias[1];
  const slug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return ID_PATTERN.test(slug) ? slug : '';
}

function presenceDirectory(memoryPath) {
  const base = typeof memoryPath === 'string' && memoryPath.trim()
    ? path.dirname(path.resolve(memoryPath.trim()))
    : process.cwd();
  return path.join(base, PRESENCE_DIR_NAME);
}

/**
 * @returns {(event: {clientName?: string}) => void} records presence for the
 *   client, at most once per WRITE_INTERVAL_MS per client.
 */
function createPresenceRecorder({ directory, now = Date.now, onError } = {}) {
  if (!directory) return () => {};
  const lastWrite = new Map();
  return function recordPresence({ clientName } = {}) {
    const id = agentIdForClient(clientName);
    if (!id) return;
    const at = now();
    if (at - (lastWrite.get(id) || 0) < WRITE_INTERVAL_MS) return;
    lastWrite.set(id, at);
    try {
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${id}.json`);
      const temp = `${file}.${process.pid}.tmp`;
      const record = { id, client: String(clientName).slice(0, 128), lastSeen: new Date(at).toISOString() };
      fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      if (typeof onError === 'function') onError(error);
    }
  };
}

/** @returns {Map<string, {id: string, client: string, lastSeen: string}>} */
function readPresence(directory) {
  const seen = new Map();
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).slice(0, MAX_FILES);
  } catch (_) {
    return seen;
  }
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    if (!ID_PATTERN.test(id)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (record && record.id === id && !Number.isNaN(Date.parse(record.lastSeen))) {
        seen.set(id, { id, client: String(record.client || ''), lastSeen: record.lastSeen });
      }
    } catch (_) { /* a torn or foreign file is not presence */ }
  }
  return seen;
}

module.exports = Object.freeze({
  PRESENCE_DIR_NAME,
  WRITE_INTERVAL_MS,
  agentIdForClient,
  presenceDirectory,
  createPresenceRecorder,
  readPresence,
});
