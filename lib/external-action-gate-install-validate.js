'use strict';
// #2145: install-time self-validation. Each profile is driven through the
// surface its host really uses, and an artifact that blocks without leaving a
// receipt counts as a failed install.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fail } = require('./external-action-gate-install-spec');
const { installedHookCommand } = require('./external-action-gate-install-hooks');
const {
  SENTINEL_TIMEOUT_MS, sentinelPayload, wrote, withSentinelScratch, exerciseCommand, evaluatorExpectation,
} = require('./external-action-gate-install-sentinel');
const SENTINEL_RUNNER = path.resolve(__dirname, 'external-action-gate-sentinel.js');

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

module.exports = Object.freeze({ assertDependencyResolvable, selfValidate });
