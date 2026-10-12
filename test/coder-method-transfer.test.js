'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { resolveCandidate } = require('../lib/coder/learned-candidate');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { createCapabilityTrustRegistry } = require('../lib/experience/capability-trust');
const { replayCoderTrust } = require('../lib/experience/coder-trust-replay');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-method-transfer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text); };
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const buggy = 'module.exports = n => n + 1;\n';
  write('src/source.js', buggy);
  write('src/heldout.js', '// unseen target\n' + buggy);
  write('test/source.js', "const assert = require('node:assert/strict'); assert.equal(require('../src/source')(3), 6);\n");
  write('test/heldout.js', "const assert = require('node:assert/strict'); const f = require('../src/heldout'); assert.equal(f(5), 10); assert.equal(f(8), 16);\n");
  write('qualify/drift.md', 'no old expression');
  write('qualify/ambiguous.md', 'n + 1\nn + 1');
  write('.gitignore', '*.json\n*.db*\n.huqan/\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const commit = () => { git(['add', 'src', 'test', 'qualify', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); };
  git(['init', '-qb', 'feat/method-transfer']);
  commit();
  const flags = ['--root', root, '--journal', path.join(root, 'journal.db')];
  const cli = (args, expectedStatus = 0) => {
    const child = spawnSync(process.execPath,
    [path.resolve(__dirname, '..', 'cli.js'), 'coder', ...args, '--json'], {
      cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, expectedStatus, child.stdout + child.stderr);
    return JSON.parse(child.stdout);
  };
  const source = { id: 'source', level: 'l0', allowedPaths: ['src/source.js'],
    operation: { type: 'replace_text', path: 'src/source.js', find: 'n + 1', replace: 'n * 2' },
    qualificationPaths: ['qualify/drift.md', 'qualify/ambiguous.md'], test: { command: 'node test/source.js' } };
  write('source.json', JSON.stringify(source));
  assert.equal(cli(['source.json', ...flags, '--authorize', '--run-id', 'source']).status, 'completed');
  const candidate = '.huqan/coder/candidates/double.json';
  assert.equal(cli(['remember', 'source.json', ...flags, '--candidate-file', candidate,
    '--run-id', 'source:c1']).data.ok, true);
  commit();
  const intent = { id: 'heldout', level: 'l0', allowedPaths: ['src/heldout.js'],
    operation: { type: 'replace_text', path: 'src/heldout.js' }, test: { command: 'node test/heldout.js' } };
  write('intent.json', JSON.stringify(intent));
  return { root, cli, flags, candidate, intent, read, write, commit };
}

test('a restarted CLI transfers a sealed method to an unseen file only with explicit permission and independent tests', t => {
  const f = fixture(t);
  const original = f.read(f.candidate);
  const baseline = f.cli(['intent.json', ...f.flags, '--use-memory', '--authorize', '--run-id', 'baseline'], 6);
  assert.equal(baseline.data.ok, false, JSON.stringify(baseline));
  assert.equal(baseline.data.reason, 'no_applicable_candidate');
  assert.equal(f.read('src/heldout.js'), '// unseen target\nmodule.exports = n => n + 1;\n');
  const result = f.cli(['intent.json', ...f.flags, '--transfer-memory', '--authorize', '--run-id', 'transferred']);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.data.record.observedVerification.ok, true);
  assert.equal(result.data.attempts[0].test.ok, true);
  assert.equal(f.read('src/heldout.js'), '// unseen target\nmodule.exports = n => n * 2;\n');
  assert.equal(f.read('src/source.js'), 'module.exports = n => n * 2;\n');
  assert.equal(f.read(f.candidate), original);
  const store = openCoderJournal(path.join(f.root, 'journal.db'));
  try {
    const routed = store.journal.read('transferred:c1', { workspaceId: 'default' })
      .find(row => row.type === 'routing_decided').payload;
    assert.equal(routed.transfer.sourcePath, 'src/source.js');
    assert.equal(routed.transfer.targetPath, 'src/heldout.js');
    assert.equal(routed.transfer.sourceProcedureHash, JSON.parse(original).procedureHash);
    assert.notEqual(routed.boundProcedureVersion, routed.transfer.sourceProcedureHash);
    assert.equal(routed.execution.path, 'src/heldout.js');
  } finally { store.close(); }
});

test('parent success cannot promote a transferred capability before 25 target successes', t => {
  const f = fixture(t);
  const store = openCoderJournal(path.join(f.root, 'journal.db'));
  const original = f.read('src/heldout.js');
  try {
    const selected = resolveCandidate({ task: f.intent, journal: store.journal, root: f.root,
      file: f.candidate, workspaceId: 'default', allowTransfer: true });
    assert.equal(selected.ok, true);
    let routed;
    for (let index = 0; index < 25; index += 1) {
      f.write('src/heldout.js', original);
      const runId = `target-success-${index}`;
      const result = applyDerivation({ task: selected.task, root: f.root, journal: store.journal,
        runId, deferExperience: true, authorized: true,
        repoState: { branch: 'feat/method-transfer', dirty: false, hasUntracked: false },
        verify: () => { execFileSync(process.execPath, ['test/heldout.js'], { cwd: f.root }); return { ok: true }; } });
      assert.equal(result.ok, true, JSON.stringify(result));
      routed = store.journal.read(runId, { workspaceId: 'default' })
        .find(row => row.type === 'routing_decided').payload;
      if (index === 24) assert.notEqual(routed.candidatesConsidered[0].trustRung, 2);
      result.finalizeExperience({ test: { ok: true }, kept: true, rolledBack: false });
      const trust = createCapabilityTrustRegistry();
      assert.equal(replayCoderTrust({ journal: store.journal, workspaceId: 'default', requestId: 'next',
        capabilityId: routed.chosenCapabilityId, procedureHash: routed.boundProcedureVersion,
        trust, seededRunIds: [] }).ok, true);
      const entry = trust.get('default', routed.chosenCapabilityId);
      assert.equal(entry.evidenceWindow.positiveCount, index + 1);
      assert.equal(entry.evidenceWindow.totalCount, index + 1);
      assert.equal(entry.trustState === 'trusted', index === 24);
    }
  } finally { store.close(); }
});

test('a transferred method cannot execute through the untested single-derivation API', t => {
  const f = fixture(t);
  const store = openCoderJournal(path.join(f.root, 'journal.db'));
  try {
    const selected = resolveCandidate({ task: f.intent, journal: store.journal, root: f.root,
      file: f.candidate, workspaceId: 'default', allowTransfer: true });
    assert.equal(selected.ok, true, selected.reason);
    const result = applyDerivation({ task: selected.task, root: f.root, journal: store.journal,
      authorized: true, repoState: { branch: 'feat/method-transfer', dirty: false, hasUntracked: false } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'transfer_verification_required');
    assert.equal(f.read('src/heldout.js'), '// unseen target\nmodule.exports = n => n + 1;\n');
  } finally { store.close(); }
});

test('restarted production CLI adapts learned method identifiers without supplied method text', t => {
  const f = fixture(t);
  const original = f.read(f.candidate);
  f.write('src/heldout.js', '// unseen names\nmodule.exports = value => value + 1;\n');
  f.commit();
  const literal = f.cli(['intent.json', ...f.flags, '--transfer-memory', '--authorize', '--run-id', 'literal'], 6);
  assert.equal(literal.data.ok, false);
  const adapted = f.cli(['intent.json', ...f.flags, '--adapt-memory', '--authorize', '--run-id', 'adapted']);
  assert.equal(adapted.data.record?.observedVerification.ok, true, JSON.stringify(adapted));
  assert.equal(adapted.data.attempts[0].test.ok, true);
  assert.equal(f.read('src/heldout.js'), '// unseen names\nmodule.exports = value => (value * 2);\n');
  assert.equal(f.read(f.candidate), original);
  const store = openCoderJournal(path.join(f.root, 'journal.db'));
  try {
    const routed = store.journal.read('adapted:c1', { workspaceId: 'default' })
      .find(row => row.type === 'routing_decided').payload;
    assert.equal(routed.transfer.adapted, true);
    assert.equal(routed.transfer.sourceProcedureHash, JSON.parse(original).procedureHash);
    assert.notEqual(routed.boundProcedureVersion, routed.transfer.sourceProcedureHash);
  } finally { store.close(); }
});

test('a failed independent transfer test restores the unseen file and seals a negative experience', t => {
  const f = fixture(t);
  f.write('test/heldout.js', "require('node:assert/strict').equal(require('../src/heldout')(5), 999);\n");
  f.commit();
  const original = f.read('src/heldout.js');
  const result = f.cli(['intent.json', ...f.flags, '--transfer-memory', '--authorize', '--run-id', 'rollback'], 6);
  assert.equal(result.data.attempts[0].test.ok, false, JSON.stringify(result));
  assert.equal(result.data.attempts[0].rolledBack, true);
  assert.deepEqual(result.data.kept, []);
  assert.equal(f.read('src/heldout.js'), original);
  const store = openCoderJournal(path.join(f.root, 'journal.db'));
  try {
    const manifest = store.journal.manifest('rollback:c1');
    assert.equal(manifest.closed, true);
    assert.equal(manifest.learningEligibility, 'negative_example');
  } finally { store.close(); }
});

test('adaptation rechecks its bindings and rolls back a failed target verification', t => {
  const f = fixture(t);
  const original = 'module.exports = value => value + 1;\n';
  f.write('src/heldout.js', original);
  const store = openCoderJournal(path.join(f.root, 'journal.db'));
  try {
    const selected = resolveCandidate({ task: f.intent, journal: store.journal, root: f.root,
      file: f.candidate, workspaceId: 'default', allowTransfer: true, allowAdaptation: true });
    assert.equal(selected.ok, true);
    const forged = structuredClone(selected.task);
    forged.experience.candidates[0].params.newText = '(value * 999)';
    const options = { root: f.root, journal: store.journal, authorized: true, deferExperience: true,
      repoState: { branch: 'feat/method-transfer', dirty: false, hasUntracked: false }, verify: () => ({ ok: false }) };
    const rejected = applyDerivation({ ...options, task: forged, runId: 'forged-adaptation' });
    assert.equal(rejected.reason, 'adaptation_binding_mismatch');
    const failed = applyDerivation({ ...options, task: selected.task, runId: 'failed-adaptation' });
    assert.equal(failed.ok, false);
    assert.equal(failed.rolledBack, true);
    assert.equal(f.read('src/heldout.js'), original);
    assert.equal(store.journal.manifest('failed-adaptation').learningEligibility, 'negative_example');
  } finally { store.close(); }
});

test('transfer refuses missing tests, forged parent identity and absent source authorization', t => {
  const f = fixture(t);
  const original = f.read('src/heldout.js');
  const store = openCoderJournal(path.join(f.root, 'journal.db'));
  try {
    const options = { task: f.intent, root: f.root, file: f.candidate,
      journal: store.journal, workspaceId: 'default', allowTransfer: true };
    assert.equal(resolveCandidate({ ...options, task: { ...f.intent, test: undefined } }).reason,
      'transfer_verification_required');
    const selected = resolveCandidate(options);
    assert.equal(selected.ok, true);
    selected.task.experience.candidates[0].sourceProcedureHash = '0'.repeat(64);
    const result = require('../lib/coder/fix-loop').runFixLoop({ task: selected.task, root: f.root,
      journal: store.journal, authorized: true, repoState: { branch: 'feat/method-transfer', dirty: false, hasUntracked: false } });
    assert.equal(result.attempts[0].apply.reason, 'source_procedure_mismatch');
  } finally { store.close(); }
  const denied = f.cli(['intent.json', ...f.flags, '--transfer-memory', '--run-id', 'unauthorized'], 6);
  assert.equal(denied.data.attempts[0].apply.reason, 'GATE_REFUSED');
  assert.equal(f.read('src/heldout.js'), original);
});

test('direct API callers cannot leave a transferred patch after a failed or dishonest verification', t => {
  const f = fixture(t);
  const store = openCoderJournal(path.join(f.root, 'journal.db'));
  const original = f.read('src/heldout.js');
  try {
    for (const dishonest of [false, true]) {
      const selected = resolveCandidate({ task: f.intent, journal: store.journal, root: f.root,
        file: f.candidate, workspaceId: 'default', allowTransfer: true });
      assert.equal(selected.ok, true);
      const result = applyDerivation({ task: selected.task, root: f.root, journal: store.journal,
        runId: `direct-${dishonest}`, deferExperience: true, authorized: true,
        repoState: { branch: 'feat/method-transfer', dirty: false, hasUntracked: false },
        verify: () => { if (dishonest) f.write('src/heldout.js', 'changed by test'); return { ok: dishonest }; } });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'transfer_verification_failed');
      assert.equal(result.rolledBack, true);
      assert.equal(f.read('src/heldout.js'), original);
    }
  } finally { store.close(); }
});
