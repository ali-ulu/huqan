'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyDerivation } = require('../lib/coder/apply-derivation');
const { verifyDerivationHash } = require('../lib/coder/derivation-record');
const {
  MAX_CREATE_FILE_BYTES,
  PRODUCER_REASONS,
  PRODUCER_STATUSES,
  produceTask,
} = require('../lib/task-producer');

const CLEAN_BRANCH = { branch: 'feat/coder', dirty: false, hasUntracked: false };

function failure(overrides = {}) {
  return {
    kind: 'failure_record',
    schemaVersion: '1.0.0',
    failureId: 'failure-abc123',
    source: 'test_failure',
    verificationStatus: 'verified',
    trust: 'high',
    verificationReason: 'verified_by_authority',
    action: {
      tool: 'coder',
      operation: 'replace_text',
      workspaceId: 'default',
      repo: 'huqan',
      path: 'docs/notes.md',
      actionFingerprint: 'fp-1',
    },
    expected: 'version v1.1.0\n',
    observed: 'version v1.0.0\n',
    evidence: [],
    workspaceId: 'default',
    ...overrides,
  };
}

it('produces one atomic identifier rename across explicitly declared files', () => {
  const record = failure({ observed: 'oldName', expected: 'newName',
    action: { tool: 'coder', operation: 'rename_identifier', paths: ['src/export.js', 'src/use.js'] } });
  const result = produceTask(record);
  assert.equal(result.task.operation.type, 'sequence');
  assert.deepEqual(result.task.allowedPaths, record.action.paths);
  const { runTask } = require('../lib/deterministic-task-runner');
  const files = { 'src/export.js': 'const oldName = 1; // oldName\nmodule.exports = { oldName };',
    'src/use.js': 'const { oldName } = require("./export"); const text = "oldName"; console.log(oldName);' };
  const applied = runTask({ ...result.task, files });
  assert.equal(applied.status, 'COMPLETED');
  assert.equal(applied.patch.length, 2);
  assert.match(applied.files['src/export.js'], /const newName = 1; \/\/ oldName/);
  assert.match(applied.files['src/use.js'], /const text = "oldName"/);
  const incomplete = { ...files, 'src/use.js': 'module.exports = 1;' };
  const refused = runTask({ ...result.task, files: incomplete });
  assert.equal(refused.status, 'NEEDS_HUMAN_DECISION');
  assert.deepEqual(refused.files, incomplete);
  assert.equal(refused.patch.length, 0);
  for (const paths of [[], ['src/export.js'], ['src/export.js', 'src/export.js'], Array(2),
    ['src/export.js', '../escape.js']]) {
    assert.equal(produceTask({ ...record, action: { ...record.action, paths } }).task, null);
  }
});

it('executes a produced three-file rename through native CLI and rolls every file back on failed verification', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  for (const succeed of [true, false]) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-multi-rename-')));
    try {
      const originals = { 'src/export.js': 'const oldName = n => n * 2; // oldName\nmodule.exports = { oldName };\n',
        'src/first.js': 'const { oldName } = require("./export"); module.exports = oldName;\n',
        'src/second.js': 'const { oldName } = require("./export"); const label = "oldName"; module.exports = oldName;\n' };
      for (const [file, text] of Object.entries(originals)) write(root, file, text);
      write(root, 'test/verify.js', 'const assert = require("node:assert/strict");\n'
        + 'assert.equal(require("../src/first")(7), 14);\n'
        + `assert.equal(require("../src/second")(11), ${succeed ? 22 : 999});\n`
        + 'assert.equal(require("../src/export").newName(13), 26);\n');
      write(root, '.gitignore', '*.json\n*.db*\n.huqan/\n');
      const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
      git(['init', '-qb', 'codex/multi-rename-fixture']); git(['add', 'src', 'test', '.gitignore']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
      const record = failure({ observed: 'oldName', expected: 'newName',
        action: { tool: 'coder', operation: 'rename_identifier', paths: Object.keys(originals) } });
      const produced = produceTask(record);
      write(root, 'task.json', JSON.stringify({ ...produced.task, test: { command: 'node test/verify.js' } }));
      const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'task.json',
        '--authorize', '--root', root, '--journal', path.join(root, 'journal.db'), '--run-id', 'rename', '--json'],
      { cwd: root, encoding: 'utf8', timeout: 120000,
        env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') } });
      assert.ifError(child.error);
      assert.equal(child.status, succeed ? 0 : 6, child.stdout + child.stderr);
      const result = JSON.parse(child.stdout).data;
      assert.equal(result.attempts[0].test.ran, true);
      assert.equal(result.attempts[0].test.ok, succeed);
      const { openCoderJournal } = require('../lib/coder/journal-store');
      const { readSealedRun } = require('../lib/experience/learning-intake');
      const journal = openCoderJournal(path.join(root, 'journal.db'));
      try {
        const sealed = readSealedRun(journal.journal, 'rename:c1', 'default');
        assert.equal(sealed.ok, true, JSON.stringify(sealed));
        const proposal = sealed.events.find(event => event.type === 'action_proposed').payload;
        const hash = require('node:crypto').createHash('sha256')
          .update(JSON.stringify(produced.task.operation)).digest('hex');
        assert.equal(proposal.sequenceSha256, hash);
        assert.equal(proposal.sequenceSteps, 3);
        assert.equal(sealed.manifest.learningEligibility, succeed ? 'positive_procedure' : 'negative_example');
      } finally { journal.close(); }
      if (succeed) {
        const { rememberCandidate } = require('../lib/coder/learned-candidate');
        const store = openCoderJournal(path.join(root, 'journal.db'));
        try {
          const candidateFile = '.huqan/coder/candidates/multi.json';
          const remembered = rememberCandidate({ task: produced.task, journal: store.journal,
            runId: 'rename:c1', workspaceId: 'default', root, file: candidateFile,
            qualificationPaths: ['q-drift.json', 'q-ambiguous.json'] });
          assert.equal(remembered.ok, true, JSON.stringify(remembered));
          const bytes = fs.readFileSync(path.join(root, candidateFile), 'utf8');
          const candidate = JSON.parse(bytes);
          assert.equal(candidate.kind, 'rename_sequence');
          assert.equal(candidate.registered, false);
          assert.equal(candidate.params.steps.length, 3);
          write(root, 'other/a.js', 'const oldName = 1;');
          write(root, 'other/b.js', 'const oldName = 2;');
          const shortTask = { id: 'short-source', level: 'l0', allowedPaths: ['other/a.js', 'other/b.js'],
            operation: { type: 'sequence', steps: ['other/a.js', 'other/b.js'].map(file =>
              ({ type: 'rename_identifier', path: file, from: 'oldName', to: 'newName' })) } };
          const shortResult = applyDerivation({ task: shortTask, root, repoState: CLEAN_BRANCH,
            journal: store.journal, runId: 'short-source', authorized: true });
          assert.equal(shortResult.ok, true, JSON.stringify(shortResult));
          const shortCandidate = rememberCandidate({ task: shortTask, journal: store.journal, root,
            runId: 'short-source', workspaceId: 'default', file: '.huqan/coder/candidates/aaa-short.json' });
          assert.equal(shortCandidate.ok, true, JSON.stringify(shortCandidate));
          const unrelatedPaths = ['other/u.js', 'other/v.js', 'other/w.js'];
          for (const file of unrelatedPaths) write(root, file, 'const unusedName = 1;');
          const unrelatedTask = { id: 'unrelated-source', level: 'l0', allowedPaths: unrelatedPaths,
            operation: { type: 'sequence', steps: unrelatedPaths.map(file =>
              ({ type: 'rename_identifier', path: file, from: 'unusedName', to: 'changedName' })) } };
          assert.equal(applyDerivation({ task: unrelatedTask, root, repoState: CLEAN_BRANCH, authorized: true,
            journal: store.journal, runId: 'unrelated-source' }).ok, true);
          assert.equal(rememberCandidate({ task: unrelatedTask, journal: store.journal, root,
            runId: 'unrelated-source', workspaceId: 'default', file: '.huqan/coder/candidates/aab-unrelated.json' }).ok, true);
          const { resolveCandidate, selectCandidate } = require('../lib/coder/learned-candidate');
          const request = { task: produced.task, journal: store.journal, root, workspaceId: 'default', file: candidateFile };
          assert.equal(resolveCandidate(request).reason, 'sequence_candidate_dispatch_unavailable');
          fs.writeFileSync(path.join(root, 'note.md'), 'before');
          const textTask = { id: 'text-source', level: 'l0', allowedPaths: ['note.md'],
            operation: { type: 'replace_text', path: 'note.md', find: 'before', replace: 'after' } };
          assert.equal(applyDerivation({ task: textTask, root, repoState: CLEAN_BRANCH,
            journal: store.journal, runId: 'text-source' }).ok, true);
          assert.equal(rememberCandidate({ task: textTask, journal: store.journal, root,
            runId: 'text-source', workspaceId: 'default', file: '.huqan/coder/candidates/text.json' }).ok, true);
          fs.writeFileSync(path.join(root, 'note.md'), 'before');
          const selection = { task: { ...textTask, operation: { type: 'replace_text', path: 'note.md' } },
            journal: store.journal, root, workspaceId: 'default' };
          assert.equal(selectCandidate(selection).ok, true);
          candidate.params.steps.reverse();
          fs.writeFileSync(path.join(root, candidateFile), JSON.stringify(candidate));
          assert.equal(resolveCandidate(request).reason, 'source_procedure_mismatch');
          assert.equal(selectCandidate(selection).reason, 'source_procedure_mismatch');
          fs.writeFileSync(path.join(root, candidateFile), bytes);
        } finally { store.close(); }
        const targetFiles = Object.fromEntries(Object.entries(originals).map(([file, text]) => [file.replace('src/', 'dst/'), text]));
        for (const [file, text] of Object.entries(targetFiles)) write(root, file, text);
        const sourceQualification = files => JSON.stringify({ format: 'huqan-coder-rename-qualification', schemaVersion: 1, files });
        write(root, 'q-drift.json', sourceQualification({ ...originals, 'src/first.js': '// oldName' }));
        write(root, 'q-ambiguous.json', sourceQualification({ ...originals, 'src/first.js': 'oldName; newName;' }));
        const qualificationBytes = ['q-drift.json', 'q-ambiguous.json'].map(file => fs.readFileSync(path.join(root, file)));
        write(root, 'test/target.js', 'const assert = require("node:assert/strict");\n'
          + 'assert.equal(require("../dst/first")(17), 34);\n'
          + 'assert.equal(require("../dst/second")(19), 38);\n'
          + 'assert.equal(require("../dst/export").newName(23), 46);\n');
        git(['add', 'src', 'dst', 'other', 'test', 'note.md']);
        git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'target fixture']);
        write(root, 'intent.json', JSON.stringify({ id: 'unseen-sequence', level: 'l0', allowedPaths: Object.keys(targetFiles),
          operation: { type: 'sequence', paths: Object.keys(targetFiles) }, test: { command: 'node test/target.js' } }));
        const rememberedBytes = fs.readFileSync(path.join(root, '.huqan/coder/candidates/multi.json'));
        const transferred = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'intent.json',
          '--transfer-memory', '--authorize', '--root', root, '--journal', path.join(root, 'journal.db'),
          '--run-id', 'transferred', '--json'], { cwd: root, encoding: 'utf8', timeout: 120000,
          env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') } });
        assert.ifError(transferred.error);
        assert.equal(transferred.status, 0, transferred.stdout + transferred.stderr);
        for (const file of Object.keys(targetFiles)) assert.match(read(root, file), /newName/);
        assert.equal(JSON.parse(transferred.stdout).data.attempts[0].test.ok, true);
        const transferredJournal = openCoderJournal(path.join(root, 'journal.db'));
        try {
          const sealed = readSealedRun(transferredJournal.journal, 'transferred:c1', 'default');
          assert.equal(sealed.ok, true);
          const route = sealed.events.find(event => event.type === 'routing_decided').payload;
          assert.deepEqual(route.transfer.targetPaths, Object.keys(targetFiles));
          assert.equal(route.execution.sequenceSteps, 3);
          assert.equal(sealed.manifest.learningEligibility, 'positive_procedure');
        } finally { transferredJournal.close(); }
        for (const [file, text] of Object.entries(targetFiles)) write(root, file, text);
        write(root, 'test/target.js', 'require("node:assert/strict").equal(require("../dst/first")(17), 999);\n');
        git(['add', 'src', 'dst', 'test', 'note.md']);
        git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'negative target fixture']);
        const negative = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'intent.json',
          '--transfer-memory', '--authorize', '--root', root, '--journal', path.join(root, 'journal.db'),
          '--run-id', 'transfer-negative', '--json'], { cwd: root, encoding: 'utf8', timeout: 120000,
          env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') } });
        assert.ifError(negative.error);
        assert.equal(negative.status, 6, negative.stdout + negative.stderr);
        assert.equal(JSON.parse(negative.stdout).data.attempts[0].rolledBack, true);
        for (const [file, text] of Object.entries(targetFiles)) assert.equal(read(root, file), text);
        assert.deepEqual(fs.readFileSync(path.join(root, '.huqan/coder/candidates/multi.json')), rememberedBytes);
        const negativeJournal = openCoderJournal(path.join(root, 'journal.db'));
        try {
          const sealed = readSealedRun(negativeJournal.journal, 'transfer-negative:c1', 'default');
          assert.equal(sealed.ok, true);
          assert.equal(sealed.manifest.learningEligibility, 'negative_example');
          const { selectCandidate } = require('../lib/coder/learned-candidate');
          const intent = JSON.parse(read(root, 'intent.json'));
          const options = { task: intent, root, journal: negativeJournal.journal, workspaceId: 'default' };
          assert.equal(selectCandidate(options).reason, 'no_applicable_candidate');
          const resolved = selectCandidate({ ...options, allowTransfer: true });
          assert.equal(resolved.ok, true);
          const direct = applyDerivation({ ...options, task: resolved.task, repoState: CLEAN_BRANCH,
            authorized: true, runId: 'untested-sequence' });
          assert.equal(direct.ok, false);
          assert.equal(direct.reason, 'transfer_verification_required');
          for (const [file, text] of Object.entries(targetFiles)) assert.equal(read(root, file), text);
        } finally { negativeJournal.close(); }
        const renamedFiles = Object.fromEntries(Object.entries(originals).map(([file, text]) =>
          [file.replace('src/', 'renamed/'), text.replaceAll('oldName', 'beforeValue')]));
        for (const [file, text] of Object.entries(renamedFiles)) write(root, file, text);
        write(root, 'test/renamed.js', 'const assert = require("node:assert/strict");\n'
          + 'assert.equal(require("../renamed/first")(29), 58);\n'
          + 'assert.equal(require("../renamed/second")(31), 62);\n'
          + 'assert.equal(require("../renamed/export").afterValue(37), 74);\n');
        git(['add', 'renamed', 'test']);
        git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'identifier transfer fixture']);
        const renamedIntent = { id: 'new-identifiers', level: 'l0', allowedPaths: Object.keys(renamedFiles),
          operation: { type: 'sequence', paths: Object.keys(renamedFiles),
            rename: { from: 'beforeValue', to: 'afterValue' } },
          test: { command: 'node test/renamed.js' } };
        assert.doesNotMatch(JSON.stringify(renamedIntent), /oldName|newName|src\//);
        write(root, 'renamed-intent.json', JSON.stringify(renamedIntent));
        const bindingJournal = openCoderJournal(path.join(root, 'journal.db'));
        try {
          const { selectCandidate } = require('../lib/coder/learned-candidate');
          const selected = selectCandidate({ task: renamedIntent, root, journal: bindingJournal.journal,
            workspaceId: 'default', allowTransfer: true });
          assert.equal(selected.ok, true);
          selected.task.experience.candidates[0].rename.to = 'forgedName';
          const { routeCoderProcedure } = require('../lib/experience/coder-routing-runtime');
          assert.equal(routeCoderProcedure({ task: selected.task, root, journal: bindingJournal.journal,
            workspaceId: 'default', requestId: 'forged-binding', files: renamedFiles, transferTestReady: true }).code,
          'procedure_binding_mismatch');
          for (const [file, text] of Object.entries(renamedFiles)) assert.equal(read(root, file), text);
        } finally { bindingJournal.close(); }
        const renamedResult = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'renamed-intent.json',
          '--transfer-memory', '--authorize', '--root', root, '--journal', path.join(root, 'journal.db'),
          '--run-id', 'identifier-transfer', '--json'], { cwd: root, encoding: 'utf8', timeout: 120000,
          env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') } });
        assert.ifError(renamedResult.error);
        assert.equal(renamedResult.status, 0, renamedResult.stdout + renamedResult.stderr);
        for (const file of Object.keys(renamedFiles)) assert.match(read(root, file), /afterValue/);
        assert.match(read(root, 'renamed/export.js'), /\/\/ beforeValue/);
        assert.match(read(root, 'renamed/second.js'), /"beforeValue"/);
        const identifierJournal = openCoderJournal(path.join(root, 'journal.db'));
        try {
          const oldRoute = readSealedRun(identifierJournal.journal, 'transferred:c1', 'default')
            .events.find(event => event.type === 'routing_decided').payload;
          const newRoute = readSealedRun(identifierJournal.journal, 'identifier-transfer:c1', 'default')
            .events.find(event => event.type === 'routing_decided').payload;
          assert.notEqual(newRoute.boundProcedureVersion, oldRoute.boundProcedureVersion);
          assert.notEqual(newRoute.chosenCapabilityId, oldRoute.chosenCapabilityId);
          assert.equal(newRoute.transfer.sourceProcedureHash, oldRoute.transfer.sourceProcedureHash);
        } finally { identifierJournal.close(); }
        assert.deepEqual(fs.readFileSync(path.join(root, '.huqan/coder/candidates/multi.json')), rememberedBytes);
        for (const [at, file] of ['q-drift.json', 'q-ambiguous.json'].entries())
          assert.deepEqual(fs.readFileSync(path.join(root, file)), qualificationBytes[at]);
        for (const file of Object.keys(originals)) assert.match(read(root, file), /newName/);
        assert.match(read(root, 'src/export.js'), /\/\/ oldName/);
        assert.match(read(root, 'src/second.js'), /"oldName"/);
      } else {
        assert.equal(result.attempts[0].rolledBack, true);
        for (const [file, text] of Object.entries(originals)) assert.equal(read(root, file), text);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-producer-')));
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

describe('task producer', () => {
  it('projects a verified replace_text failure onto a bounded transform task', () => {
    const result = produceTask(failure());

    assert.equal(result.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(result.reason, null);
    assert.equal(result.sourceFailureId, 'failure-abc123');
    assert.deepEqual(result.task.allowedPaths, ['docs/notes.md']);
    assert.equal(result.task.operation.type, 'replace_text');
    assert.equal(result.task.operation.path, 'docs/notes.md');
  });

  it('searches for the observed text and writes the expected text, not the reverse', () => {
    const { task } = produceTask(failure());

    // The failure says v1.0.0 was there and v1.1.0 should have been. A
    // producer that swapped these would "fix" the file by making it reproduce
    // the failure.
    assert.equal(task.operation.find, 'version v1.0.0\n');
    assert.equal(task.operation.replace, 'version v1.1.0\n');
  });

  it('carries allowedPaths and the operation and nothing else that widens authority', () => {
    const { task } = produceTask(failure());

    assert.equal(task.requiresHumanDecision, undefined);
    assert.equal(task.expectedPatch, undefined);
    assert.equal(task.files && Object.keys(task.files).length, 0);
  });

  it('derives the task id from the failure id so a re-run is the same task', () => {
    const first = produceTask(failure()).task;
    const second = produceTask(failure()).task;

    assert.equal(first.id, 'task-failure-abc123');
    assert.equal(first.id, second.id);
  });

  it('refuses a failure that was not verified', () => {
    for (const status of ['candidate', 'unverified', '', undefined]) {
      const result = produceTask(failure({ verificationStatus: status }));
      assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
      assert.equal(result.reason, PRODUCER_REASONS.FAILURE_NOT_VERIFIED);
      assert.equal(result.task, null);
    }
  });

  it('returns needs_human_decision rather than a guessed task for an unsupported operation', () => {
    // json_schema_route_test needs a whole schema, which a failure record does
    // not carry, so it stays unmappable -- refusing it is the correct answer,
    // not a gap in the catalog.
    const result = produceTask(failure({ action: { operation: 'json_schema_route_test', path: 'docs/notes.md' } }));

    assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, PRODUCER_REASONS.NO_SUPPORTED_OPERATION);
    assert.equal(result.task, null);
  });

  it('projects a verified insert_after failure by reading observed as the anchor and expected as the insert', () => {
    const result = produceTask(failure({
      action: { operation: 'insert_after', path: 'docs/notes.md' },
      observed: 'const x = 1;',
      expected: '\nconst y = 2;',
    }));

    assert.equal(result.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(result.task.operation.type, 'insert_after');
    assert.equal(result.task.operation.anchor, 'const x = 1;');
    assert.equal(result.task.operation.insert, '\nconst y = 2;');
  });

  it('refuses an insert_after failure whose anchor is not unique in the held file', () => {
    const result = produceTask(failure({
      action: { operation: 'insert_after', path: 'docs/notes.md' },
      observed: 'x',
      expected: 'y',
    }), { files: { 'docs/notes.md': 'x x' } });

    assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, PRODUCER_REASONS.ANCHOR_NOT_UNIQUE);
    assert.equal(result.task, null);
  });

  it('projects a verified rename_identifier failure only when both halves are real identifiers', () => {
    const renamed = produceTask(failure({
      action: { operation: 'rename_identifier', path: 'src/thing.js' },
      observed: 'oldName',
      expected: 'newName',
    }));
    assert.equal(renamed.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(renamed.task.operation.type, 'rename_identifier');
    assert.equal(renamed.task.operation.from, 'oldName');
    assert.equal(renamed.task.operation.to, 'newName');

    const notIdentifiers = produceTask(failure({
      action: { operation: 'rename_identifier', path: 'src/thing.js' },
      observed: 'old name',
      expected: 'new name',
    }));
    assert.equal(notIdentifiers.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(notIdentifiers.reason, PRODUCER_REASONS.IDENTIFIER_PAIR_INVALID);
    assert.equal(notIdentifiers.task, null);
  });

  it('projects a verified create_file failure from the record payload, not from the string pair', () => {
    // create_file writes a file that does not exist yet, so it has no observed
    // text and cannot be read off the observed/expected pair. The content comes
    // from the record's own bounded payload; the declaration still selects the
    // transform.
    const result = produceTask(failure({
      action: { operation: 'create_file', path: 'docs/new.md' },
      observed: '',
      expected: '',
      payload: { content: '# New\n' },
    }));

    assert.equal(result.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(result.task.operation.type, 'create_file');
    assert.equal(result.task.operation.path, 'docs/new.md');
    assert.equal(result.task.operation.content, '# New\n');
    assert.deepEqual(result.task.allowedPaths, ['docs/new.md']);
  });

  it('refuses a create_file failure whose payload is absent, wrong-typed, or over the byte bound', () => {
    const declared = { operation: 'create_file', path: 'docs/new.md' };

    const absent = produceTask(failure({ action: declared }));
    assert.equal(absent.reason, PRODUCER_REASONS.CONTENT_MISSING);

    const wrongType = produceTask(failure({ action: declared, payload: { content: 42 } }));
    assert.equal(wrongType.reason, PRODUCER_REASONS.CONTENT_MISSING);

    const overBound = produceTask(failure({ action: declared, payload: { content: 'x'.repeat(MAX_CREATE_FILE_BYTES + 1) } }));
    assert.equal(overBound.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(overBound.reason, PRODUCER_REASONS.CONTENT_TOO_LARGE);
    assert.equal(overBound.task, null);

    // Exactly at the bound is still a task: the check is "larger than", not
    // "at least".
    const atBound = produceTask(failure({ action: declared, payload: { content: 'x'.repeat(MAX_CREATE_FILE_BYTES) } }));
    assert.equal(atBound.status, PRODUCER_STATUSES.TASK_PRODUCED);
  });

  it('refuses a create_file failure whose path is absolute or escapes the root', () => {
    for (const declared of ['/etc/passwd', '../../outside.md']) {
      const result = produceTask(failure({
        action: { operation: 'create_file', path: declared },
        payload: { content: 'x' },
      }));
      assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
      assert.equal(result.reason, PRODUCER_REASONS.FAILURE_PATH_ESCAPES_ROOT);
      assert.equal(result.task, null);
    }
  });

  it('does not let a create_file payload leak into the other transforms', () => {
    // A payload is ignored unless the declared operation is create_file; a
    // replace_text record still reads the pair and nothing else.
    const result = produceTask(failure({
      action: { operation: 'replace_text', path: 'docs/notes.md' },
      observed: 'v1.0.0',
      expected: 'v1.1.0',
      payload: { content: 'ignored' },
    }));
    assert.equal(result.task.operation.type, 'replace_text');
    assert.equal(result.task.operation.find, 'v1.0.0');
    assert.equal(result.task.operation.replace, 'v1.1.0');
    assert.equal(result.task.operation.content, undefined);
  });

  it('refuses surrounding whitespace in either rename identifier without producing a task', () => {
    for (const whitespace of [' ', '\t', '\n', '\r\n', '\u00a0']) {
      for (const field of ['observed', 'expected']) {
        for (const padded of [`${whitespace}name`, `name${whitespace}`]) {
          const result = produceTask(failure({
            action: { operation: 'rename_identifier', path: 'src/thing.js' },
            observed: 'oldName', expected: 'newName', [field]: padded,
          }));
          assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
          assert.equal(result.reason, PRODUCER_REASONS.IDENTIFIER_PAIR_INVALID);
          assert.equal(result.task, null);
        }
      }
    }
  });

  it('refuses a failure whose path is absolute or escapes the root', () => {
    for (const declared of ['/etc/passwd', 'C:/Windows/system32/drivers', '../../outside.md']) {
      const result = produceTask(failure({ action: { operation: 'replace_text', path: declared } }));
      assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
      assert.equal(result.reason, PRODUCER_REASONS.FAILURE_PATH_ESCAPES_ROOT);
      assert.equal(result.task, null);
    }
  });

  it('refuses a failure that does not carry both halves of the replacement', () => {
    const noExpected = produceTask(failure({ expected: '' }));
    assert.equal(noExpected.reason, PRODUCER_REASONS.FAILURE_EXPECTED_MISSING);

    const noObserved = produceTask(failure({ observed: '' }));
    assert.equal(noObserved.reason, PRODUCER_REASONS.FAILURE_OBSERVED_MISSING);

    const same = produceTask(failure({ expected: 'x', observed: 'x' }));
    assert.equal(same.reason, PRODUCER_REASONS.FAILURE_EXPECTED_EQUALS_OBSERVED);
    assert.equal(same.task, null);
  });

  it('refuses when the replacement would not occur exactly once', () => {
    const content = 'v1.0.0\nv1.0.0\n';
    const result = produceTask(failure({ observed: 'v1.0.0', expected: 'v1.1.0' }), {
      files: { 'docs/notes.md': content },
    });

    assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, PRODUCER_REASONS.REPLACEMENT_NOT_UNIQUE);
    assert.equal(result.task, null);
  });

  it('rejects anything that is not a failure record', () => {
    assert.equal(produceTask(null).reason, PRODUCER_REASONS.FAILURE_NOT_OBJECT);
    assert.equal(produceTask({ kind: 'rule' }).reason, PRODUCER_REASONS.FAILURE_KIND_INVALID);
    assert.equal(produceTask(failure({ failureId: '' })).reason, PRODUCER_REASONS.FAILURE_ID_MISSING);
  });

  it('writes nothing to disk', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');

    const before = fs.readdirSync(root, { recursive: true }).sort();
    produceTask(failure());
    produceTask(failure({ verificationStatus: 'candidate' }));
    const after = fs.readdirSync(root, { recursive: true }).sort();

    assert.deepEqual(after, before);
    assert.equal(read(root, 'docs/notes.md'), 'version v1.0.0\n');
  });

  it('runs against a read-only tree without failing', () => {
    if (process.platform === 'win32' || process.getuid === undefined) {
      return; // chmod does not deny writes to the owner on Windows.
    }
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');
    fs.chmodSync(path.join(root, 'docs'), 0o500);

    try {
      const result = produceTask(failure());
      assert.equal(result.status, PRODUCER_STATUSES.TASK_PRODUCED);
    } finally {
      fs.chmodSync(path.join(root, 'docs'), 0o700);
    }
  });
});

describe('produced task through the coder pipeline', () => {
  it('reproduces the intended change under --dry-run with a stable derivationHash', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');

    const { task } = produceTask(failure());

    const first = applyDerivation({ task, root, repoState: CLEAN_BRANCH, dryRun: true });
    const second = applyDerivation({ task, root, repoState: CLEAN_BRANCH, dryRun: true });

    assert.equal(first.ok, true);
    assert.equal(first.outcome, 'dry_run');
    assert.deepEqual(first.patch, [{
      path: 'docs/notes.md',
      before: 'version v1.0.0\n',
      after: 'version v1.1.0\n',
    }]);

    // Dry-run must not have touched the tree.
    assert.equal(read(root, 'docs/notes.md'), 'version v1.0.0\n');

    assert.equal(first.record.derivationHash, second.record.derivationHash);
    assert.equal(verifyDerivationHash(first.record).ok, true);
  });

  it('applies the change when the gate allows it, and still answers to the gate when it does not', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');
    const { task } = produceTask(failure());

    const applied = applyDerivation({ task, root, repoState: CLEAN_BRANCH });
    assert.equal(applied.ok, true);
    assert.equal(applied.outcome, 'applied');
    assert.equal(read(root, 'docs/notes.md'), 'version v1.1.0\n');

    // The gate is not bypassed by the producer: on main it still refuses.
    const second = makeRoot();
    write(second, 'docs/notes.md', 'version v1.0.0\n');
    const refused = applyDerivation({
      task,
      root: second,
      repoState: { branch: 'main', dirty: false, hasUntracked: false },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'GATE_REFUSED');
    assert.equal(read(second, 'docs/notes.md'), 'version v1.0.0\n');
  });

  it('a task nobody could map never reaches a write, because there is no task', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');

    // json_schema_route_test is the shape a failure record cannot carry.
    const result = produceTask(failure({ action: { operation: 'json_schema_route_test', path: 'docs/notes.md' } }));

    assert.equal(result.task, null);
    assert.equal(read(root, 'docs/notes.md'), 'version v1.0.0\n');
  });

  it('applies a produced insert_after task and a produced rename_identifier task through the gate', () => {
    const insertRoot = makeRoot();
    write(insertRoot, 'docs/notes.md', 'before\n');
    const insert = produceTask(failure({
      action: { operation: 'insert_after', path: 'docs/notes.md' },
      observed: 'before\n',
      expected: 'after\n',
    })).task;
    const inserted = applyDerivation({ task: insert, root: insertRoot, repoState: CLEAN_BRANCH });
    assert.equal(inserted.outcome, 'applied');
    assert.equal(read(insertRoot, 'docs/notes.md'), 'before\nafter\n');

    const renameRoot = makeRoot();
    write(renameRoot, 'src/thing.js', 'const oldName = 1;\n');
    const rename = produceTask(failure({
      action: { operation: 'rename_identifier', path: 'src/thing.js' },
      observed: 'oldName',
      expected: 'newName',
    })).task;
    // A source-file change is refused until an operator authorizes it: the
    // proposal confers nothing, and the gate is what decides.
    const unauthorized = applyDerivation({ task: rename, root: renameRoot, repoState: CLEAN_BRANCH });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.reason, 'GATE_REFUSED');
    assert.equal(read(renameRoot, 'src/thing.js'), 'const oldName = 1;\n');

    const renamed = applyDerivation({ task: rename, root: renameRoot, repoState: CLEAN_BRANCH, authorized: true });
    assert.equal(renamed.outcome, 'applied');
    assert.equal(read(renameRoot, 'src/thing.js'), 'const newName = 1;\n');
  });

  it('applies a produced create_file task, and re-derives it so a re-run is the same record', () => {
    const root = makeRoot();
    const { task } = produceTask(failure({
      action: { operation: 'create_file', path: 'docs/new.md' },
      observed: '',
      expected: '',
      payload: { content: '# New\n' },
    }));

    const first = applyDerivation({ task, root, repoState: CLEAN_BRANCH });
    assert.equal(first.ok, true);
    assert.equal(first.outcome, 'applied');
    assert.equal(read(root, 'docs/new.md'), '# New\n');
    assert.deepEqual(first.patch, [{ path: 'docs/new.md', before: null, after: '# New\n' }]);

    // The same record is content-addressed by the payload in its fingerprint:
    // an identical failure projects to an identical task and derivation hash,
    // so a re-run against a clean base is not a new decision.
    const again = produceTask(failure({
      action: { operation: 'create_file', path: 'docs/new.md' },
      observed: '',
      expected: '',
      payload: { content: '# New\n' },
    })).task;
    assert.equal(again.id, task.id);
    const cleanRoot = makeRoot();
    const replay = applyDerivation({ task: again, root: cleanRoot, repoState: CLEAN_BRANCH, dryRun: true });
    assert.equal(replay.record.derivationHash, first.record.derivationHash);
  });

  it('leaves a create_file that already holds content to the runner, which owns FILE_ALREADY_EXISTS', () => {
    const root = makeRoot();
    write(root, 'docs/new.md', 'already here\n');
    const { task } = produceTask(failure({
      action: { operation: 'create_file', path: 'docs/new.md' },
      observed: '',
      expected: '',
      payload: { content: '# New\n' },
    }));

    const result = applyDerivation({ task, root, repoState: CLEAN_BRANCH });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'TRANSFORM_REFUSED');
    assert.equal(read(root, 'docs/new.md'), 'already here\n');
  });
});
