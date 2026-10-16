'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const ADAPTER = path.join(__dirname, '..', 'adapters', 'external-action', 'hermes');

const CANDIDATES = process.platform === 'win32'
  ? [{ file: 'py', args: ['-3'] }, { file: 'python', args: [] }]
  : [{ file: 'python3', args: [] }, { file: 'python', args: [] }];

function python(script, args) {
  for (const candidate of CANDIDATES) {
    const run = spawnSync(candidate.file, [...candidate.args, '-c', script, ...args], {
      encoding: 'utf8', timeout: 60000,
    });
    if (!run.error) return run;
  }
  return null;
}

// Calls guard_tool_call the way Hermes does: load the plugin by path, hand it
// a tool call, print the decision.
const CALL = [
  'import importlib.util, json, sys',
  'plugin_dir = sys.argv[1]',
  'spec = importlib.util.spec_from_file_location("huqan_hermes_guard", plugin_dir + "/__init__.py")',
  'module = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  'print(json.dumps(module.guard_tool_call("shell", {"command": "rm -rf /"}, "task-1")))',
].join('; ');

/**
 * Runs the adapter from a throwaway copy, so a gate config written for one
 * case cannot leak into another.
 *
 * A fake gate is written as a script file rather than passed inline with
 * `node -e`, because the adapter appends `--profile hermes` and node rejects
 * that as one of its own options -- which is itself evidence the adapter
 * passes the profile through.
 */
function guardIn(t, { config, gate } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-hermes-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'hermes');
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(ADAPTER, '__init__.py'), path.join(dir, '__init__.py'));

  let gateConfig = config;
  if (gate !== undefined) {
    const script = path.join(base, 'gate.js');
    fs.writeFileSync(script, `${gate}\n`);
    gateConfig = JSON.stringify({ argv: [process.execPath, script] });
  }
  if (gateConfig !== undefined) fs.writeFileSync(path.join(dir, 'huqan-gate.json'), gateConfig);

  const run = python(CALL, [dir.replace(/\\/g, '/')]);
  assert.ok(run, 'no Python interpreter answered');
  assert.equal(run.status, 0, `the adapter itself must not crash: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

function requirePython(t) {
  const probe = python('print(1)', []);
  if (probe && probe.status === 0) return true;
  t.diagnostic('skipped: no Python interpreter on this host');
  return false;
}

test('a gate that exits non-zero blocks, and says with what code and message', t => {
  if (!requirePython(t)) return;
  const decision = guardIn(t, {
    gate: 'console.error("Error: gate exploded on purpose"); process.exit(3);',
  });

  assert.equal(decision.action, 'block', 'a guard that cannot decide must still block');
  assert.match(decision.message, /blocked fail-closed/);
  assert.match(decision.message, /exit 3/, 'the exit code is the first thing a maintainer needs');
  assert.match(decision.message, /gate exploded on purpose/, 'the child said why; that must survive');
});

test('the reported line is the one naming the error, not an internal stack frame', t => {
  if (!requirePython(t)) return;
  const decision = guardIn(t, {
    gate: [
      'console.error("    at Module._compile (node:internal/modules/cjs/loader:1)");',
      'console.error("Error: config root is unreadable");',
      'console.error("    at node:internal/main/run_main_module:23");',
      'process.exit(1);',
    ].join('\n'),
  });

  assert.match(decision.message, /config root is unreadable/);
  assert.doesNotMatch(decision.message, /run_main_module/, 'an internal frame explains nothing');
});

test('the diagnostic is bounded and drops secret-shaped runs', t => {
  if (!requirePython(t)) return;
  const decision = guardIn(t, {
    gate: [
      'console.error("Error: refused token=sk-livesecretvalue0123456789abcdefghij for " + "x".repeat(400));',
      'process.exit(1);',
    ].join('\n'),
  });

  assert.match(decision.message, /blocked fail-closed/);
  assert.doesNotMatch(decision.message, /sk-livesecretvalue/, 'a token-shaped run must not reach a receipt');
  assert.ok(decision.message.length < 320, `the message must stay bounded, got ${decision.message.length}`);
});

test('a gate that cannot be started blocks and names the failure kind', t => {
  if (!requirePython(t)) return;
  const decision = guardIn(t, {
    config: JSON.stringify({ argv: ['huqan-gate-that-does-not-exist-anywhere', '--serve'] }),
  });

  assert.equal(decision.action, 'block');
  assert.match(decision.message, /blocked fail-closed/);
  assert.match(
    decision.message,
    /FileNotFoundError|NotADirectoryError|OSError|exit /,
    'the exception kind is the diagnosis',
  );
});

test('a missing or unusable gate config says which, instead of four generic words', t => {
  if (!requirePython(t)) return;

  const absent = guardIn(t);
  assert.equal(absent.action, 'block');
  assert.match(absent.message, /HUQAN guard unavailable; blocked fail-closed/);
  assert.match(absent.message, /FileNotFoundError|No such file|cannot find/i);

  const malformed = guardIn(t, { config: '{ not json' });
  assert.equal(malformed.action, 'block');
  assert.match(malformed.message, /not valid JSON/);

  const empty = guardIn(t, { config: JSON.stringify({ argv: [] }) });
  assert.equal(empty.action, 'block');
  assert.match(empty.message, /no usable argv/);

  const wrongShape = guardIn(t, { config: JSON.stringify(['not', 'an', 'object']) });
  assert.equal(wrongShape.action, 'block');
  assert.match(wrongShape.message, /does not hold an object/);
});

test('unreadable gate output blocks and is reported as unreadable, not as a decision', t => {
  if (!requirePython(t)) return;
  const decision = guardIn(t, { gate: 'process.stdout.write("this is not json");' });

  assert.equal(decision.action, 'block');
  assert.match(decision.message, /unreadable output/);
});

test('a decision of the wrong shape names the action without echoing the payload', t => {
  if (!requirePython(t)) return;
  const decision = guardIn(t, {
    gate: 'process.stdout.write(JSON.stringify({ action: "maybe", args: { command: "secret-argument-value" } }));',
  });

  assert.equal(decision.action, 'block');
  assert.match(decision.message, /invalid decision/);
  assert.match(decision.message, /action=/);
  assert.doesNotMatch(decision.message, /secret-argument-value/, 'tool arguments must not ride along');
});

test('an allow stays an allow, and an explicit block keeps the reason the gate gave', t => {
  if (!requirePython(t)) return;

  const allowed = guardIn(t, { gate: 'process.stdout.write("{}");' });
  assert.equal(allowed, null, 'an empty decision means allow');

  const passed = guardIn(t, {
    gate: 'process.stdout.write(JSON.stringify({ action: "block", message: "DENYLISTED_COMMAND_BLOCKED" }));',
  });
  assert.equal(passed.action, 'block');
  assert.equal(
    passed.message,
    'DENYLISTED_COMMAND_BLOCKED',
    'the gate owns its own reason; the adapter must not rewrite it',
  );
});
