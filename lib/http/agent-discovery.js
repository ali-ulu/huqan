'use strict';

/**
 * Agent discovery: which coding agents are installed on this computer, and
 * whether their MCP configuration already points at HUQAN.
 *
 * Read-only by construction. This module opens files with readFileSync and
 * stats directories; it has no write path at all, so it can never edit an
 * agent's configuration. Connecting an agent stays the user's decision:
 * discovery only suggests, the user confirms, and confirmation is recorded in
 * HUQAN's own registry (lib/http/agent-registry-routes.js), never in the
 * agent's files.
 *
 * Results carry booleans, the agent's display name and the config paths that
 * were read -- never file content, server commands, environment values or
 * keys an agent config may contain.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

/**
 * One entry per agent. `configs` are the files that agent really reads (not
 * look-alikes it ignores); `markers` show the agent is installed even when no
 * MCP server is configured yet. `format` picks the parser.
 */
function agentCatalog({ home, appData }) {
  const h = (...p) => path.join(home, ...p);
  const a = (...p) => (appData ? path.join(appData, ...p) : null);
  return [
    { id: 'claude-code', name: 'Claude Code', kind: 'Coding agent', markers: [h('.claude')], configs: [{ file: h('.claude.json'), format: 'claude' }] },
    { id: 'codex', name: 'Codex', kind: 'Coding agent', markers: [h('.codex')], configs: [{ file: h('.codex', 'config.toml'), format: 'toml' }] },
    {
      id: 'cline', name: 'Cline', kind: 'Coding agent', markers: [h('.cline'), a('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')],
      configs: [
        { file: h('.cline', 'data', 'settings', 'cline_mcp_settings.json'), format: 'json' },
        { file: a('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), format: 'json' },
      ],
    },
    {
      id: 'opencode', name: 'opencode', kind: 'Coding agent', markers: [h('.config', 'opencode')],
      configs: [
        { file: h('.config', 'opencode', 'opencode.json'), format: 'json' },
        { file: h('.config', 'opencode', 'opencode.jsonc'), format: 'json' },
      ],
    },
    { id: 'cursor', name: 'Cursor', kind: 'Code editor', markers: [h('.cursor')], configs: [{ file: h('.cursor', 'mcp.json'), format: 'json' }] },
    { id: 'freebuff', name: 'Freebuff', kind: 'Coding agent', markers: [h('.agents')], configs: [{ file: h('.agents', 'mcp.json'), format: 'json' }] },
    { id: 'gemini-cli', name: 'Gemini CLI', kind: 'Coding agent', markers: [h('.gemini')], configs: [{ file: h('.gemini', 'settings.json'), format: 'json' }] },
    { id: 'windsurf', name: 'Windsurf', kind: 'Code editor', markers: [h('.codeium', 'windsurf')], configs: [{ file: h('.codeium', 'windsurf', 'mcp_config.json'), format: 'json' }] },
  ].map((entry) => ({ ...entry, markers: entry.markers.filter(Boolean), configs: entry.configs.filter((c) => c.file) }));
}

/** Removes // and /* *\/ comments outside strings, for JSONC configs. */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += next || ''; i += 1; } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const mentionsHuqan = (value) => /huqan/i.test(typeof value === 'string' ? value : JSON.stringify(value || ''));

/** Every MCP server map a JSON config can hold, across the agents above. */
function serverMaps(config) {
  if (!config || typeof config !== 'object') return [];
  const maps = [config.mcpServers, config.mcp, config.mcp && config.mcp.servers, config.mcp_servers];
  if (config.projects && typeof config.projects === 'object') {
    for (const project of Object.values(config.projects)) maps.push(project && project.mcpServers);
  }
  return maps.filter((m) => m && typeof m === 'object' && !Array.isArray(m));
}

function huqanEntriesInJson(config) {
  const found = new Set();
  for (const map of serverMaps(config)) {
    for (const [name, server] of Object.entries(map)) {
      if (name === 'servers') continue;
      if (mentionsHuqan(name) || mentionsHuqan(server && [server.command, server.args, server.url])) found.add(name);
    }
  }
  return [...found];
}

function huqanEntriesInToml(text) {
  const found = new Set();
  let current = null;
  let inValue = false;
  for (const line of text.split(/\r?\n/)) {
    if (inValue) {
      // Continuation lines of a multi-line value, e.g. `args = [` followed by
      // one quoted path per line. TOML often writes arrays this way, so the
      // HUQAN reference may live on a line that holds no key at all.
      if (current && mentionsHuqan(line)) found.add(current);
      if (/\]/.test(line)) inValue = false;
      continue;
    }
    // `[mcp_servers.<name>]`, or a sub-table of it such as `[mcp_servers.<name>.env]`.
    const header = line.match(/^\s*\[\s*mcp_servers\.("?)([^\]".]+)\1(?:\.[^\]]*)?\s*\]/);
    if (header) { current = header[2]; if (mentionsHuqan(current)) found.add(current); continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    if (current && /^\s*(command|args|url)\s*=/.test(line)) {
      if (mentionsHuqan(line)) found.add(current);
      // A value that opens a multi-line array keeps the scan going until it closes.
      if (/=\s*\[[^\]]*$/.test(line)) inValue = true;
    }
  }
  return [...found];
}

function readConfig(file, format, deps) {
  let stat;
  try { stat = deps.statSync(file); } catch (_) { return { exists: false }; }
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return { exists: true, readable: false };
  let text;
  try { text = deps.readFileSync(file, 'utf8'); } catch (_) { return { exists: true, readable: false }; }
  if (format === 'toml') return { exists: true, readable: true, entries: huqanEntriesInToml(text) };
  try {
    return { exists: true, readable: true, entries: huqanEntriesInJson(JSON.parse(stripJsonComments(text))) };
  } catch (_) {
    return { exists: true, readable: false };
  }
}

function exists(target, deps) {
  try { deps.statSync(target); return true; } catch (_) { return false; }
}

/**
 * @returns {Array<{id, name, kind, installed, huqanConfigured, entries, configFiles}>}
 */
function discoverAgents(options = {}) {
  const deps = { statSync: options.statSync || fs.statSync, readFileSync: options.readFileSync || fs.readFileSync };
  const home = options.home || os.homedir();
  const appData = options.appData !== undefined ? options.appData : (process.env.APPDATA || '');
  return agentCatalog({ home, appData }).map((agent) => {
    const configs = agent.configs.map((c) => ({ file: c.file, ...readConfig(c.file, c.format, deps) }));
    const entries = [...new Set(configs.flatMap((c) => c.entries || []))];
    const installed = agent.markers.some((m) => exists(m, deps)) || configs.some((c) => c.exists);
    return {
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      installed,
      huqanConfigured: entries.length > 0,
      entries,
      configFiles: configs.filter((c) => c.exists).map((c) => c.file),
      unreadable: configs.some((c) => c.exists && !c.readable),
    };
  });
}

module.exports = Object.freeze({ agentCatalog, discoverAgents, huqanEntriesInJson, huqanEntriesInToml, stripJsonComments });
