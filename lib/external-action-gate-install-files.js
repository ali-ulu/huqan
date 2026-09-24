'use strict';
// #2145: the file and directory artifacts the installer places for the
// OpenCode, Pi and Hermes profiles, and the check that says whether any
// profile's artifact is installed as this package would have written it.
const fs = require('node:fs');
const path = require('node:path');
const {
  ADAPTER_ROOT, HERMES_GATE_CONFIG, fail, readJson, writeJson, template, same,
} = require('./external-action-gate-install-spec');
const { hookEvents, validateHookConfig, ownsHook } = require('./external-action-gate-install-hooks');
function installFile(spec) {
  const content = template(spec.source);
  // Read, rather than check for existence and then read: nothing can swap the
  // file between an existence check and the read that decides the overwrite.
  let current = null;
  try { current = fs.readFileSync(spec.target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== null && current !== content) fail(`refusing to overwrite non-HUQAN file: ${spec.target}`);
  fs.mkdirSync(path.dirname(spec.target), { recursive: true });
  fs.writeFileSync(spec.target, content, 'utf8');
}
function uninstallFile(spec) {
  if (!fs.existsSync(spec.target)) return false;
  if (fs.readFileSync(spec.target, 'utf8') !== template(spec.source)) fail(`refusing to remove modified file: ${spec.target}`);
  fs.unlinkSync(spec.target);
  return true;
}
function gateArgv(command) { return command.split(' '); }
function ownsGateArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 2 || argv.some(value => typeof value !== 'string' || !value)) return false;
  if (argv.length === 1) return /(^|[\\/])huqan-gate(\.cmd)?$/.test(argv[0]);
  return /(^|[\\/])node(\.exe)?$/.test(argv[0]) && /(^|[\\/])huqan-gate-hook\.js$/.test(argv[1]);
}
function hermesGateConfig(command) { return { schemaVersion: 1, argv: gateArgv(command) }; }
function readHermesGateConfig(spec) {
  const target = path.join(spec.target, HERMES_GATE_CONFIG);
  const config = readJson(target);
  if (config.schemaVersion !== 1 || !ownsGateArgv(config.argv) || Object.keys(config).sort().join(',') !== 'argv,schemaVersion') {
    fail(`refusing modified Hermes gate command: ${target}`);
  }
  return config;
}
function installDirectory(spec, command) {
  if (fs.existsSync(spec.target)) {
    for (const source of fs.readdirSync(path.join(ADAPTER_ROOT, spec.source))) {
      const target = path.join(spec.target, source);
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== template(path.join(spec.source, source))) {
        fail(`refusing to overwrite modified file: ${target}`);
      }
    }
    const configTarget = path.join(spec.target, HERMES_GATE_CONFIG);
    if (fs.existsSync(configTarget)) readHermesGateConfig(spec);
  }
  fs.mkdirSync(spec.target, { recursive: true });
  for (const source of fs.readdirSync(path.join(ADAPTER_ROOT, spec.source))) {
    fs.writeFileSync(path.join(spec.target, source), template(path.join(spec.source, source)), 'utf8');
  }
  writeJson(path.join(spec.target, HERMES_GATE_CONFIG), hermesGateConfig(command));
}
function uninstallDirectory(spec) {
  if (!fs.existsSync(spec.target)) return false;
  readHermesGateConfig(spec);
  const expected = [...fs.readdirSync(path.join(ADAPTER_ROOT, spec.source)), HERMES_GATE_CONFIG].sort();
  // Importing a Python plugin normally creates this interpreter-owned cache.
  // It is not a local source edit and must not make an otherwise owned plugin
  // impossible to uninstall.
  const actual = fs.readdirSync(spec.target).filter(name => name !== '__pycache__').sort();
  const staticNames = fs.readdirSync(path.join(ADAPTER_ROOT, spec.source));
  if (!same(actual, expected) || staticNames.some(name => fs.readFileSync(path.join(spec.target, name), 'utf8') !== template(path.join(spec.source, name)))) {
    fail(`refusing to remove modified directory: ${spec.target}`);
  }
  fs.rmSync(spec.target, { recursive: true });
  return true;
}
function installed(spec, profile) {
  if (spec.kind === 'json-hook') {
    if (!fs.existsSync(spec.target)) return false;
    const config = readJson(spec.target); validateHookConfig(config, spec.target);
    return hookEvents(profile).every(event => (config.hooks?.[event] || []).some(entry => ownsHook(entry, profile, event)));
  }
  if (spec.kind === 'file') return fs.existsSync(spec.target) && fs.readFileSync(spec.target, 'utf8') === template(spec.source);
  if (!fs.existsSync(spec.target)) return false;
  const staticNames = fs.readdirSync(path.join(ADAPTER_ROOT, spec.source));
  try {
    return staticNames.every(name => fs.existsSync(path.join(spec.target, name))
      && fs.readFileSync(path.join(spec.target, name), 'utf8') === template(path.join(spec.source, name)))
      && Boolean(readHermesGateConfig(spec));
  } catch (_) { return false; }
}

module.exports = Object.freeze({ installFile, uninstallFile, installDirectory, uninstallDirectory, installed });
