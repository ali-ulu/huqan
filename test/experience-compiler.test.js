'use strict';

/**
 * Experience Phase 6 — procedure compiler tests (#2392).
 *
 * Hermetic: injected fakes only, no I/O, no storage, no timers.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compile, qualify, specializeRenameSequence, bindRenameQualification } = require('../lib/experience/compiler');

function candidate(overrides = {}) {
  return {
    status: 'candidate',
    runId: 'run-1',
    trace: { sources: ['hash-abc'], scope: { workspaceId: 'ws' }, revision: 'e1' },
    ...overrides,
  };
}

it('compiles a bounded immutable rename sequence and qualifies every file atomically', () => {
  const steps = [{ path: 'src/a.js', from: 'oldName', to: 'newName' },
    { path: 'src/b.js', from: 'oldName', to: 'newName' }];
  const compiled = compile({ candidate: candidate(), kind: 'rename_sequence', params: { steps } });
  assert.equal(compiled.ok, true);
  steps[0].to = 'tampered';
  assert.equal(compiled.procedure.params.steps[0].to, 'newName');
  assert.ok(Object.isFrozen(compiled.procedure.params.steps));
  const files = { 'src/a.js': 'const oldName = 1; // oldName',
    'src/b.js': 'module.exports = oldName; const text = "oldName";', 'src/untouched.js': '// unchanged' };
  const { renameIdentifier } = require('../lib/task-identifier-lexer');
  const apply = procedure => {
    const next = { ...files };
    for (const step of procedure.params.steps) next[step.path] = renameIdentifier(next[step.path], step.from, step.to).source;
    return { files: next };
  };
  const options = { procedure: compiled.procedure, inputs: ['holdout'], observe: () => files, apply };
  assert.equal(qualify(options).qualified, true);
  assert.equal(qualify({ ...options, apply: () => ({ files: { ...files, 'src/a.js': 'const newName = 1; // oldName' } }) }).code,
    'qualify_rejected:postcondition');
  assert.equal(qualify({ ...options, apply: procedure => ({ files: { ...apply(procedure).files, 'src/untouched.js': 'modified' } }) }).code,
    'qualify_rejected:postcondition');
  assert.equal(qualify({ ...options, observe: () => ({ ...files, 'src/b.js': 'const newName = 2; oldName;' }) }).code,
    'qualify_rejected:ambiguous');
  assert.equal(qualify({ ...options, observe: () => ({ ...files, 'src/b.js': '// oldName' }) }).code,
    'qualify_rejected:drift');
  for (const invalid of [[], Array(2), [steps[0], steps[0]], [{ ...steps[0], path: '../escape.js' }, steps[1]]])
    assert.equal(compile({ candidate: candidate(), kind: 'rename_sequence', params: { steps: invalid } }).code, 'bad_params');
});

it('binds a learned rename sequence to unseen paths with parent identity and fresh atomic qualification', () => {
  const source = compile({ candidate: candidate(), kind: 'rename_sequence', params: { steps: [
    { path: 'src/a.js', from: 'oldName', to: 'newName' },
    { path: 'src/b.cjs', from: 'oldName', to: 'newName' }] } }).procedure;
  const paths = ['other/export.cjs', 'other/use.js'];
  const child = specializeRenameSequence({ procedure: source, targetPaths: paths });
  assert.equal(child.ok, true);
  assert.equal(child.procedure.parentHash, source.hash);
  assert.equal(child.procedure.version, source.version + 1);
  assert.notEqual(child.procedure.hash, source.hash);
  paths[0] = 'tampered.js';
  assert.equal(child.procedure.params.steps[0].path, 'other/export.cjs');
  assert.equal(source.params.steps[0].path, 'src/a.js');
  const files = { 'other/export.cjs': 'const oldName = 7; module.exports = oldName;',
    'other/use.js': 'module.exports = oldName; // oldName' };
  const { renameIdentifier } = require('../lib/task-identifier-lexer');
  const options = { procedure: child.procedure, inputs: ['unseen'], observe: () => files,
    apply: procedure => ({ files: Object.fromEntries(procedure.params.steps.map(step =>
      [step.path, renameIdentifier(files[step.path], step.from, step.to).source])) }) };
  assert.equal(qualify(options).qualified, true);
  assert.equal(qualify({ ...options, observe: () => ({ ...files, 'other/use.js': '// oldName' }) }).code,
    'qualify_rejected:drift');
  for (const targetPaths of [[], Array(2), ['same.js', 'same.js'], ['../escape.js', 'safe.js']])
    assert.equal(specializeRenameSequence({ procedure: source, targetPaths }).code, 'bad_params');
  let reads = 0;
  const getterPaths = ['safe.js', 'other.js'];
  Object.defineProperty(getterPaths, '0', { get() { reads += 1; return 'safe.js'; } });
  assert.equal(specializeRenameSequence({ procedure: source, targetPaths: getterPaths }).code, 'bad_params');
  assert.equal(reads, 0);
  assert.equal(specializeRenameSequence({ procedure: { ...source, hash: 'forged' },
    targetPaths: ['a.js', 'b.js'] }).code, 'procedure_binding_mismatch');
  const scope = {};
  Object.defineProperty(scope, 'workspaceId', { enumerable: true, get() { reads += 1; throw new Error('getter executed'); } });
  const cycle = {}; cycle.self = cycle;
  for (const metadata of [{ scope }, { scope: cycle }, { scope: new Proxy({}, {
    ownKeys() { reads += 1; throw new Error('proxy executed'); } }) },
  { evidenceRefs: [scope] }, { evidenceRefs: Array(2) }]) {
    assert.equal(specializeRenameSequence({ procedure: { ...source, ...metadata },
      targetPaths: ['a.js', 'b.js'] }).code, 'bad_params');
  }
  assert.equal(reads, 0);
  const renamed = specializeRenameSequence({ procedure: source, targetPaths: ['new/a.js', 'new/b.js'],
    identifierBindings: { oldName: 'beforeValue', newName: 'afterValue' } });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.procedure.params.steps[0].from, 'beforeValue');
  assert.equal(renamed.procedure.params.steps[1].to, 'afterValue');
  assert.notEqual(renamed.procedure.hash, child.procedure.hash);
  for (const identifierBindings of [null, { oldName: 'same', newName: 'same' },
    { oldName: 'invalid-name', newName: 'okay' }, scope, new Proxy({}, {})])
    assert.equal(specializeRenameSequence({ procedure: source, targetPaths: ['a.js', 'b.js'], identifierBindings }).code, 'bad_params');
  assert.equal(specializeRenameSequence({ procedure: source, targetPaths: ['a.js', 'b.js'],
    identifierBindings: { wrongName: 'a', newName: 'b' } }).code, 'binding_source_mismatch');
  assert.equal(reads, 0);
  const roleBound = specializeRenameSequence({ procedure: source, targetPaths: ['new/a.js', 'new/b.js'],
    rename: { from: 'beforeValue', to: 'afterValue' } });
  assert.equal(roleBound.procedure.hash, renamed.procedure.hash);
  for (const rename of [null, { from: 'same', to: 'same' }, { from: 'a', to: 'b', extra: true }, scope])
    assert.equal(specializeRenameSequence({ procedure: source, targetPaths: ['a.js', 'b.js'], rename }).code, 'bad_params');
  assert.equal(specializeRenameSequence({ procedure: source, targetPaths: ['a.js', 'b.js'],
    rename: { from: 'a', to: 'b' }, identifierBindings: { oldName: 'a', newName: 'b' } }).code, 'bad_params');
  const heterogeneous = compile({ candidate: candidate(), kind: 'rename_sequence', params: { steps: [
    { path: 'a.js', from: 'oldName', to: 'newName' }, { path: 'b.js', from: 'different', to: 'another' }] } }).procedure;
  assert.equal(specializeRenameSequence({ procedure: heterogeneous, targetPaths: ['c.js', 'd.js'],
    rename: { from: 'a', to: 'b' } }).code, 'binding_source_mismatch');
  assert.equal(reads, 0);
});

it('rebinds source qualification contexts atomically without cascading swapped identifiers or paths', () => {
  const source = compile({ candidate: candidate(), kind: 'rename_sequence', params: { steps: [
    { path: 'a.js', from: 'oldName', to: 'newName' },
    { path: 'b.js', from: 'oldName', to: 'newName' }] } }).procedure;
  const target = specializeRenameSequence({ procedure: source, targetPaths: ['b.js', 'a.js'],
    identifierBindings: { oldName: 'newName', newName: 'oldName' } }).procedure;
  const files = { 'a.js': 'oldName; newName; // oldName', 'b.js': 'oldName; "newName";', 'untouched.js': 'oldName;' };
  const snapshot = JSON.stringify(files);
  const bound = bindRenameQualification({ sourceProcedure: source, targetProcedure: target, files });
  assert.equal(bound.ok, true);
  assert.equal(bound.files['b.js'], 'newName; oldName; // oldName');
  assert.equal(bound.files['a.js'], 'newName; "newName";');
  assert.equal(bound.files['untouched.js'], 'oldName;');
  assert.equal(JSON.stringify(files), snapshot);
  assert.equal(bound.targetProcedureHash, target.hash);
  assert.equal(bindRenameQualification({ sourceProcedure: source, targetProcedure: { ...target, hash: 'forged' }, files }).code,
    'procedure_binding_mismatch');
  const collisionTarget = specializeRenameSequence({ procedure: source, targetPaths: ['untouched.js', 'other.js'] }).procedure;
  assert.equal(bindRenameQualification({ sourceProcedure: source, targetProcedure: collisionTarget, files }).code,
    'qualification_path_collision');
  assert.equal(bindRenameQualification({ sourceProcedure: source, targetProcedure: target,
    files: { 'a.js': 'oldName;' } }).code, 'bad_params');
  const { renameIdentifiers } = require('../lib/task-identifier-lexer');
  let reads = 0;
  const malicious = {};
  Object.defineProperty(malicious, 'oldName', { get() { reads += 1; return 'newName'; } });
  assert.throws(() => renameIdentifiers('oldName;', malicious), TypeError);
  assert.throws(() => renameIdentifiers('oldName;', new Proxy({}, {})), TypeError);
  assert.equal(reads, 0);
});

function params(overrides = {}) {
  return { path: 'a.txt', oldText: 'foo', newText: 'bar', ...overrides };
}

// Fake file world: apply replaces when exactly one site matches.
function fakeWorld(files) {
  return {
    observe: (input) => {
      if (!(input in files)) throw new Error('missing file');
      return files[input];
    },
    apply: (procedure, input) => {
      const content = files[input];
      const sites = content.split(procedure.params.oldText).length - 1;
      return { sites, after: content.split(procedure.params.oldText).join(procedure.params.newText) };
    },
  };
}

describe('Phase 6: compilation is typed and versioned', () => {
  it('compiles a traced candidate with immutable version and hash', () => {
    const res = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    assert.equal(res.ok, true);
    assert.equal(res.procedure.version, 1);
    assert.match(res.procedure.hash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(res.procedure.evidenceRefs, ['hash-abc']);
    assert.ok(Object.isFrozen(res.procedure));
  });

  it('new versions chain without touching the old', () => {
    const v1 = compile({ candidate: candidate(), kind: 'replace_text', params: params() }).procedure;
    const v2 = compile({
      candidate: candidate(), kind: 'replace_text', params: params({ newText: 'baz' }),
      parentVersion: 1,
    });
    // parentHash binds the chain; here the candidate carries no hash yet.
    assert.equal(v2.ok, true);
    assert.equal(v2.procedure.version, 2);
    assert.notEqual(v2.procedure.hash, v1.hash);
    assert.equal(v1.version, 1);
  });

  it('non-candidates, missing traces, bad params and kinds are refused', () => {
    assert.deepEqual(compile({ candidate: { status: 'draft' }, kind: 'replace_text', params: params() }),
      { ok: false, code: 'not_a_candidate' });
    assert.deepEqual(
      compile({ candidate: candidate({ trace: null }), kind: 'replace_text', params: params() }),
      { ok: false, code: 'missing_trace' });
    assert.deepEqual(compile({ candidate: candidate(), kind: 'replace_text', params: params({ oldText: '' }) }),
      { ok: false, code: 'bad_params' });
    assert.deepEqual(compile({ candidate: candidate(), kind: 'teleport', params: params() }),
      { ok: false, code: 'unknown_kind' });
  });
});

describe('Phase 6: qualification runs new inputs, never the source copy', () => {
  it('qualifies on held-out inputs that satisfy pre and postconditions', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const world = fakeWorld({ 'new-1.txt': 'foo x', 'new-2.txt': 'y foo' });
    const res = qualify({ procedure, inputs: ['new-1.txt', 'new-2.txt'], ...world });
    assert.equal(res.ok, true);
    assert.equal(res.qualified, true);
    assert.equal(res.procedureHash, procedure.hash);
  });

  it('ambiguous matches reject instead of guessing', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const world = fakeWorld({ 'amb.txt': 'foo foo' });
    const res = qualify({ procedure, inputs: ['amb.txt'], ...world });
    assert.equal(res.ok, false);
    assert.match(res.code, /^qualify_rejected:ambiguous$/u);
  });

  it('environment drift rejects instead of forcing', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const world = fakeWorld({ 'drift.txt': 'nothing here' });
    const res = qualify({ procedure, inputs: ['drift.txt'], ...world });
    assert.equal(res.ok, false);
    assert.match(res.code, /^qualify_rejected:drift$/u);
  });

  it('postcondition failures on held-out inputs reject', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const world = {
      observe: () => 'foo here',
      apply: () => ({ sites: 1, after: 'foo here' }),
    };
    const res = qualify({ procedure, inputs: ['stubborn.txt'], ...world });
    assert.equal(res.ok, false);
    assert.match(res.code, /^qualify_rejected:postcondition$/u);
  });

  it('throwing injectors become labelled rejections', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const res = qualify({
      procedure,
      inputs: ['x.txt'],
      observe: () => { throw new Error('disk gone'); },
      apply: () => ({}),
    });
    assert.deepEqual(res, { ok: false, code: 'injector_failed', reason: 'observe' });
  });
});
