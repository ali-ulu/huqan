'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Which agents are on this machine (#2050).
 *
 * The install machinery is thorough once it knows the profile name, but the
 * user has to supply that name -- and a user who has never heard the word
 * "hook" cannot. So the friction was never the install: it was being asked a
 * question about internals before anything happened.
 *
 * Detection triggers on the presence of the *agent*, not the presence of a
 * config the agent may not have written yet. `.claude/settings.json` does not
 * exist until something writes it, and refusing to connect because the file is
 * missing would refuse exactly the first-time user this exists for. Install
 * creates it.
 *
 * Three independent signals, any one of which counts, in descending strength:
 *
 *   project   the agent's directory exists in this project
 *   home      the agent's directory exists in the user's home
 *   path      the agent's launcher is on PATH
 *
 * A signal is evidence the agent exists, never evidence the gate works. Only
 * the sentinel run inside install can say that.
 */

const AGENTS = Object.freeze([
  Object.freeze({ profile: 'claude-code', label: 'Claude Code', marker: '.claude', binaries: ['claude'] }),
  Object.freeze({ profile: 'codex', label: 'Codex', marker: '.codex', binaries: ['codex'] }),
  Object.freeze({ profile: 'opencode', label: 'OpenCode', marker: '.opencode', binaries: ['opencode'] }),
  Object.freeze({ profile: 'pi', label: 'Pi', marker: '.pi', binaries: ['pi'] }),
  Object.freeze({ profile: 'hermes', label: 'Hermes', marker: '.hermes', binaries: ['hermes'] }),
]);

function directoryExists(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch (_) {
    return false;
  }
}

function onSearchPath(name, environment) {
  const extensions = process.platform === 'win32'
    ? String(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return String(environment.PATH || environment.Path || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some(dir => extensions.some(extension => {
      try {
        return fs.existsSync(path.join(dir.replace(/^"|"$/g, ''), `${name}${extension}`));
      } catch (_) {
        return false;
      }
    }));
}

/**
 * @param {object} [options]
 * @param {string} [options.root] project directory
 * @param {string} [options.home] user home directory
 * @param {NodeJS.ProcessEnv} [options.environment]
 * @returns {{profile: string, label: string, detected: boolean, signals: string[]}[]}
 */
function detectAgents(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const home = path.resolve(options.home || require('node:os').homedir());
  const environment = options.environment || process.env;

  return AGENTS.map((agent) => {
    const signals = [];
    if (directoryExists(path.join(root, agent.marker))) signals.push('project');
    if (directoryExists(path.join(home, agent.marker))) signals.push('home');
    if (agent.binaries.some(binary => onSearchPath(binary, environment))) signals.push('path');
    return {
      profile: agent.profile,
      label: agent.label,
      detected: signals.length > 0,
      signals,
    };
  });
}

module.exports = {
  DETECTABLE_AGENTS: AGENTS,
  detectAgents,
};
