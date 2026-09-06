'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluateHookInvocation } = require('./external-action-adapter');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');

const PROFILES = Object.freeze(['claude-code', 'codex', 'opencode', 'pi', 'hermes']);
const ADAPTER_ROOT = path.resolve(__dirname, '..', 'adapters', 'external-action');
const SENTINEL_RUNNER = path.resolve(__dirname, 'external-action-gate-sentinel.js');
const GATE_BIN = path.resolve(__dirname, '..', 'bin', 'huqan-gate-hook.js');
const SENTINEL_TIMEOUT_MS = 30000;
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

/**
 * Windows short name (`C:\PROGRA~1\...`) for a path with spaces.
 *
 * Quoting is not an option here: a hook command is a string the *host* hands
 * to a shell, and `"C:\Program Files\nodejs\node.exe" script.js` is a parser
 * error in PowerShell, which needs `& "..."` -- while `&` at the front is a
 * syntax error in cmd.exe. No quoted spelling runs in both, so the way out is
 * a path with no spaces to quote (#1797).
 */
function unspaced(target) {
  if (process.platform !== 'win32' || !/\s/.test(target)) return target;
  const run = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `for %I in ("${target}") do @echo %~sI`], { encoding: 'utf8' });
  const short = String(run.stdout || '').trim();
  return short && !/\s/.test(short) && fs.existsSync(short) ? short : target;
}

/** PATH lookup with PATHEXT, the way a shell resolves a bare command name. */
function onSearchPath(name, environment) {
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return (environment.PATH || environment.Path || '').split(path.delimiter).filter(Boolean).some(dir => extensions
    .some(extension => fs.existsSync(path.join(dir.replace(/^"|"$/g, ''), `${name}${extension}`))));
}

/**
 * Spellings of the gate entry, most portable first: an explicit
 * HUQAN_GATE_PATH (the same knob the Hermes plugin reads), the name on PATH,
 * the workspace's own bin shim, `node` plus this package's entry, and the
 * absolute Node binary as a last resort.
 *
 * The templates used to record `huqan-gate --profile X` verbatim, which only
 * works where that name is on PATH. When it is not, the host still runs the
 * hook, the command fails to start, and the host decides what a failed hook
 * means -- Codex runs the tool anyway (#1797), which is the quiet loss of the
 * whole guard.
 *
 * Candidates that still carry a space after `unspaced` are dropped rather than
 * quoted, because a quoted path cannot be written to run in both cmd.exe and
 * PowerShell. Which candidate survives is decided by running it, not by
 * guessing -- see `pickGateCommand`.
 */
function gateCommandCandidates(root, environment = process.env) {
  const configured = String(environment.HUQAN_GATE_PATH || '').trim();
  const shim = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'huqan-gate.cmd' : 'huqan-gate');
  return [
    ...(configured ? [unspaced(configured)] : []),
    ...(onSearchPath('huqan-gate', environment) ? ['huqan-gate'] : []),
    ...(fs.existsSync(shim) ? [unspaced(shim)] : []),
    ...(onSearchPath('node', environment) ? [`node ${unspaced(GATE_BIN)}`] : []),
    `${unspaced(process.execPath)} ${unspaced(GATE_BIN)}`,
    // At most `<launcher> <script>`: more tokens than that means `unspaced`
    // could not remove a space, and the candidate would need quoting.
  ].filter(candidate => candidate.split(' ').length <= 2 && !candidate.includes('"'));
}

function hookTemplate(profile) {
  return jsonTemplate(profile === 'claude-code' ? 'claude-code-hooks.json' : 'codex-hooks.json').hooks.PreToolUse[0];
}
function hookEntry(profile, command) {
  const entry = hookTemplate(profile);
  const invocation = `${command} --profile ${profile}`;
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
function ownedCommand(command, profile) {
  const suffix = `--profile ${profile}`;
  const trimmed = command.trim();
  if (!trimmed.endsWith(suffix)) return false;
  const head = trimmed.slice(0, -suffix.length).trim();
  return /(^|[\\/])huqan-gate(\.cmd)?"?$/.test(head) || /huqan-gate-hook\.js"?$/.test(head);
}
function ownsHook(entry, profile) {
  const expected = hookTemplate(profile);
  const commands = hookCommands(entry);
  return plain(entry) && entry.matcher === expected.matcher
    && Array.isArray(entry.hooks) && entry.hooks.length === expected.hooks.length
    && entry.hooks.every((hook, index) => plain(hook) && hook.type === expected.hooks[index].type && hook.timeout === expected.hooks[index].timeout)
    && commands.length > 0 && commands.every(command => ownedCommand(command, profile));
}
function mentionsHuqanHook(entry, profile) {
  return hookCommands(entry).some(command => command.includes('huqan-gate') && command.includes(`--profile ${profile}`));
}
function installJsonHook(spec, profile, command) {
  const config = readJson(spec.target);
  validateHookConfig(config, spec.target);
  const current = config.hooks?.PreToolUse || [];
  if (!current.some(entry => ownsHook(entry, profile))) {
    if (current.some(entry => mentionsHuqanHook(entry, profile))) fail(`refusing to overwrite modified HUQAN hook: ${spec.target}`);
    current.push(hookEntry(profile, command));
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

function sentinelPayload(profile, root) {
  const base = { session_id: 'huqan-install-sentinel', tool_use_id: 'huqan-install-sentinel', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: root };
  if (profile === 'opencode') return { sessionID: base.session_id, callID: base.tool_use_id, tool: 'bash', args: { command: 'rm -rf /' }, cwd: root };
  // Pi nests the call under `event` and names the fields in camelCase (see
  // normalizeHookInvocation). The flat snake_case payload this used to send
  // normalized to `toolName: undefined`, so the sentinel blocked -- but as
  // `malformed_external_action_blocked`, proving the malformed-input path
  // rather than the denylist it was written to prove.
  if (profile === 'pi') {
    return { event: { toolCallId: base.tool_use_id, toolName: 'bash', input: { command: 'rm -rf /' } }, sessionId: base.session_id, cwd: root };
  }
  if (profile === 'hermes') return { session_id: base.session_id, tool_call_id: base.tool_use_id, tool_name: 'bash', args: { command: 'rm -rf /' }, cwd: root };
  return base;
}
/**
 * The artifacts installed for `file` profiles import the `huqan` package by
 * bare specifier. A bare specifier resolves from the *installed file's*
 * directory, not from this process, and a global npm install is invisible to
 * it -- so an install can look perfect and still leave a plugin that dies with
 * ERR_MODULE_NOT_FOUND the first time the host loads it (#1792).
 *
 * Checked before anything is written, so a refused install leaves no trace.
 */
function assertDependencyResolvable(spec, root) {
  if (spec.kind !== 'file') return;
  try {
    require.resolve('huqan', { paths: [path.dirname(spec.target), root] });
  } catch (_) {
    fail(`huqan is not resolvable from ${root}: the installed plugin imports it by name, `
      + 'so install the package there (npm install huqan) before installing the gate. '
      + 'A global npm install does not satisfy a bare import.');
  }
}

/**
 * Load the artifact that was just written and drive it through its host's
 * contract, in a child process anchored at the artifact's own directory so the
 * bare `huqan` import resolves exactly as it will for the host.
 *
 * Receipts are redirected to a throwaway file: the sentinel is a synthetic
 * `rm -rf /`, and a deployment's evidence trail should not open with a block
 * that never happened. The redirect doubles as proof -- a guard that blocks
 * without leaving a receipt has lost the half of the product that matters
 * (#1794), and here that shows up as an install failure rather than silence.
 */
function wrote(receiptPath) {
  return fs.existsSync(receiptPath) && fs.readFileSync(receiptPath, 'utf8').trim() !== '';
}
/**
 * Everything the sentinel run persists goes to a throwaway directory: the JSONL
 * trail and, for the CLI path, the graph the durable writer opens. The legacy
 * AXIOM_* twins are dropped because the guard refuses to start when a variable
 * and its twin disagree, and here they would.
 */
function withSentinelScratch(run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-sentinel-'));
  const receiptPath = path.join(scratch, 'receipts.jsonl');
  const environment = {
    ...process.env,
    HUQAN_EXTERNAL_GUARD_RECEIPTS: receiptPath,
    HUQAN_MEMORY_PATH: path.join(scratch, 'memory.json'),
    HUQAN_DB_PATH: path.join(scratch, 'memory.db'),
  };
  delete environment.AXIOM_MEMORY_PATH;
  delete environment.AXIOM_DB_PATH;
  try {
    return run(environment, receiptPath);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function exerciseArtifact(spec, profile, payload, root) {
  return withSentinelScratch((env, receiptPath) => {
    const run = spawnSync(process.execPath, [SENTINEL_RUNNER, profile, spec.target, root], {
      input: JSON.stringify(payload), cwd: root, encoding: 'utf8', timeout: SENTINEL_TIMEOUT_MS, env,
    });
    if (run.error) fail(`could not run the installed artifact: ${run.error.message}`);
    let outcome;
    try { outcome = JSON.parse(run.stdout || '{}'); } catch (_) { outcome = {}; }
    if (outcome.error) fail(`installed artifact is not loadable: ${outcome.error}`);
    if (!outcome.decision) fail(`installed artifact returned no decision: ${(run.stderr || run.stdout || '').trim()}`);
    return { ...outcome, receiptWritten: wrote(receiptPath) };
  });
}

function installedHookCommand(spec, profile) {
  const entry = (readJson(spec.target).hooks?.PreToolUse || []).find(candidate => ownsHook(candidate, profile));
  const hook = entry && entry.hooks.find(plain);
  const command = hook && (process.platform === 'win32' && hook.commandWindows ? hook.commandWindows : hook.command);
  if (!command) fail(`no HUQAN hook command to validate: ${spec.target}`);
  return command;
}

/**
 * The shells a host may hand a hook command to. Validating under only one of
 * them is how a command that cmd.exe runs happily was recorded for a host that
 * uses PowerShell, where the same string is a parser error (#1797): the
 * install proved the command against the wrong interpreter and called it live.
 */
const HOST_SHELLS = Object.freeze(process.platform === 'win32'
  ? [
    { name: 'cmd', file: process.env.ComSpec || 'cmd.exe', argv: command => ['/d', '/s', '/c', command] },
    { name: 'powershell', file: 'powershell.exe', argv: command => ['-NoProfile', '-NonInteractive', '-Command', command] },
  ]
  : [{ name: 'sh', file: '/bin/sh', argv: command => ['-c', command] }]);

const HOOK_DECISIONS = Object.freeze({ deny: 'block', ask: 'review' });

/** A shell that is not installed cannot be a host's shell; skip, do not fail. */
function shellMissing(run) {
  return Boolean(run.error) && ['ENOENT', 'EACCES'].includes(run.error.code);
}

function runHookCommand(shell, command, payload, root, env) {
  const run = spawnSync(shell.file, shell.argv(command), {
    input: JSON.stringify(payload), cwd: root, encoding: 'utf8', timeout: SENTINEL_TIMEOUT_MS, env,
  });
  if (shellMissing(run)) return null;
  if (run.error) fail(`hook command could not be run under ${shell.name} (${command}): ${run.error.message}`);
  if (run.status !== 0) fail(`hook command failed under ${shell.name} (${command}): exit ${run.status}: ${(run.stderr || '').trim()}`);
  let output;
  try { output = JSON.parse(run.stdout || '{}'); } catch (_) {
    fail(`hook command returned no JSON decision under ${shell.name} (${command}): ${(run.stdout || run.stderr || '').trim()}`);
  }
  const specific = output.hookSpecificOutput || {};
  return {
    decision: output.action === 'block' ? 'block' : HOOK_DECISIONS[specific.permissionDecision] || 'allow',
    reason: specific.permissionDecisionReason || output.message || '',
  };
}

/**
 * Run a command through every shell available here, and say which ones were
 * used -- a claim about a hook is only worth the interpreters it was tested
 * against.
 */
function exerciseCommand(command, payload, root) {
  return withSentinelScratch((env, receiptPath) => {
    const shells = [];
    for (const shell of HOST_SHELLS) {
      const outcome = runHookCommand(shell, command, payload, root, env);
      if (outcome) shells.push({ ...outcome, shell: shell.name });
    }
    if (!shells.length) fail(`no host shell available to validate the hook command: ${command}`);
    return { command, shells, receiptWritten: wrote(receiptPath) };
  });
}

function exerciseHookCommand(spec, profile, payload, root) {
  return exerciseCommand(installedHookCommand(spec, profile), payload, root);
}

function exerciseHermesArtifact(spec, payload, root) {
  const script = [
    'import importlib.util, json, sys',
    'plugin_dir, root = sys.argv[1], sys.argv[2]',
    'spec = importlib.util.spec_from_file_location("huqan_external_action_guard", plugin_dir + "/__init__.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'payload = json.load(sys.stdin)',
    'result = module.guard_tool_call(payload["tool_name"], payload["args"], payload["session_id"], tool_call_id=payload.get("tool_call_id"), cwd=root)',
    'print(json.dumps(result))',
  ].join('; ');
  const candidates = process.platform === 'win32'
    ? [{ file: 'py', args: ['-3'] }, { file: 'python', args: [] }]
    : [{ file: 'python3', args: [] }, { file: 'python', args: [] }];
  return withSentinelScratch((env, receiptPath) => {
    const rejected = [];
    for (const candidate of candidates) {
      const run = spawnSync(candidate.file, [...candidate.args, '-c', script, spec.target, root], {
        input: JSON.stringify(payload), cwd: root, encoding: 'utf8', timeout: SENTINEL_TIMEOUT_MS, env,
      });
      if (!run.error && run.status === 0) {
        let output;
        try { output = JSON.parse(run.stdout || '{}'); } catch (_) { fail(`installed Hermes artifact returned invalid JSON: ${run.stdout}`); }
        return { decision: output.action === 'block' ? 'block' : 'allow', reason: String(output.message || ''), receiptWritten: wrote(receiptPath) };
      }
      rejected.push(`${candidate.file}: ${run.error ? run.error.message : String(run.stderr || '').trim() || `exit ${run.status}`}`);
    }
    fail(`installed Hermes artifact is not loadable. Tried:\n  ${rejected.join('\n  ')}`);
  });
}

/**
 * Pick the command to record by running each candidate, rather than by
 * assuming a spelling works. The first one that blocks the sentinel under
 * every available shell is recorded; if none does, the install refuses and
 * says what it tried, because writing an unrunnable hook is worse than not
 * installing.
 */
function evaluatorExpectation(profile, root, payload = sentinelPayload(profile, root)) {
  const evaluated = evaluateHookInvocation(profile, payload, { workspaceRoot: root, allowControlPlane: true });
  if (evaluated.result.decision !== 'block') fail(`sentinel did not block for profile ${profile}: ${evaluated.result.decision}`);
  return { decision: evaluated.result.decision, reason: evaluated.result.reason };
}

function pickGateCommand(profile, root) {
  const payload = sentinelPayload(profile, root);
  const expected = evaluatorExpectation(profile, root, payload);
  const rejected = [];
  for (const candidate of gateCommandCandidates(root)) {
    const invocation = `${candidate} --profile ${profile}`;
    try {
      const outcome = exerciseCommand(invocation, payload, root);
      if (outcome.shells.every(result => result.decision === expected.decision && result.reason.includes(expected.reason))) return candidate;
      rejected.push(`${invocation}: decided ${outcome.shells.map(result => `${result.shell}=${result.decision}`).join(', ')}`);
    } catch (error) {
      rejected.push(`${invocation}: ${error.message}`);
    }
  }
  fail(`no gate command runs in this host's shells. Tried:\n  ${rejected.join('\n  ')}`);
}

/**
 * Each profile is validated through the surface its host actually uses:
 * `file` profiles by loading the installed artifact, `json-hook` profiles by
 * running the command recorded in the config, and Hermes by loading the
 * installed Python plugin with the install-time-resolved gate argv.
 */
function selfValidate(profile, root, spec) {
  const payload = sentinelPayload(profile, root);
  const expected = evaluatorExpectation(profile, root, payload);
  if (spec.kind === 'json-hook') {
    const hook = exerciseHookCommand(spec, profile, payload, root);
    for (const result of hook.shells) {
      if (result.decision !== expected.decision) fail(`recorded hook command decided ${result.decision} under ${result.shell} where the guard decides ${expected.decision}`);
      if (!result.reason.includes(expected.reason)) fail(`recorded hook command blocked under ${result.shell} for a different reason: ${result.reason}`);
    }
    if (!hook.receiptWritten) fail(`recorded hook command blocked the sentinel without writing a receipt: ${hook.command}`);
    return { live: true, via: 'command', ...expected, receiptWritten: true, command: hook.command, shells: hook.shells.map(result => result.shell) };
  }
  if (spec.kind === 'directory') {
    const artifact = exerciseHermesArtifact(spec, payload, root);
    if (artifact.decision !== expected.decision || !artifact.reason.includes(expected.reason)) {
      fail(`installed Hermes artifact decided ${artifact.decision}/${artifact.reason} where the guard decides ${expected.decision}/${expected.reason}`);
    }
    if (!artifact.receiptWritten) fail(`installed Hermes artifact blocked the sentinel without writing a receipt: ${spec.target}`);
    return { live: true, via: 'artifact', ...expected, receiptWritten: true };
  }
  if (spec.kind !== 'file') return { live: true, via: 'evaluator', ...expected };
  const artifact = exerciseArtifact(spec, profile, payload, root);
  if (artifact.decision !== expected.decision || artifact.reason !== expected.reason) {
    fail(`installed artifact decided ${artifact.decision}/${artifact.reason} where the guard decides ${expected.decision}/${expected.reason}`);
  }
  if (!artifact.receiptWritten) fail(`installed artifact blocked the sentinel without writing a receipt: ${spec.target}`);
  return { live: true, via: 'artifact', ...expected, receiptWritten: true };
}
/**
 * Codex records, per hook it has been shown, a `trusted_hash` of that hook --
 *
 *   [hooks.state.'C:\Users\sonfi\.codex\hooks.json:pre_tool_use:0:0']
 *   trusted_hash = "sha256:f6f59e70..."
 *
 * -- and silently skips a hook it has no matching record for; the CLI carries
 * `--dangerously-bypass-hook-trust` for exactly that reason. So writing a hook
 * entry disarms the gate until a human approves it in an interactive turn,
 * which was measured here: a fresh command meant PreToolUse never fired again
 * and nothing said so (#1797).
 *
 * The hash itself is not recomputed -- its input is Codex's business, and
 * guessing it would be a claim this cannot back. Only two things are read:
 * whether a record exists for this hook, and whether this install wrote the
 * entry, which is the only way its command changes.
 */
const CODEX_TRUST_KEY = /^\s*\[hooks\.state\.(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\]/;
function codexTrustRecord(root, spec) {
  const store = path.join(root, '.codex', 'config.toml');
  if (!fs.existsSync(store)) return { store, present: false };
  const wanted = spec.target.toLowerCase();
  const present = fs.readFileSync(store, 'utf8').split(/\r?\n/).some(line => {
    const matched = CODEX_TRUST_KEY.exec(line);
    if (!matched) return false;
    const key = (matched[1] ?? matched[2].replace(/\\(.)/g, '$1')).toLowerCase();
    return key.startsWith(`${wanted}:`) && key.includes(':pre_tool_use:');
  });
  return { store, present };
}

/**
 * Reported on both install and status, because "is the gate approved by the
 * host" is a question you should be able to ask without reinstalling.
 */
function hostTrust(profile, root, spec, wroteEntry) {
  if (profile !== 'codex') return null;
  const { store, present } = codexTrustRecord(root, spec);
  if (!present) {
    return { host: 'codex', store, record: 'absent', reapprovalRequired: true, reason: 'Codex has no trust record for this hook, so it will skip it until you approve it in an interactive turn' };
  }
  if (wroteEntry) {
    return { host: 'codex', store, record: 'present', reapprovalRequired: true, reason: 'this install wrote the hook entry, so the stored trusted_hash is for the previous one; approve it again in an interactive turn' };
  }
  return { host: 'codex', store, record: 'present', reapprovalRequired: false, reason: '' };
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
  const staticNames = fs.readdirSync(path.join(ADAPTER_ROOT, spec.source));
  try {
    return staticNames.every(name => fs.existsSync(path.join(spec.target, name))
      && fs.readFileSync(path.join(spec.target, name), 'utf8') === template(path.join(spec.source, name)))
      && Boolean(readHermesGateConfig(spec));
  } catch (_) { return false; }
}

/**
 * Runtime re-evaluation of an installed gate artifact (#1890).
 *
 * `selfValidate` above runs once at install; a permission granted then
 * silently survives every later edit of the artifact. This is the hook for
 * per-call or periodic re-validation: it reads whatever is installed *now*
 * and drives it through the same sentinel contract, without writing
 * anything. Returns `{ live: true, ... }` on success and a fail-closed
 * `{ live: false, error }` result (rather than throwing) so a periodic
 * checker can report instead of crash.
 */
function revalidateGateArtifact(profile, root, options = {}) {
  const resolvedRoot = path.resolve(root || options.root || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const spec = profileSpec(profile, resolvedRoot, home);
  if (!installed(spec, profile)) {
    return { profile, target: spec.target, installed: false, live: false, reason: 'gate_not_installed' };
  }
  try {
    const sentinel = selfValidate(profile, resolvedRoot, spec);
    return { profile, target: spec.target, installed: true, ...sentinel };
  } catch (error) {
    return {
      profile,
      target: spec.target,
      installed: true,
      live: false,
      reason: 'revalidation_failed',
      error: String((error && error.message) || error),
    };
  }
}

function manageGate(command, options = {}) {
  if (!options.deploymentAuthorized) fail('gate management requires deployment authority');
  const root = path.resolve(options.root || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const profiles = options.profile ? [options.profile] : PROFILES;
  if (command === 'status') {
    return {
      command,
      clients: profiles.map(profile => {
        const spec = profileSpec(profile, root, home);
        const client = { profile, installed: installed(spec, profile), target: spec.target, hostTrust: hostTrust(profile, root, spec, false) };
        // Opt-in runtime re-evaluation (#1890): status stays cheap by
        // default, and only drives the live sentinel when asked.
        if (options.revalidate === true) client.revalidation = revalidateGateArtifact(profile, root, { home });
        return client;
      }),
      lastReceipt: lastReceipt(options.receiptPath || defaultExternalActionReceiptPath()),
    };
  }
  if (profiles.length !== 1) fail(`${command} requires --profile`);
  const profile = profiles[0];
  const spec = profileSpec(profile, root, home);
  if (command === 'install') {
    assertDependencyResolvable(spec, root);
    // An artifact has to exist before it can be loaded, so validation happens
    // after the write -- and a write this call made is undone when validation
    // fails, so a refused install still leaves nothing behind. An artifact that
    // was already there is left alone: removing someone else's working gate
    // because our sentinel was unhappy would be the worse failure.
    const preexisting = installed(spec, profile);
    if (spec.kind === 'json-hook') installJsonHook(spec, profile, pickGateCommand(profile, root));
    else if (spec.kind === 'file') installFile(spec);
    else installDirectory(spec, pickGateCommand(profile, root));
    let sentinel;
    try {
      sentinel = selfValidate(profile, root, spec);
    } catch (error) {
      if (!preexisting && spec.kind === 'file') fs.rmSync(spec.target, { force: true });
      if (!preexisting && spec.kind === 'json-hook') uninstallJsonHook(spec, profile);
      if (!preexisting && spec.kind === 'directory') uninstallDirectory(spec);
      throw error;
    }
    return { command, profile, target: spec.target, installed: true, sentinel, hostTrust: hostTrust(profile, root, spec, !preexisting) };
  }
  if (command === 'uninstall') {
    const removed = spec.kind === 'json-hook' ? uninstallJsonHook(spec, profile) : spec.kind === 'file' ? uninstallFile(spec) : uninstallDirectory(spec);
    return { command, profile, target: spec.target, removed };
  }
  fail(`unsupported gate command: ${command}`);
}

module.exports = Object.freeze({ PROFILES, manageGate, revalidateGateArtifact });
