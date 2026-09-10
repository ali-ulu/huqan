'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyDerivation } = require('../lib/coder/apply-derivation');
const { VERIFY_REASONS, directoryReader, verifyDerivation } = require('../lib/coder/verify-derivation');

const CLEAN_BRANCH = { branch: 'feat/verify', dirty: false, hasUntracked: false };
const BASE_CONTENT = 'release v1.0.0 shipped\n';

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-verify-')));
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function task() {
  return {
    id: 'verify-version-bump',
    level: 'l0',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
  };
}

/**
 * Produce a real record by running the coder, then hand back a base tree that
 * still holds the pre-change content. This is the shape a pull request has:
 * base is what was there, head is what the change claims to be.
 */
function derive() {
  const head = makeRoot();
  const base = makeRoot();
  write(head, 'docs/notes.md', BASE_CONTENT);
  write(base, 'docs/notes.md', BASE_CONTENT);

  const result = applyDerivation({ task: task(), root: head, repoState: CLEAN_BRANCH });
  assert.equal(result.outcome, 'applied', 'fixture must start from a real applied derivation');
  return { record: result.record, base, head };
}

function verify({ record, base, head }) {
  return verifyDerivation({
    record,
    readBase: directoryReader(base),
    readHead: directoryReader(head),
  });
}

describe('coder command parsing', () => {
  const { parseCommand } = require('../lib/command-parser');

  it('preserves case in paths and git refs', () => {
    // The parser lowercases the payload for every other command, which is fine
    // for prose and flags and wrong for this one: `--base HEAD` became
    // `--base head` and `Record.JSON` became `record.json`. Windows hid it
    // because its filesystem does not care; CI does.
    const parsed = parseCommand('coder verify /tmp/X/Record.JSON --base HEAD', {});

    assert.equal(parsed.command, 'coder');
    assert.equal(parsed.args, 'verify /tmp/X/Record.JSON --base HEAD');
  });

  it('still accepts the command word in any case', () => {
    assert.equal(parseCommand('CODER task.json --dry-run', {}).command, 'coder');
  });
});

describe('verifyDerivation', () => {
  it('accepts a derivation it can reproduce from the base tree', () => {
    const verdict = verify(derive());

    assert.equal(verdict.ok, true, verdict.detail);
    assert.deepEqual(verdict.checks, ['record_integrity', 'base_inputs', 'rederivation', 'head_matches_derivation']);
    assert.deepEqual(verdict.verifiedPaths, ['docs/notes.md']);
  });

  it('rejects an honest record whose derived output is not what the tree contains', () => {
    const fixture = derive();
    // The record is untouched and re-derives perfectly. The tree does not match
    // it: this is somebody deriving a patch and then committing something else.
    write(fixture.head, 'docs/notes.md', 'release v9.9.9 shipped\n');

    const verdict = verify(fixture);

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, VERIFY_REASONS.HEAD_MISMATCH);
    // Everything up to the tree comparison passed, which is exactly why that
    // last check has to exist.
    assert.deepEqual(verdict.checks, ['record_integrity', 'base_inputs', 'rederivation']);
  });

  it('rejects a record whose claimed hash was edited', () => {
    const fixture = derive();
    fixture.record = { ...fixture.record, derivationHash: 'a'.repeat(64) };

    const verdict = verify(fixture);

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, VERIFY_REASONS.RECORD_TAMPERED);
  });

  it('rejects a record whose operation was swapped for a different one', () => {
    const fixture = derive();
    fixture.record = {
      ...fixture.record,
      operation: { ...fixture.record.operation, replace: 'v6.6.6' },
    };

    const verdict = verify(fixture);

    assert.equal(verdict.ok, false);
    // Editing the operation breaks the record's own hash first, which is the
    // earliest honest answer: the record no longer describes itself.
    assert.equal(verdict.reason, VERIFY_REASONS.RECORD_TAMPERED);
  });

  it('reports a base tree that is not what the transform ran against', () => {
    const fixture = derive();
    write(fixture.base, 'docs/notes.md', 'a completely different starting point\n');

    const verdict = verify(fixture);

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, VERIFY_REASONS.BASE_INPUT_MISMATCH);
    assert.match(verdict.detail, /docs\/notes\.md/u);
  });

  it('reports a missing base file rather than treating it as empty', () => {
    const fixture = derive();
    fs.rmSync(path.join(fixture.base, 'docs/notes.md'));

    const verdict = verify(fixture);

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, VERIFY_REASONS.BASE_INPUT_MISMATCH);
    assert.match(verdict.detail, /absent/u);
  });

  it('says a v1 record is unverifiable rather than calling it wrong', () => {
    const fixture = derive();
    fixture.record = { ...fixture.record, schemaVersion: 'huqan-derivation-v1' };

    const verdict = verify(fixture);

    assert.equal(verdict.ok, false);
    // Changing the schema also breaks the hash, so the integrity check speaks
    // first. What matters is that neither answer claims the code is wrong.
    assert.ok(
      [VERIFY_REASONS.RECORD_TAMPERED, VERIFY_REASONS.SCHEMA_NOT_REDERIVABLE].includes(verdict.reason),
      `unexpected reason ${verdict.reason}`,
    );
  });

  it('refuses a refused derivation, which never claimed a patch', () => {
    const head = makeRoot();
    const base = makeRoot();
    write(head, 'docs/notes.md', 'v1.0.0 and again v1.0.0\n');
    write(base, 'docs/notes.md', 'v1.0.0 and again v1.0.0\n');

    const refused = applyDerivation({ task: task(), root: head, repoState: CLEAN_BRANCH });
    assert.equal(refused.ok, false);

    const verdict = verifyDerivation({
      record: refused.record,
      readBase: directoryReader(base),
      readHead: directoryReader(head),
    });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, VERIFY_REASONS.NOT_A_COMPLETED_DERIVATION);
  });

  it('does not read outside the tree for a path that escapes it', () => {
    const base = makeRoot();
    const outside = makeRoot();
    write(outside, 'secret.txt', 'not yours\n');

    const read = directoryReader(base);

    assert.equal(read('../' + path.basename(outside) + '/secret.txt'), null);
  });
});
