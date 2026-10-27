'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runCliCoder } = require('../lib/cli-coder');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const { openJournalConnection } = require('../lib/experience/journal-connection');
const { createExperienceJournal } = require('../lib/experience/journal');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function files(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    const file = path.join(root, name);
    if (entry.isDirectory()) {
      for (const [key, value] of Object.entries(files(file))) result[`${name}/${key}`] = value;
    } else result[name] = sha(fs.readFileSync(file));
  }
  return result;
}
function fixture(t, contents = ['alpha v1.0.0', 'beta v1.0.0', 'gamma v1.0.0'], replacement = 'v1.1.0') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'experience.db');
  const params = { path: 'docs/notes.md', oldText: 'v1.0.0', newText: replacement };
  const request = { capabilityId: 'stored-release-replacement', params, parentVersion: 0,
    qualificationInputs: [{ id: 'unseen', before: 'unseen context v1.0.0', expectedAfter: `unseen context ${replacement}` }] };
  const requestPath = path.join(dir, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request));
  for (let i = 0; i < contents.length; i++) {
    const root = path.join(dir, `source-${i}`); fs.mkdirSync(root);
    const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
    git(['init', '-q', '-b', 'feature/replay']);
    git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, params.path), contents[i]);
    git(['add', '--', params.path]); git(['commit', '-qm', 'source']);
    const taskPath = path.join(dir, `task-${i}.json`);
    fs.writeFileSync(taskPath, JSON.stringify({ id: `replace-${i}`, level: 'l0', allowedPaths: [params.path],
      operation: { type: 'replace_text', path: params.path, find: params.oldText, replace: params.newText } }));
    const run = runCliCoder([taskPath, '--root', root, '--journal', db, '--run-id', `native-${i}`], { json: true });
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(fs.readFileSync(path.join(root, params.path), 'utf8'), contents[i].replace(params.oldText, () => params.newText));
  }
  const argv = ['terfi', '--from-replay', '--dry-run', '--journal', db, '--workspace', 'default', '--request', requestPath, '--json'];
  return { dir, db, request, requestPath, argv };
}
function invoke(f, guard) {
  return spawnSync(process.execPath, [...(guard ? ['--require', guard] : []), path.resolve(__dirname, '../cli.js'), ...f.argv],
    { cwd: f.dir, encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

test('real CLI compiles independently qualified candidates from native sealed runs without writing', t => {
  const f = fixture(t);
  const guard = path.join(f.dir, 'no-promotion.cjs');
  fs.writeFileSync(guard, "const M=require('node:module'),fs=require('node:fs'),path=require('node:path'),load=M._load;M._load=function(id,...args){const result=load.call(this,id,...args);if(id.endsWith('experience/reflective-promotion'))return {...result,createReflectivePromotion(...values){const loop=result.createReflectivePromotion(...values);return {...loop,propose(...input){fs.writeFileSync(path.join(__dirname,'unexpected-propose'),'called');return loop.propose(...input);}};}};return result;};");
  const before = files(f.dir);
  const child = invoke(f, guard);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout).data;
  assert.equal(result.authority, 'CANDIDATE_ONLY');
  assert.equal(result.registered, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].nIndependent, 3);
  assert.equal(result.candidates[0].qualification.qualified, true);
  assert.equal(result.candidates[0].procedure.kind, 'replace_text');
  assert.equal(result.candidates[0].procedure.version, 1);
  assert.deepEqual(result.candidates[0].support, ['native-0', 'native-1', 'native-2']);
  assert.ok(result.signals.every(signal => signal.reward.expectedSource === 'prior'));
  assert.deepEqual(files(f.dir), before);
});

test('qualification preserves literal replacement tokens used by native Coder', t => {
  const f = fixture(t, undefined, '$$');
  const before = files(f.dir), child = invoke(f);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout).data;
  assert.equal(result.candidates.length, 1, JSON.stringify(result.rejectedCandidates));
  assert.equal(result.candidates[0].procedure.params.newText, '$$');
  assert.deepEqual(files(f.dir), before);
});

test('qualification rejects copied sources and wrong oracles without changing files', async t => {
  const f = fixture(t);
  for (const [name, patch, reason] of [
    ['source copy', { before: 'alpha v1.0.0', expectedAfter: 'alpha v1.1.0' }, 'qualification_source_overlap'],
    ['source output as input', { before: 'alpha v1.1.0', expectedAfter: 'different v1.1.0' }, 'qualification_source_overlap'],
    ['wrong oracle', { before: 'different v1.0.0', expectedAfter: 'wrong v1.1.0' }, 'qualification_oracle_mismatch'],
  ]) await t.test(name, () => {
    fs.writeFileSync(f.requestPath, JSON.stringify({ ...f.request, qualificationInputs: [{ id: 'unseen', ...patch }] }));
    const before = files(f.dir), child = invoke(f);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout).data;
    assert.deepEqual(result.candidates, []);
    assert.equal(result.rejectedCandidates[0].reason, reason);
    assert.deepEqual(files(f.dir), before);
  });
  await t.test('workspace isolation', () => {
    const index = f.argv.indexOf('--workspace'); f.argv[index + 1] = 'other';
    const before = files(f.dir), child = invoke(f);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout).data;
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.signals, []);
    assert.deepEqual(files(f.dir), before);
  });
  await t.test('reported verification cannot override a contradictory native readback', () => {
    f.argv[f.argv.indexOf('--workspace') + 1] = 'default';
    fs.writeFileSync(f.requestPath, JSON.stringify(f.request));
    const store = openJournalConnection({ dbPath: f.db });
    try {
      const journal = createExperienceJournal({ store });
      for (const event of journal.read('native-0')) {
        const copy = structuredClone(event); delete copy.sequence; delete copy.hash;
        for (const key of ['runId', 'eventId', 'attemptId', 'invocationId', 'causedByEventId']) {
          if (typeof copy[key] === 'string') copy[key] = copy[key].replace('native-0', 'contradictory');
        }
        if (copy.type === 'verification') {
          copy.payload.checks[0].actualSha256 = 'f'.repeat(64); copy.payload.checks[0].match = false;
        }
        assert.equal(journal.append(copy).ok, true);
      }
    } finally { store.close(); }
    const before = files(f.dir), child = invoke(f);
    assert.equal(child.status, 2, child.stderr || child.stdout);
    assert.match(child.stdout, /verification_eligibility_mismatch/);
    assert.deepEqual(files(f.dir), before);
  });
});

test('multiple native verifications cannot hide a contradictory later readback', t => {
  const f = fixture(t), store = openJournalConnection({ dbPath: f.db });
  try {
    const journal = createExperienceJournal({ store });
    for (const event of journal.read('native-0')) {
      const copy = structuredClone(event); delete copy.sequence; delete copy.hash;
      for (const key of ['runId', 'eventId', 'attemptId', 'invocationId', 'causedByEventId']) {
        if (typeof copy[key] === 'string') copy[key] = copy[key].replace('native-0', 'ambiguous');
      }
      assert.equal(journal.append(copy).ok, true);
      if (copy.type === 'verification') {
        const later = structuredClone(copy); later.eventId += '-later';
        later.payload.verified = false;
        later.payload.checks[0].actualSha256 = 'f'.repeat(64); later.payload.checks[0].match = false;
        assert.equal(journal.append(later).ok, true);
      }
    }
    assert.equal(journal.manifest('ambiguous').learningEligibility, 'positive_procedure');
  } finally { store.close(); }
  const before = files(f.dir), child = invoke(f);
  assert.equal(child.status, 2, child.stderr || child.stdout);
  assert.match(child.stdout, /native_observation_ambiguous/);
  assert.deepEqual(files(f.dir), before);
});

test('nonmatching ambiguous histories do not block matching replay candidates', t => {
  const f = fixture(t), store = openJournalConnection({ dbPath: f.db });
  try {
    const journal = createExperienceJournal({ store });
    for (const event of journal.read('native-0')) {
      const copy = structuredClone(event); delete copy.sequence; delete copy.hash;
      for (const key of ['runId', 'eventId', 'attemptId', 'invocationId', 'causedByEventId']) {
        if (typeof copy[key] === 'string') copy[key] = copy[key].replace('native-0', 'unrelated');
      }
      if (copy.type === 'action_proposed') copy.payload.operationType = 'rename_identifier';
      assert.equal(journal.append(copy).ok, true);
      if (copy.type === 'verification') {
        const later = structuredClone(copy); later.eventId += '-later';
        assert.equal(journal.append(later).ok, true);
      }
    }
  } finally { store.close(); }
  const before = files(f.dir), child = invoke(f);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout).data;
  assert.equal(result.candidates.length, 1);
  assert.ok(result.skipped.some(row => row.episodeId === 'unrelated' && row.reason === 'source_operation_mismatch'));
  assert.deepEqual(files(f.dir), before);
});

test('larger replay support remains qualified within the compiler source bound', t => {
  const f = fixture(t), store = openJournalConnection({ dbPath: f.db });
  try {
    const journal = createExperienceJournal({ store }), events = journal.read('native-0');
    for (let i = 0; i < 31; i++) for (const event of events) {
      const copy = structuredClone(event); delete copy.sequence; delete copy.hash;
      for (const key of ['runId', 'eventId', 'attemptId', 'invocationId', 'causedByEventId']) {
        if (typeof copy[key] === 'string') copy[key] = copy[key].replace('native-0', `repeat-${i}`);
      }
      assert.equal(journal.append(copy).ok, true);
    }
  } finally { store.close(); }
  f.argv.push('--budget', '64');
  const before = files(f.dir), child = invoke(f);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout).data;
  assert.equal(result.candidates.length, 1, JSON.stringify(result.rejectedCandidates));
  const candidate = result.candidates[0];
  assert.equal(candidate.support.length, 34);
  assert.equal(candidate.nIndependent, 3);
  assert.equal(candidate.compiledSupport.length, 3);
  assert.deepEqual(files(f.dir), before);
});

test('future dependency bridges cannot collapse current compilation support', t => {
  const f = fixture(t), store = openJournalConnection({ dbPath: f.db });
  try {
    const journal = createExperienceJournal({ store });
    for (const event of journal.read('native-0')) {
      const copy = structuredClone(event); delete copy.sequence; delete copy.hash;
      for (const key of ['runId', 'eventId', 'attemptId', 'invocationId', 'causedByEventId']) {
        if (typeof copy[key] === 'string') copy[key] = copy[key].replace('native-0', 'future-bridge');
      }
      if (copy.type === 'run_started') {
        copy.payload.createdAt = '2999-01-01T00:00:00.000Z'; copy.parentRunId = 'native-1';
      }
      if (copy.type === 'action_proposed') copy.parentRunId = 'native-2';
      assert.equal(journal.append(copy).ok, true);
    }
  } finally { store.close(); }
  const before = files(f.dir), child = invoke(f);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout).data;
  assert.equal(result.candidates[0].nIndependent, 3);
  assert.equal(result.candidates[0].compiledSupport.length, 3);
  assert.ok(result.skipped.some(row => row.episodeId === 'future-bridge' && row.reason === 'future_episode'));
  assert.deepEqual(files(f.dir), before);
});

test('copied native content does not become independent support', t => {
  const f = fixture(t, ['same v1.0.0', 'same v1.0.0', 'same v1.0.0']);
  const child = invoke(f); assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout).data.candidates, []);
});

test('preview argv refuses mutation flags and never constructs a Kernel', async () => {
  const output = [];
  const result = await runCliArgv(['terfi', '--from-replay', '--dry-run', '--onaylayan', 'operator', '--json'],
    { stdout: value => output.push(value), stderr: value => output.push(value) },
    { runReplayCommand: require('../lib/cli-replay').runReplayCommand,
      createCli() { assert.fail('dry-run constructed the Kernel'); } });
  assert.equal(result.exitCode, 2);
  assert.match(output.join('\n'), /onaylayan|unknown/i);
});
