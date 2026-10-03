'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');

test('public coder CLI reopens evidence and dispatches a learned procedure to a real file', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-public-learned-'));
  const root = path.join(fixture, 'workspace');
  const taskFile = path.join(fixture, 'task.json');
  const dbFile = path.join(fixture, 'evidence.db');
  const clockFile = path.join(fixture, 'clock.js');
  let store;
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    // Routing acceptance controls the budget clock; real commit timing and
    // budget refusal have their own production-budget tests. No I/O is mocked.
    fs.writeFileSync(clockFile, `const budget = require(${JSON.stringify(path.join(__dirname, '../lib/experience/budgeted-journal'))});
const wrap = budget.budgetExperienceJournal; let tick = 0;
budget.budgetExperienceJournal = (journal, options) => wrap(journal, { ...options, now: () => (tick += 0.1) });
`);
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    fs.writeFileSync(path.join(root, 'docs/drift.md'), 'absent');
    fs.writeFileSync(path.join(root, 'docs/ambiguous.md'), 'before before');
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    git(['init', '-b', 'feat/learned-cli-fixture', '-q']);
    git(['config', 'user.name', 'fixture']);
    git(['config', 'user.email', 'fixture@example.test']);
    git(['add', 'docs/a.md', 'docs/drift.md', 'docs/ambiguous.md']);
    git(['commit', '-qm', 'fixture']);
    const task = { id: 'public-learned', level: 'l0', allowedPaths: ['docs/a.md'],
      operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } };
    const run = id => JSON.parse(execFileSync(process.execPath, ['--require', clockFile, path.join(__dirname, '..', 'cli.js'),
      'coder', taskFile, '--root', root, '--journal', dbFile, '--run-id', id, '--json'],
    { cwd: root, encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(fixture, 'state'),
        HUQAN_MEMORY_PATH: path.join(fixture, 'memory.json'), HUQAN_DB_PATH: path.join(fixture, 'memory.db') } }));
    fs.writeFileSync(taskFile, JSON.stringify(task));
    const source = run('public-source');
    assert.equal(source.data.outcome, 'applied', JSON.stringify({ reason: source.data.reason, detail: source.data.detail,
      status: git(['status', '--short']) }));
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    fs.writeFileSync(taskFile, JSON.stringify({ ...task, experience: { riskTier: 'low', candidates: [{
      capabilityId: 'public-replace', sourceRunIds: ['public-source'],
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'],
    }] } }));
    const routed = run('public-routed');
    assert.equal(routed.data.outcome, 'applied', JSON.stringify({ reason: routed.data.reason, detail: routed.data.detail }));
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'after');
    store = openCoderJournal(dbFile);
    const decision = store.journal.read('public-routed').find(event => event.type === 'routing_decided');
    assert.equal(decision.payload.chosenCapabilityId, 'public-replace');
    assert.equal(store.journal.manifest('public-routed').learningEligibility, 'positive_procedure');
  } finally {
    store?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
