'use strict';

/**
 * CLI journal wiring (#2388).
 *
 * `coder --journal <db>` runs the same pipeline as a journal-less run, plus
 * the Experience chain in a real SQLite file. No mocks: a real task file, a
 * real working tree, a real database file, and an independent read-back of
 * that file to prove the rows survived the CLI process boundary (the close).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCliCoder } = require('../lib/cli-coder');
const { loadSqliteDriver } = require('../lib/sqlite-availability');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-xp-'));
  return fs.realpathSync(root);
}

/**
 * A real git repository with a clean feature tree, so the gate sees an
 * inspected tree rather than guessing. (#2992: git walks up from a bare
 * directory, so a plain tmp dir would report an ancestor repo's state.)
 */
function makeGitRoot() {
  const root = makeRoot();
  const git = (args) => require('node:child_process').execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '-b', 'feat/coder-journal-test', '-q']);
  git(['config', 'user.email', 'test@huqan.local']);
  git(['config', 'user.name', 'huqan-test']);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/notes.md'), 'release v1.0.0 shipped\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  return root;
}

function writeTask(task) {
  const dir = makeRoot();
  const taskFile = path.join(dir, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify(task), 'utf8');
  return taskFile;
}

function docsTask() {
  return {
    id: 'task-cli-xp-1',
    level: 'l0',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
  };
}

function journalDb() {
  const dir = makeRoot();
  return path.join(dir, 'pilot.db');
}

function countJournalRows(dbPath) {
  const { Database } = loadSqliteDriver();
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM experience_journal').get().n;
  } finally {
    db.close();
  }
}

describe('coder --journal', () => {
  it('writes the file, the chain, and the rows in the database file', () => {
    const root = makeGitRoot();
    const taskFile = writeTask(docsTask());
    const dbPath = journalDb();

    const output = runCliCoder([taskFile, '--root', root, '--journal', dbPath], {});

    assert.match(output, /Run:\s+coder:task-cli-xp-1:/);
    assert.match(output, /Experience: 7 events/);
    assert.equal(fs.readFileSync(path.join(root, 'docs/notes.md'), 'utf8'), 'release v1.1.0 shipped\n');
    // Independent read-back through a second connection: the rows are on
    // disk, not just in the CLI process memory.
    assert.equal(countJournalRows(dbPath), 7);
  });

  it('honours --run-id', () => {
    const root = makeGitRoot();
    const taskFile = writeTask(docsTask());
    const dbPath = journalDb();

    const output = runCliCoder([taskFile, '--root', root, '--journal', dbPath, '--run-id', 'pilot-cli-1'], {});

    assert.match(output, /Run:\s+pilot-cli-1/);
    assert.equal(countJournalRows(dbPath), 7);
  });

  it('reports the run in JSON output', () => {
    const root = makeGitRoot();
    const taskFile = writeTask(docsTask());
    const dbPath = journalDb();

    const result = runCliCoder([taskFile, '--root', root, '--journal', dbPath], { json: true });

    assert.equal(result.status, 'completed');
    assert.match(result.data.runId, /coder:task-cli-xp-1:/);
    assert.equal(result.data.experience.failed, null);
    assert.equal(result.data.experience.events.length, 7);
  });

  it('without --journal there is no Run line (previous behaviour unchanged)', () => {
    const root = makeGitRoot();
    const taskFile = writeTask(docsTask());

    const output = runCliCoder([taskFile, '--root', root], {});

    assert.doesNotMatch(output, /Run:/);
    assert.doesNotMatch(output, /Experience:/);
    assert.equal(fs.readFileSync(path.join(root, 'docs/notes.md'), 'utf8'), 'release v1.1.0 shipped\n');
  });

  it('a refused transform still closes the chain and writes nothing', () => {
    const root = makeGitRoot();
    const taskFile = writeTask({
      id: 'task-cli-xp-bad',
      level: 'l0',
      allowedPaths: ['docs/notes.md'],
      operation: { type: 'no_such_transform', path: 'docs/notes.md' },
    });
    const dbPath = journalDb();

    const output = runCliCoder([taskFile, '--root', root, '--journal', dbPath], {});

    assert.match(output, /Outcome:\s+refused/);
    assert.match(output, /Experience: 4 events/);
    assert.equal(fs.readFileSync(path.join(root, 'docs/notes.md'), 'utf8'), 'release v1.0.0 shipped\n');
    assert.equal(countJournalRows(dbPath), 4);
  });
});
