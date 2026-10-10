'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runRepositoryScan,
  validateScanOptions,
} = require('../lib/self-healer/repository-scan');
const { listFilesWithinRoot } = require('../lib/safe-file-walk');

const CONFLICT_SOURCE = [
  'function a() { return 1; }',
  '<<<<<<< HEAD',
  'const x = 2;',
  '=======',
  'const x = 3;',
  '>>>>>>> other',
].join('\n');

const KEY_SOURCE = [
  'const key = `',
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEogIBAAKCAQEA...',
  '-----END RSA PRIVATE KEY-----',
  '`;',
].join('\n');

function write(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe('self-healer repository scan (SH-2)', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh2-scan-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('turns real file observations into classified findings', () => {
    write(root, 'src/half-merged.js', CONFLICT_SOURCE);
    write(root, 'src/clean.js', 'module.exports = 1;\n');

    const result = runRepositoryScan({ workspaceId: 'default', repoRoot: root });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'audit_only');
    assert.equal(result.findingCount, 1);
    const [finding] = result.findings;
    assert.equal(finding.kind, 'bug');
    assert.equal(finding.status, 'candidate');
    assert.deepEqual(finding.affectedFiles, ['src/half-merged.js']);
    assert.ok(finding.findingId.startsWith('finding_'));
    assert.equal(finding.evidence[0].type, 'file');
  });

  it('flags an unresolved conflict marker once, not once per marker line', () => {
    write(root, 'src/three-ways.js', CONFLICT_SOURCE);
    const result = runRepositoryScan({ workspaceId: 'default', repoRoot: root });
    assert.equal(result.findingCount, 1);
  });

  it('flags a deferred-work marker only when it opens a note', () => {
    write(root, 'src/marked.js', '// TODO: revisit this branch\nconst y = 1;\n');
    write(root, 'src/prose.js', '// this mentions the word TODO in passing\n');
    const result = runRepositoryScan({ workspaceId: 'default', repoRoot: root });
    assert.equal(result.findingCount, 1);
    assert.deepEqual(result.findings[0].affectedFiles, ['src/marked.js']);
  });

  it('flags private key material outside tests and ignores it under tests', () => {
    write(root, 'src/leaked-key.js', KEY_SOURCE);
    write(root, 'test/fixture-key.test.js', KEY_SOURCE);
    write(root, 'fixtures/key.js', KEY_SOURCE);
    const result = runRepositoryScan({ workspaceId: 'default', repoRoot: root });
    assert.equal(result.findingCount, 1);
    assert.equal(result.findings[0].kind, 'security');
    assert.equal(result.findings[0].severity, 'high');
    assert.deepEqual(result.findings[0].affectedFiles, ['src/leaked-key.js']);
  });

  it('prunes heavy directories instead of walking them', () => {
    write(root, 'node_modules/pkg/bad.js', CONFLICT_SOURCE);
    write(root, '.git/hooks/bad.js', CONFLICT_SOURCE);
    write(root, 'src/clean.js', 'module.exports = 1;\n');
    const result = runRepositoryScan({ workspaceId: 'default', repoRoot: root });
    assert.equal(result.findingCount, 0);
    assert.equal(result.filesScanned, 1);
  });

  it('is bounded by maxFindings', () => {
    for (let i = 0; i < 5; i += 1) write(root, `src/conflict-${i}.js`, CONFLICT_SOURCE);
    const result = runRepositoryScan({ workspaceId: 'default', repoRoot: root, maxFindings: 2 });
    assert.equal(result.findingCount, 2);
    assert.equal(result.truncated, true);
  });

  it('skips files above maxFileBytes', () => {
    write(root, 'src/big.js', `${CONFLICT_SOURCE}\n${'x'.repeat(4096)}`);
    const result = runRepositoryScan({ workspaceId: 'default', repoRoot: root, maxFileBytes: 64 });
    assert.equal(result.findingCount, 0);
    assert.equal(result.filesScanned, 0);
  });

  it('is deterministic: identical input yields identical finding ids in id order', () => {
    write(root, 'src/a.js', CONFLICT_SOURCE);
    write(root, 'src/b.js', '// FIXME(bug) fix me\n');
    const first = runRepositoryScan({ workspaceId: 'default', repoRoot: root });
    const second = runRepositoryScan({ workspaceId: 'default', repoRoot: root });
    assert.deepEqual(
      first.findings.map((f) => f.findingId),
      second.findings.map((f) => f.findingId),
    );
    const ids = first.findings.map((f) => f.findingId);
    assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('reads only: no write, unlink, rename, or mkdir during a scan', () => {
    write(root, 'src/half-merged.js', CONFLICT_SOURCE);
    write(root, 'src/leaked-key.js', KEY_SOURCE);

    const originals = {
      writeFileSync: fs.writeFileSync,
      appendFileSync: fs.appendFileSync,
      writeFile: fs.writeFile,
      unlinkSync: fs.unlinkSync,
      rmSync: fs.rmSync,
      rmdirSync: fs.rmdirSync,
      renameSync: fs.renameSync,
      mkdirSync: fs.mkdirSync,
      createWriteStream: fs.createWriteStream,
    };
    let mutations = 0;
    const guard = () => { mutations += 1; throw new Error('scan attempted a write'); };
    for (const name of Object.keys(originals)) fs[name] = guard;

    let result;
    try {
      result = runRepositoryScan({ workspaceId: 'default', repoRoot: root });
    } finally {
      for (const [name, fn] of Object.entries(originals)) fs[name] = fn;
    }

    assert.equal(mutations, 0);
    assert.equal(result.findingCount, 2);
  });

  it('rejects a relative or traversing repoRoot', () => {
    assert.equal(validateScanOptions({ repoRoot: 'relative/path' }).ok, false);
    assert.equal(validateScanOptions({ repoRoot: '/safe/../etc' }).ok, false);
    assert.equal(validateScanOptions({ repoRoot: '/safe/repo' }).ok, true);
    assert.throws(
      () => runRepositoryScan({ workspaceId: 'default', repoRoot: 'relative/path' }),
      /Invalid scan options/,
    );
  });

  it('rejects a non-positive limit', () => {
    assert.equal(validateScanOptions({ repoRoot: root, maxFindings: 0 }).ok, false);
    assert.equal(validateScanOptions({ repoRoot: root, maxFileBytes: -1 }).ok, false);
  });
});

describe('safe-file-walk pruneDirectory option', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh2-walk-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never descends into a pruned directory', () => {
    write(root, 'src/keep.js', 'x');
    write(root, 'skip/ignored.js', 'x');

    const walked = listFilesWithinRoot(root, {
      rootPath: root,
      matchesFile: (file) => file.endsWith('.js'),
      pruneDirectory: (name) => name === 'skip',
    });

    assert.deepEqual(walked.map((file) => path.relative(root, file)), ['src/keep.js']);
  });

  it('walks every directory when pruneDirectory is omitted', () => {
    write(root, 'src/keep.js', 'x');
    write(root, 'skip/ignored.js', 'x');

    const walked = listFilesWithinRoot(root, {
      rootPath: root,
      matchesFile: (file) => file.endsWith('.js'),
    });

    assert.deepEqual(
      walked.map((file) => path.relative(root, file)).sort(),
      ['skip/ignored.js', 'src/keep.js'],
    );
  });
});
