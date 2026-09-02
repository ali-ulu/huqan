'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateHookInvocation } = require('./external-action-adapter');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');

const PROFILES = Object.freeze(['claude-code', 'codex', 'opencode', 'pi', 'hermes']);
const ADAPTER_ROOT = path.resolve(__dirname, '..', 'adapters', 'external-action');

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

function hookEntry(profile) {
  return jsonTemplate(profile === 'claude-code' ? 'claude-code-hooks.json' : 'codex-hooks.json').hooks.PreToolUse[0];
}
function validateHookConfig(config, target) {
  if (config.hooks !== undefined && !plain(config.hooks)) fail(`hooks must be an object: ${target}`);
  if (config.hooks?.PreToolUse !== undefined && !Array.isArray(config.hooks.PreToolUse)) fail(`hooks.PreToolUse must be an array: ${target}`);
}
function ownsHook(entry, profile) {
  return same(entry, hookEntry(profile));
}
function mentionsHuqanHook(entry, profile) {
  return plain(entry) && Array.isArray(entry.hooks) && entry.hooks.some(hook => plain(hook)
    && [hook.command, hook.commandWindows].some(command => typeof command === 'string'
      && command.includes(`huqan-gate${command.includes('.cmd') ? '.cmd' : ''} --profile ${profile}`)));
}
function installJsonHook(spec, profile) {
  const config = readJson(spec.target);
  validateHookConfig(config, spec.target);
  const current = config.hooks?.PreToolUse || [];
  if (!current.some(entry => ownsHook(entry, profile))) {
    if (current.some(entry => mentionsHuqanHook(entry, profile))) fail(`refusing to overwrite modified HUQAN hook: ${spec.target}`);
    current.push(hookEntry(profile));
  }
  config.hooks = { ...(config.hooks || {}), PreToolUse: current };
  writeJson(spec.target, config);
}
function uninstallJsonHook(spec, profile) {
  if (!fs.existsSync(spec.target)) return false;
  const config = readJson(spec.target);
  validateHookConfig(config, spec.target);
  const before = config.hooks?.PreToolUse || [];
  if (before.some(entry => mentionsHuqanHook(entry, profile) && !ownsHook(entry, profile))) {
    fail(`refusing to remove modified HUQAN hook: ${spec.target}`);
  }
  const after = before.filter(entry => !ownsHook(entry, profile));
  if (after.length === before.length) return false;
  config.hooks = { ...(config.hooks || {}), PreToolUse: after };
  writeJson(spec.target, config);
  return true;
}
function installFile(spec) {
  const content = template(spec.source);
  if (fs.existsSync(spec.target) && fs.readFileSync(spec.target, 'utf8') !== content) fail(`refusing to overwrite non-HUQAN file: ${spec.target}`);
  fs.mkdirSync(path.dirname(spec.target), { recursive: true });
  fs.writeFileSync(spec.target, content, 'utf8');
}
function uninstallFile(spec) {
  if (!fs.existsSync(spec.target)) return false;
  if (fs.readFileSync(spec.target, 'utf8') !== template(spec.source)) fail(`refusing to remove modified file: ${spec.target}`);
  fs.unlinkSync(spec.target);
  return true;
}
function installDirectory(spec) {
  if (fs.existsSync(spec.target)) {
    for (const source of fs.readdirSync(path.join(ADAPTER_ROOT, spec.source))) {
      const target = path.join(spec.target, source);
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== template(path.join(spec.source, source))) {
        fail(`refusing to overwrite modified file: ${target}`);
      }
    }
  }
  fs.mkdirSync(spec.target, { recursive: true });
  for (const source of fs.readdirSync(path.join(ADAPTER_ROOT, spec.source))) {
    fs.writeFileSync(path.join(spec.target, source), template(path.join(spec.source, source)), 'utf8');
  }
}
function uninstallDirectory(spec) {
  if (!fs.existsSync(spec.target)) return false;
  const expected = fs.readdirSync(path.join(ADAPTER_ROOT, spec.source)).sort();
  const actual = fs.readdirSync(spec.target).sort();
  if (!same(actual, expected) || actual.some(name => fs.readFileSync(path.join(spec.target, name), 'utf8') !== template(path.join(spec.source, name)))) {
    fail(`refusing to remove modified directory: ${spec.target}`);
  }
  fs.rmSync(spec.target, { recursive: true });
  return true;
}

function sentinelPayload(profile, root) {
  const base = { session_id: 'huqan-install-sentinel', tool_use_id: 'huqan-install-sentinel', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: root };
  if (profile === 'opencode') return { sessionID: base.session_id, callID: base.tool_use_id, tool: 'bash', args: { command: 'rm -rf /' }, cwd: root };
  if (profile === 'pi') return { session_id: base.session_id, tool_call_id: base.tool_use_id, tool_name: 'bash', args: { command: 'rm -rf /' }, cwd: root };
  if (profile === 'hermes') return { session_id: base.session_id, tool_call_id: base.tool_use_id, tool_name: 'bash', args: { command: 'rm -rf /' }, cwd: root };
  return base;
}
function selfValidate(profile, root) {
  const evaluated = evaluateHookInvocation(profile, sentinelPayload(profile, root), { workspaceRoot: root, allowControlPlane: true });
  if (evaluated.result.decision !== 'block') fail(`sentinel did not block for profile ${profile}: ${evaluated.result.decision}`);
  return { live: true, decision: evaluated.result.decision, reason: evaluated.result.reason };
}
function lastReceipt(pathname) {
  if (!fs.existsSync(pathname)) return null;
  const lines = fs.readFileSync(pathname, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  try {
    const receipt = JSON.parse(lines.at(-1));
    return { path: pathname, createdAt: receipt.createdAt || receipt.timestamp || null, receiptId: receipt.receiptId || null, decision: receipt.decision || null };
  } catch (_) { return { path: pathname, invalid: true }; }
}
function installed(spec, profile) {
  if (spec.kind === 'json-hook') {
    if (!fs.existsSync(spec.target)) return false;
    const config = readJson(spec.target); validateHookConfig(config, spec.target);
    return (config.hooks?.PreToolUse || []).some(entry => ownsHook(entry, profile));
  }
  if (spec.kind === 'file') return fs.existsSync(spec.target) && fs.readFileSync(spec.target, 'utf8') === template(spec.source);
  if (!fs.existsSync(spec.target)) return false;
  return fs.readdirSync(path.join(ADAPTER_ROOT, spec.source)).every(name => fs.existsSync(path.join(spec.target, name))
    && fs.readFileSync(path.join(spec.target, name), 'utf8') === template(path.join(spec.source, name)));
}

function manageGate(command, options = {}) {
  if (!options.deploymentAuthorized) fail('gate management requires deployment authority');
  const root = path.resolve(options.root || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const profiles = options.profile ? [options.profile] : PROFILES;
  if (command === 'status') {
    return { command, clients: profiles.map(profile => { const spec = profileSpec(profile, root, home); return { profile, installed: installed(spec, profile), target: spec.target }; }), lastReceipt: lastReceipt(options.receiptPath || defaultExternalActionReceiptPath()) };
  }
  if (profiles.length !== 1) fail(`${command} requires --profile`);
  const profile = profiles[0];
  const spec = profileSpec(profile, root, home);
  if (command === 'install') {
    if (spec.kind === 'json-hook') installJsonHook(spec, profile);
    else if (spec.kind === 'file') installFile(spec);
    else installDirectory(spec);
    return { command, profile, target: spec.target, installed: true, sentinel: selfValidate(profile, root) };
  }
  if (command === 'uninstall') {
    const removed = spec.kind === 'json-hook' ? uninstallJsonHook(spec, profile) : spec.kind === 'file' ? uninstallFile(spec) : uninstallDirectory(spec);
    return { command, profile, target: spec.target, removed };
  }
  fail(`unsupported gate command: ${command}`);
}

module.exports = Object.freeze({ PROFILES, manageGate });
