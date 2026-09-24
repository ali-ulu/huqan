'use strict';
// #2145: the JSON hook entries the installer writes into Claude Code and Codex
// configs -- building them, recognising the ones it owns, and refusing to touch
// entries someone has edited.
const fs = require('node:fs');
const { fail, plain, readJson, writeJson, jsonTemplate } = require('./external-action-gate-install-spec');
function hookEvents(profile) {
  return profile === 'claude-code' ? ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] : ['PreToolUse'];
}
function hookTemplate(profile, event = 'PreToolUse') {
  return jsonTemplate(profile === 'claude-code' ? 'claude-code-hooks.json' : 'codex-hooks.json').hooks[event][0];
}
function hookEntry(profile, command, event = 'PreToolUse') {
  const entry = hookTemplate(profile, event);
  const invocation = `${command}${event === 'PreToolUse' ? '' : ' browser-outcome'} --profile ${profile}`;
  entry.hooks = entry.hooks.map(hook => ({
    ...hook,
    ...(hook.command === undefined ? {} : { command: invocation }),
    ...(hook.commandWindows === undefined ? {} : { commandWindows: invocation }),
  }));
  return entry;
}
function validateHookConfig(config, target) {
  if (config.hooks !== undefined && !plain(config.hooks)) fail(`hooks must be an object: ${target}`);
  if (config.hooks?.PreToolUse !== undefined && !Array.isArray(config.hooks.PreToolUse)) fail(`hooks.PreToolUse must be an array: ${target}`);
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    if (config.hooks?.[event] !== undefined && !Array.isArray(config.hooks[event])) fail(`hooks.${event} must be an array: ${target}`);
  }
}
function hookCommands(entry) {
  return plain(entry) && Array.isArray(entry.hooks)
    ? entry.hooks.filter(plain).flatMap(hook => [hook.command, hook.commandWindows]).filter(command => typeof command === 'string')
    : [];
}
/**
 * A command this install could have written: some spelling of the gate entry
 * followed by nothing but `--profile <profile>`. Anything else -- extra flags,
 * a wrapper script -- is a local edit, and the caller refuses to overwrite or
 * remove those rather than silently reclaiming them.
 */
function ownedCommand(command, profile, event = 'PreToolUse') {
  const suffix = `${event === 'PreToolUse' ? '' : 'browser-outcome '}--profile ${profile}`;
  const trimmed = command.trim();
  if (!trimmed.endsWith(suffix)) return false;
  const head = trimmed.slice(0, -suffix.length).trim();
  return /(^|[\\/])huqan-gate(\.cmd)?"?$/.test(head) || /huqan-gate-hook\.js"?$/.test(head);
}
function ownsHook(entry, profile, event = 'PreToolUse') {
  const expected = hookTemplate(profile, event);
  const commands = hookCommands(entry);
  return plain(entry) && entry.matcher === expected.matcher
    && Array.isArray(entry.hooks) && entry.hooks.length === expected.hooks.length
    && entry.hooks.every((hook, index) => plain(hook) && hook.type === expected.hooks[index].type && hook.timeout === expected.hooks[index].timeout)
    && commands.length > 0 && commands.every(command => ownedCommand(command, profile, event));
}
function mentionsHuqanHook(entry, profile) {
  return hookCommands(entry).some(command => command.includes('huqan-gate') && command.includes(`--profile ${profile}`));
}
function installJsonHook(spec, profile, command) {
  const config = readJson(spec.target);
  validateHookConfig(config, spec.target);
  config.hooks = { ...(config.hooks || {}) };
  for (const event of hookEvents(profile)) {
    const current = [...(config.hooks[event] || [])];
    // An owned entry is left in place, never refreshed: if the recorded
    // command no longer runs, the install must fail over it (the sentinel
    // below proves the recorded command, not a replacement) and remove
    // nothing. Silently swapping it would paper over a dead gate.
    if (!current.some(entry => ownsHook(entry, profile, event))) {
      if (current.some(entry => mentionsHuqanHook(entry, profile))) fail(`refusing to overwrite modified HUQAN hook: ${spec.target}`);
      current.push(hookEntry(profile, command, event));
    }
    config.hooks[event] = current;
  }
  writeJson(spec.target, config);
}
function uninstallJsonHook(spec, profile) {
  if (!fs.existsSync(spec.target)) return false;
  const config = readJson(spec.target);
  validateHookConfig(config, spec.target);
  let changed = false;
  config.hooks = { ...(config.hooks || {}) };
  for (const event of hookEvents(profile)) {
    const before = config.hooks[event] || [];
    if (before.some(entry => mentionsHuqanHook(entry, profile) && !ownsHook(entry, profile, event))) {
      fail(`refusing to remove modified HUQAN hook: ${spec.target}`);
    }
    const after = before.filter(entry => !ownsHook(entry, profile, event));
    if (after.length !== before.length) { config.hooks[event] = after; changed = true; }
  }
  if (!changed) return false;
  writeJson(spec.target, config);
  return true;
}
function installedHookCommand(spec, profile) {
  const entry = (readJson(spec.target).hooks?.PreToolUse || []).find(candidate => ownsHook(candidate, profile));
  const hook = entry && entry.hooks.find(plain);
  const command = hook && (process.platform === 'win32' && hook.commandWindows ? hook.commandWindows : hook.command);
  if (!command) fail(`no HUQAN hook command to validate: ${spec.target}`);
  return command;
}

module.exports = Object.freeze({
  hookEvents, validateHookConfig, ownsHook, installJsonHook, uninstallJsonHook, installedHookCommand,
});
