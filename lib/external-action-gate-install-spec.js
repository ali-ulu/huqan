'use strict';
// #2145: profile targets and config IO for the gate installer, split out of
// external-action-gate-install.js. The other install modules read and write
// through these helpers, so a malformed config is refused the same way everywhere.
const fs = require('node:fs');
const path = require('node:path');
const PROFILES = Object.freeze(['claude-code', 'codex', 'opencode', 'pi', 'hermes']);
// Not in PROFILES: there is no artifact to install or inspect for a custom
// agent, so it is answered from the receipt trail instead (#2048).
const GENERIC_PROFILE = 'generic';
const ADAPTER_ROOT = path.resolve(__dirname, '..', 'adapters', 'external-action');
const HERMES_GATE_CONFIG = 'huqan-gate.json';

function fail(message) { throw new Error(message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function readJson(target) {
  if (!fs.existsSync(target)) return {};
  let value;
  try { value = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { fail(`invalid JSON config: ${target}`); }
  if (!plain(value)) fail(`config root must be an object: ${target}`);
  return value;
}
function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function template(name) { return fs.readFileSync(path.join(ADAPTER_ROOT, name), 'utf8'); }
function jsonTemplate(name) { return JSON.parse(template(name)); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function profileSpec(profile, root, home) {
  if (!PROFILES.includes(profile)) fail(`unsupported profile: ${profile}`);
  if (profile === 'claude-code') return { kind: 'json-hook', target: path.join(root, '.claude', 'settings.json'), source: 'claude-code-hooks.json' };
  if (profile === 'codex') return { kind: 'json-hook', target: path.join(root, '.codex', 'hooks.json'), source: 'codex-hooks.json' };
  if (profile === 'opencode') return { kind: 'file', target: path.join(root, '.opencode', 'plugin', 'huqan.mjs'), source: 'opencode-plugin.mjs' };
  if (profile === 'pi') return { kind: 'file', target: path.join(root, '.pi', 'extensions', 'huqan.js'), source: 'pi-extension.js' };
  return { kind: 'directory', target: path.join(home, '.hermes', 'plugins', 'huqan-external-action-guard'), source: 'hermes' };
}
module.exports = Object.freeze({
  PROFILES, GENERIC_PROFILE, ADAPTER_ROOT, HERMES_GATE_CONFIG,
  fail, plain, readJson, writeJson, template, jsonTemplate, same, profileSpec,
});
