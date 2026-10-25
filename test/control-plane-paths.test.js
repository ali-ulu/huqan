'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CONTROL_PLANE_PATH_RULES,
  isControlPlanePath,
  findControlPlaneCommandTarget,
  findOperatorDecisionCommand,
} = require('../lib/control-plane-paths');

test('recognizes the guard control plane of every shipped adapter profile', () => {
  const cases = [
    ['.claude/settings.json', 'claude-code'],
    ['.claude/settings.local.json', 'claude-code'],
    ['.claude/hooks/huqan-gate.sh', 'claude-code'],
    ['.codex/hooks.json', 'codex'],
    ['.openhands/hooks.json', 'openhands'],
    ['.openhands/hooks/huqan-gate.sh', 'openhands'],
    ['.opencode/plugin/huqan.mjs', 'opencode'],
    ['.pi/extensions/huqan.js', 'pi'],
    ['.hermes/plugins/huqan-external-action-guard/plugin.json', 'hermes'],
    ['adapters/external-action/claude-code-hooks.json', 'huqan'],
  ];
  for (const [candidate, profile] of cases) {
    const match = isControlPlanePath(candidate);
    assert.ok(match, `expected ${candidate} to be control plane`);
    assert.equal(match.profile, profile);
  }
});

test('matches regardless of path separator, absolute prefix or case on the marker', () => {
  const variants = [
    'C:\\Users\\a\\proj\\.claude\\settings.json',
    '/home/a/proj/.claude/settings.json',
    './.claude/settings.json',
    'proj/.claude//settings.json',
  ];
  for (const candidate of variants) {
    assert.ok(isControlPlanePath(candidate), `expected ${candidate} to be control plane`);
  }
});

test('matches equivalent paths that carry a dot segment (#4252)', () => {
  const variants = [
    '.claude/./settings.json',
    '.claude/settings.json/./',
    './.claude/./settings.json',
    '.claude//./settings.json',
    'proj/.claude/./settings.json',
    '/home/a/proj/.claude/./settings.json',
    '.codex/./hooks.json',
    '.opencode/./plugin/huqan.mjs',
    'adapters/external-action/./claude-code-hooks.json',
  ];
  for (const candidate of variants) {
    const match = isControlPlanePath(candidate);
    assert.ok(match, `expected ${candidate} to be control plane`);
    // The normalized path must be free of dot segments and match the
    // canonical form, so an equivalent path cannot dodge the guard.
    assert.equal(match.path, path.posix.normalize(match.path), candidate);
    assert.ok(!/\.\//.test(match.path), `${candidate} normalized to ${match.path}`);
  }
});

test('a dot segment cannot disarm the control plane by review-dodging (#4252)', () => {
  const dodges = [
    'rm .claude/./settings.json',
    "sed -i 's/huqan-gate//' .claude/./settings.json",
    'echo "{}" > .claude/./settings.json',
    'mv .codex/./hooks.json /tmp/backup.json',
    'cp /tmp/clean.json .opencode/./plugin/huqan.mjs',
  ];
  for (const command of dodges) {
    const match = findControlPlaneCommandTarget(command);
    assert.ok(match, `expected ${command} to be flagged`);
    assert.ok(!command.includes('./.') || match, command);
  }
});

test('does not treat ordinary workspace files as control plane', () => {
  const benign = [
    'lib/external-action-guard.js',
    'src/settings.json',
    'docs/claude/settings.json.md',
    '.claude/README.md',
    'test/fixtures/opencode/plugin-notes.txt',
    '',
    null,
  ];
  for (const candidate of benign) {
    assert.equal(isControlPlanePath(candidate), null, `expected ${candidate} to be ordinary`);
  }
});

test('flags shell commands that mutate the control plane', () => {
  const mutations = [
    'rm .claude/settings.json',
    'rm -f ~/.claude/settings.json',
    "sed -i 's/huqan-gate//' .claude/settings.json",
    'mv .codex/hooks.json /tmp/backup.json',
    'echo "{}" > .claude/settings.json',
    'truncate -s 0 .pi/extensions/huqan.js',
    'cp /tmp/clean.json .opencode/plugin/huqan.mjs',
  ];
  for (const command of mutations) {
    const match = findControlPlaneCommandTarget(command);
    assert.ok(match, `expected ${command} to be flagged`);
  }
});

test('leaves read-only inspection of the control plane alone', () => {
  const reads = [
    'cat .claude/settings.json',
    'grep huqan-gate .claude/settings.json',
    'ls -la .claude',
    'git diff .claude/settings.json',
    'rm build/artifacts.json',
  ];
  for (const command of reads) {
    assert.equal(findControlPlaneCommandTarget(command), null, `expected ${command} to pass`);
  }
});

test('#4249 flags a target hidden behind wrappers, chains and a newline', () => {
  const wrapped = [
    // Wrapper commands that prefix the real verb.
    'sudo rm .claude/settings.json',
    'doas rm .claude/settings.json',
    'command rm .claude/settings.json',
    'nohup rm .claude/settings.json',
    'nice rm .claude/settings.json',
    'ionice rm .claude/settings.json',
    'time rm .claude/settings.json',
    'env FOO=1 rm .claude/settings.json',
    'env -u NAME rm .claude/settings.json',
    'xargs rm .claude/settings.json',
    'xargs -0 rm .claude/settings.json',
    'sudo -u root rm .claude/settings.json',
    'nice -n 5 rm .claude/settings.json',
    // A script a launcher is told to run.
    'bash -c "rm .claude/settings.json"',
    'sh -c "echo {} > .claude/settings.json"',
    'bash -lc "mv .codex/hooks.json /tmp/x"',
    'eval "rm .claude/settings.json"',
    'cmd /c "del .claude\\settings.json"',
    'powershell -Command "Remove-Item .claude\\settings.json"',
    // A command substitution.
    'echo $(rm .claude/settings.json)',
    'echo `rm .claude/settings.json`',
    // Chains: `;`, `&&`, `|` and a newline each start a new command.
    'echo hi; rm .claude/settings.json',
    'true && rm .claude/settings.json',
    'cat x | tee .claude/settings.json',
    'cd repo && rm .claude/settings.json',
    'echo start\nrm .claude/settings.json',
    'true; sudo bash -c "rm .claude/settings.json"',
  ];
  for (const command of wrapped) {
    assert.ok(findControlPlaneCommandTarget(command), `expected ${command} to be flagged`);
  }
});

test('#4249 still leaves reads and quoted text alone', () => {
  const benign = [
    'cat .claude/settings.json',
    'grep -n huqan-gate .claude/settings.json',
    'git diff .claude/settings.json',
    'bash -c "cat .claude/settings.json"',
    'xargs echo .claude/settings.json',
    'cat .claude/settings.json && echo done',
    'echo hi\ncat .claude/settings.json',
    // Separators inside quotes are text, not commands.
    'echo "a; rm .claude/settings.json"',
    "echo 'example | rm .claude/settings.json'",
    'git commit -m "docs: rm .claude/settings.json"',
  ];
  for (const command of benign) {
    assert.equal(findControlPlaneCommandTarget(command), null, `expected ${command} to pass`);
  }
});

test('every rule carries the profile it protects', () => {
  for (const rule of CONTROL_PLANE_PATH_RULES) {
    assert.ok(rule.profile, 'rule is missing a profile');
    assert.ok(rule.pattern instanceof RegExp, 'rule is missing a pattern');
  }
});

// ── guard integration ───────────────────────────────────────────────────────
//
// The unit tests above prove the rules recognize the right files. These prove
// the guard acts on them: that disarming the wiring is a `block`, not one more
// `review` an operator can wave through by habit, and that ordinary work in the
// same workspace is untouched.

const { evaluateExternalAction } = require('../lib/external-action-guard');

const workspaceRoot = path.resolve(__dirname, '..');

function memoryWriter() {
  const receipts = [];
  return { receipts, append(receipt) { receipts.push(receipt); } };
}

function evaluate(overrides, options = {}) {
  return evaluateExternalAction({
    invocationId: 'cp-1',
    agentName: 'kacak-agent',
    sessionId: 'cp-session',
    cwd: workspaceRoot,
    workspaceRoot,
    ...overrides,
  }, { receiptWriter: memoryWriter(), requireIdentityCard: false, ...options });
}

test('blocks writing the hook config that decides whether the guard runs', () => {
  const result = evaluate({
    toolName: 'Write',
    args: { file_path: path.join(workspaceRoot, '.claude', 'settings.json'), content: '{}' },
  });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_control_plane_blocked');
  assert.equal(result.canExecute, false);
});

test('blocks shell commands that delete or rewrite the hook config', () => {
  for (const command of ['rm .claude/settings.json', "sed -i 's/huqan-gate//' .claude/settings.json"]) {
    const result = evaluate({ toolName: 'Bash', args: { command } });
    assert.equal(result.decision, 'block', command);
    assert.equal(result.reason, 'external_action_control_plane_blocked', command);
  }
});

test('records which profile the control plane belonged to', () => {
  const result = evaluate({
    toolName: 'Write',
    args: { file_path: path.join(workspaceRoot, '.opencode', 'plugin', 'huqan.mjs'), content: 'x' },
  });
  const finding = result.findings.find(entry => entry.gate === 'control-plane');
  assert.ok(finding, 'expected a control-plane finding');
  assert.equal(finding.profile, 'opencode');
});

test('reading the hook config is left alone', () => {
  const result = evaluate({ toolName: 'Bash', args: { command: 'cat .claude/settings.json' } });
  assert.notEqual(result.reason, 'external_action_control_plane_blocked');
});

test('ordinary workspace writes keep their previous decision', () => {
  const result = evaluate({
    toolName: 'Write',
    args: { file_path: path.join(workspaceRoot, 'lib', 'scratch.js'), content: 'x' },
  });
  assert.notEqual(result.decision, 'block');
});

test('allowControlPlane comes from deployment options, never from the payload', () => {
  const args = { file_path: path.join(workspaceRoot, '.claude', 'settings.json'), content: '{}' };

  // An agent asking for the exemption inside its own invocation changes nothing.
  const selfGranted = evaluate({ toolName: 'Write', args, allowControlPlane: true });
  assert.equal(selfGranted.decision, 'block');

  // The deployment that installed the hook can still do maintenance.
  const maintenance = evaluate({ toolName: 'Write', args }, { allowControlPlane: true });
  assert.notEqual(maintenance.reason, 'external_action_control_plane_blocked');
});

test('#3560 recognizes HUQAN CLI invocations that record an operator decision', () => {
  const decisions = [
    ['huqan terfi --aday a.json --karar approved', 'terfi'],
    ['npx huqan --json onayla apr_1 approved', 'onayla'],
    ['node cli.js approve apr_1', 'approve'],
    ['node ./cli.js terfi --aday a', 'terfi'],
    ['C:\\tools\\huqan.cmd terfi', 'terfi'],
    ['cd repo && huqan TERFI --aday a', 'terfi'],
    ['"huqan" "onayla" apr_1', 'onayla'],
    ['bash -c "huqan terfi --karar approved"', 'terfi'],
    ['cmd /c huqan onayla apr_1', 'onayla'],
    ['env A=1 huqan terfi', 'terfi'],
    ['npm exec -- huqan onayla apr_1', 'onayla'],
    ['npm x huqan onayla apr_1', 'onayla'],
    ['pnpm dlx huqan terfi', 'terfi'],
    ['echo $(huqan terfi)', 'terfi'],
    ['echo `huqan onayla apr_1`', 'onayla'],
  ];
  for (const [command, verb] of decisions) {
    const match = findOperatorDecisionCommand(command);
    assert.ok(match, `expected ${command} to be an operator decision`);
    assert.equal(match.command, verb, command);
  }
});

test('#3560 leaves reads and non-decision HUQAN commands alone', () => {
  const benign = [
    'huqan onaylar',
    'huqan ask terfi nedir',
    'huqan',
    'grep -rn terfi lib/cli-promote.js',
    'cat cli.js',
    'huqanx terfi',
    'echo huqan',
    'echo huqan terfi',
    'git commit -m "huqan terfi"',
    'node script.js huqan terfi',
    'npm run huqan terfi',
    'huqan ask "$(cat question.txt)"',
    '',
  ];
  for (const command of benign) {
    assert.equal(findOperatorDecisionCommand(command), null, `expected ${command} to be ordinary`);
  }
});

test('#3560 reads the verb the shell would run, after its quotes and escapes are removed', () => {
  const obfuscated = [
    ['huqan on""ayla apr_1 approved', 'onayla'],
    ["huqan 'te'rfi --karar approved", 'terfi'],
    ['huqan te\\rfi', 'terfi'],
    ['hu""qan onayla apr_1', 'onayla'],
  ];
  for (const [command, verb] of obfuscated) {
    assert.equal(findOperatorDecisionCommand(command)?.command, verb, command);
  }
});

test('#3560 feeding the REPL through a pipe, a redirect or a heredoc is refused', () => {
  const fed = [
    'echo "onayla apr_1" | huqan',
    'printf "terfi\\n" | npx huqan --json',
    'huqan < commands.txt',
    'huqan<commands.txt',
    'huqan 0< commands.txt',
    'huqan <<EOF',
    'huqan <<< "onayla apr_1"',
  ];
  for (const command of fed) {
    assert.equal(findOperatorDecisionCommand(command)?.command, 'repl-stdin', command);
  }
  const ordinary = [
    'cat question.txt | huqan ask soru',
    'huqan ask soru > out.txt 2>&1',
    'huqan onaylar > list.txt',
    'huqan || echo failed',
    'echo huqan | grep huq',
  ];
  for (const command of ordinary) {
    assert.equal(findOperatorDecisionCommand(command), null, command);
  }
  assert.equal(findOperatorDecisionCommand('huqan onayla apr_1 > out.txt')?.command, 'onayla');
  // A redirect before the subcommand is not argv: the shell still runs `onayla`.
  assert.equal(findOperatorDecisionCommand('huqan > out.txt onayla apr_1')?.command, 'onayla');
  assert.equal(findOperatorDecisionCommand('huqan 2>err.log terfi --aday a')?.command, 'terfi');
  // The `&` of an fd duplication is part of the redirect, not a separator.
  assert.equal(findOperatorDecisionCommand('huqan 2>&1 onayla apr_1')?.command, 'onayla');
  assert.equal(findOperatorDecisionCommand('huqan >&2 terfi --aday a')?.command, 'terfi');
  assert.equal(findOperatorDecisionCommand('huqan &>log.txt onayla apr_1')?.command, 'onayla');
  // A spaced `>&` takes the next word as its target, not as the subcommand.
  assert.equal(findOperatorDecisionCommand('huqan >& log.txt onayla apr_1')?.command, 'onayla');
  assert.equal(findOperatorDecisionCommand('huqan 2>& 1 terfi --aday a')?.command, 'terfi');
  assert.equal(findOperatorDecisionCommand('huqan 2>&1 < commands.txt')?.command, 'repl-stdin');
  assert.equal(findOperatorDecisionCommand('echo "onayla x" |& huqan')?.command, 'repl-stdin');
  assert.equal(findOperatorDecisionCommand('cd repo; huqan onayla apr_1')?.command, 'onayla');
  assert.equal(findOperatorDecisionCommand('echo start\nhuqan terfi --aday a')?.command, 'terfi');
  // Real list separators still split: a background job, then another command.
  assert.equal(findOperatorDecisionCommand('sleep 1 & huqan onayla apr_1')?.command, 'onayla');
  assert.equal(findOperatorDecisionCommand('huqan ask soru 2>&1 && echo done'), null);
});

test('#3560 quoted text stays one word, but a script a shell is told to run is read', () => {
  // Quoted separators are text, not a pipeline or a list.
  for (const command of [
    "echo 'example | huqan'",
    'echo "a; huqan onayla apr_1"',
    'git commit -m "docs: run huqan terfi | huqan"',
    'printf "%s\\n" "x | huqan"',
    // An escaped quote does not close the string around it.
    'echo "say \\" | huqan"',
    // The script's own escaped quotes are undone before it is read.
    'bash -c "echo \\"a ; huqan onayla apr_1\\""',
  ]) {
    assert.equal(findOperatorDecisionCommand(command), null, command);
  }
  // A shell, cmd, PowerShell or eval running a script runs its commands.
  const scripts = [
    ['bash -c "cd repo; huqan terfi --aday a"', 'terfi'],
    ["sh -c 'echo onayla apr_1 | huqan'", 'repl-stdin'],
    ['bash -lc "huqan onayla apr_1"', 'onayla'],
    ['cmd /c "huqan onayla apr_1"', 'onayla'],
    ['powershell -Command "huqan onayla apr_1"', 'onayla'],
    ['eval "huqan onayla apr_1"', 'onayla'],
    ['bash -c "sh -c \\"huqan terfi\\""', 'terfi'],
  ];
  for (const [command, verb] of scripts) {
    assert.equal(findOperatorDecisionCommand(command)?.command, verb, command);
  }
});

test('#3560 a stdin taken from another file descriptor still feeds the REPL', () => {
  for (const command of ['huqan <&3', 'huqan 0<&3', 'huqan <>commands.txt']) {
    assert.equal(findOperatorDecisionCommand(command)?.command, 'repl-stdin', command);
  }
});

test('#3560 a subcommand the shell would still expand is a decision: fail-closed', () => {
  for (const command of ['huqan $(echo terfi)', 'huqan $VERB --aday a', 'huqan `printf onayla` apr_1']) {
    assert.equal(findOperatorDecisionCommand(command)?.command, 'unresolved', command);
  }
});

test('#3560 an agent shell running an operator decision is blocked, and no deployment option lifts it', () => {
  for (const command of ['huqan terfi --aday a.json --karar approved', 'npx huqan onayla apr_1', 'huqan on""ayla apr_1 approved', 'echo "onayla apr_1" | huqan']) {
    const result = evaluate({ toolName: 'Bash', args: { command } });
    assert.equal(result.decision, 'block', command);
    assert.equal(result.reason, 'external_action_operator_decision_blocked', command);
    assert.equal(result.canExecute, false);
    const maintenance = evaluate({ toolName: 'Bash', args: { command } }, { allowControlPlane: true });
    assert.equal(maintenance.reason, 'external_action_operator_decision_blocked', `${command} under allowControlPlane`);
  }
  for (const command of ['huqan onaylar', 'echo huqan terfi']) {
    const result = evaluate({ toolName: 'Bash', args: { command } });
    assert.notEqual(result.reason, 'external_action_operator_decision_blocked', command);
  }
});

// ── #4226 (CWE-59): a symlink alias inside the workspace ─────────────────────
//
// Containment cannot see this one: the alias lives inside the workspace and
// resolves to a control-plane file that also lives inside it, so
// resolvePathWithinRoot admits the path and the lexical rules see an ordinary
// name. The decision has to be made on the real spelling.

test('#4226 a command writing through an alias is judged on the real spelling', () => {
  const resolvePath = (candidate) => (candidate === 'notes.md' ? '/ws/.claude/settings.json' : `/ws/${candidate}`);
  const match = findControlPlaneCommandTarget('echo "{}" > notes.md', 0, { resolvePath });
  assert.ok(match, 'expected the redirect target to be flagged');
  assert.equal(match.profile, 'claude-code');
  assert.equal(match.path, '/ws/.claude/settings.json');
});

test('#4226 a write-through command fails closed on an unresolvable target', () => {
  // A resolver returns null only when it cannot resolve the word at all -- the
  // guard's canonicalizePath wrapper maps every resolution failure to null.
  const unresolvable = (candidate) => (candidate === 'notes.md' ? null : `/ws/${candidate}`);
  // A write through a link whose target does not exist yet would create it.
  assert.deepEqual(findControlPlaneCommandTarget('tee notes.md', 0, { resolvePath: unresolvable }), {
    profile: 'unresolved-path',
    path: 'notes.md',
  });
  assert.deepEqual(findControlPlaneCommandTarget("sed -i 's/x/y/' notes.md", 0, { resolvePath: unresolvable }), {
    profile: 'unresolved-path',
    path: 'notes.md',
  });
  // rm and mv act on the link itself, not the file it names.
  assert.equal(findControlPlaneCommandTarget('rm notes.md', 0, { resolvePath: unresolvable }), null);
  assert.equal(findControlPlaneCommandTarget('mv notes.md /tmp/x', 0, { resolvePath: unresolvable }), null);
  // Without a resolver the module stays purely lexical (no filesystem access).
  assert.equal(findControlPlaneCommandTarget('echo "{}" > notes.md'), null);
});

// A real workspace whose .claude/settings.json is reachable under an innocent
// alias. Directory links are junctions so the fixture works on Windows without
// elevation; the single-file alias test below skips where the platform refuses
// those.
function symlinkedControlPlaneWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-alias-'));
  const claudeDir = path.join(base, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"hooks":{}}', 'utf8');
  fs.writeFileSync(path.join(base, 'notes.md'), '# notes\n', 'utf8');

  const fileAlias = path.join(base, 'notes-link.md');
  if (fileSymlinksWork) fs.symlinkSync(path.join(claudeDir, 'settings.json'), fileAlias, 'file');
  const dirAlias = path.join(base, 'claude-dir');
  fs.symlinkSync(claudeDir, dirAlias, 'junction');

  // A link whose target is gone: a write through it would create the file.
  const goneDir = path.join(base, 'gone');
  fs.mkdirSync(goneDir);
  const danglingAlias = path.join(base, 'later-dir');
  fs.symlinkSync(goneDir, danglingAlias, 'junction');
  fs.rmdirSync(goneDir);

  return {
    base,
    fileAlias,
    dirAliasSettings: path.join(dirAlias, 'settings.json'),
    danglingAliasTarget: path.join(danglingAlias, 'settings.json'),
    cleanup() {
      // The links first, so the recursive delete cannot walk them.
      for (const link of [fileAlias, dirAlias, danglingAlias]) {
        try { fs.rmSync(link, { recursive: true, force: true }); } catch (_) { /* best effort */ }
      }
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function evaluateIn(root, overrides, options = {}) {
  return evaluate({ cwd: root, workspaceRoot: root, ...overrides }, options);
}

const fileSymlinksWork = (() => {
  try {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-probe-'));
    const target = path.join(probe, 'settings.json');
    fs.writeFileSync(target, '{}', 'utf8');
    const link = path.join(probe, 'alias.json');
    fs.symlinkSync(target, link, 'file');
    const follows = fs.statSync(link).isFile();
    fs.rmSync(probe, { recursive: true, force: true });
    return follows;
  } catch (_) {
    return false;
  }
})();

test('#4226 writing a control-plane file through a symlink alias is blocked', { skip: fileSymlinksWork ? false : 'this platform cannot create file symlinks' }, (t) => {
  const ws = symlinkedControlPlaneWorkspace();
  t.after(ws.cleanup);

  // The lexical spelling is an ordinary name; the real spelling is the guard's
  // own wiring.
  const result = evaluateIn(ws.base, {
    toolName: 'Write',
    args: { file_path: ws.fileAlias, content: '{"hooks":{}}' },
  });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_control_plane_blocked');
  const finding = result.findings.find(entry => entry.gate === 'control-plane');
  assert.equal(finding.profile, 'claude-code');
});

test('#4226 writing a control-plane file through a linked directory is blocked', (t) => {
  const ws = symlinkedControlPlaneWorkspace();
  t.after(ws.cleanup);

  const result = evaluateIn(ws.base, {
    toolName: 'Write',
    args: { file_path: ws.dirAliasSettings, content: '{"hooks":{}}' },
  });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_control_plane_blocked');
});

test('#4226 shell commands writing through an alias are blocked', { skip: fileSymlinksWork ? false : 'this platform cannot create file symlinks' }, (t) => {
  const ws = symlinkedControlPlaneWorkspace();
  t.after(ws.cleanup);

  for (const command of [
    'echo "{\\"hooks\\":{}}" > notes-link.md',
    'tee notes-link.md',
    "sed -i 's/huqan-gate//' notes-link.md",
    'cp /tmp/clean.json notes-link.md',
    'echo "{}" > claude-dir/settings.json',
  ]) {
    const result = evaluateIn(ws.base, { toolName: 'Bash', args: { command } });
    assert.equal(result.decision, 'block', command);
    assert.equal(result.reason, 'external_action_control_plane_blocked', command);
  }
});

test('#4226 removing or moving the alias itself is not a control-plane write', { skip: fileSymlinksWork ? false : 'this platform cannot create file symlinks' }, (t) => {
  const ws = symlinkedControlPlaneWorkspace();
  t.after(ws.cleanup);

  for (const command of ['rm notes-link.md', 'mv notes-link.md /tmp/x', 'cat notes-link.md']) {
    const result = evaluateIn(ws.base, { toolName: 'Bash', args: { command } });
    assert.notEqual(result.reason, 'external_action_control_plane_blocked', command);
  }
});

test('#4226 a write through an unresolvable alias fails closed', (t) => {
  const ws = symlinkedControlPlaneWorkspace();
  t.after(ws.cleanup);

  const result = evaluateIn(ws.base, { toolName: 'Bash', args: { command: 'tee later-dir/settings.json' } });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_control_plane_blocked');
});

test('#4226 a write tool to an unresolvable alias is refused by path safety', (t) => {
  const ws = symlinkedControlPlaneWorkspace();
  t.after(ws.cleanup);

  // The write would create the target through the link. The path-safety gate
  // owns this refusal (#4222); the control-plane call defers to it rather than
  // claiming the finding.
  const result = evaluateIn(ws.base, {
    toolName: 'Write',
    args: { file_path: ws.danglingAliasTarget, content: '{}' },
  });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_path_outside_workspace');
});

test('#4226 an ordinary write in the same workspace keeps its decision', (t) => {
  const ws = symlinkedControlPlaneWorkspace();
  t.after(ws.cleanup);

  const result = evaluateIn(ws.base, {
    toolName: 'Write',
    args: { file_path: path.join(ws.base, 'notes.md'), content: '# edit\n' },
  });
  assert.notEqual(result.decision, 'block');
  assert.notEqual(result.reason, 'external_action_control_plane_blocked');
});
