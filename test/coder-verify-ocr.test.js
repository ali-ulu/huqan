'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OCR_COMMAND, classifyOcrOutput, createOcrVerifier } = require('../lib/coder/verify-ocr');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { DERIVATION_OUTCOMES, verifyDerivationHash } = require('../lib/coder/derivation-record');
const { parseCoderArgs, formatCoderText, runCliCoder } = require('../lib/cli-coder');

const SCOPE = { paths: ['docs/notes.md'] };

function comment(pathValue, severity) {
  return { path: pathValue, content: 'x', start_line: 1, end_line: 1, severity };
}

function complete(comments, extra = {}) {
  return { status: 'success', comments, manifest: { terminal_state: 'complete' }, session_id: 's-1', ...extra };
}

function fakeSpawn(result) {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
  return { spawnSync, calls };
}

function makeRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-3196-')));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/notes.md'), 'release v1.0.0 shipped\n', 'utf8');
  return root;
}

function docsTask() {
  return {
    id: 'task-3196',
    level: 'l0',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
  };
}

const CLEAN_BRANCH = { branch: 'feat/3196', dirty: false, hasUntracked: false };

describe('issue #3196 classifyOcrOutput', () => {
  it('a complete run with no blocking finding on the change is ok', () => {
    const result = classifyOcrOutput(complete([comment('docs/notes.md', 'low')]), SCOPE);
    assert.equal(result.ok, true);
    assert.equal(result.command, OCR_COMMAND);
    assert.equal(result.evidenceRef, 'findings: 0 blocking of 1 on the change; session s-1');
  });

  it('a critical or high finding on the change is a finding, not unverifiable', () => {
    const result = classifyOcrOutput(complete([
      comment('docs/notes.md', 'HIGH'),
      comment('docs/notes.md', 'critical'),
      comment('docs/notes.md', 'medium'),
    ]), SCOPE);
    assert.equal(result.ok, false);
    assert.match(result.evidenceRef, /^findings: 2 blocking \(critical\/high\) of 3 on the change/);
  });

  it('ignores findings on files the derivation did not write', () => {
    const result = classifyOcrOutput(complete([comment('lib/other.js', 'critical')]), SCOPE);
    assert.equal(result.ok, true);
    assert.equal(result.evidenceRef, 'findings: 0 blocking of 0 on the change; session s-1');
  });

  it('matches Windows-style and ./ prefixed paths against the task scope', () => {
    const result = classifyOcrOutput(complete([comment('.\\docs\\notes.md', 'high')]), SCOPE);
    assert.equal(result.ok, false);
    assert.match(result.evidenceRef, /^findings: 1 blocking/);
  });

  it('honours a custom blocking set', () => {
    const result = classifyOcrOutput(complete([comment('docs/notes.md', 'medium')]), {
      ...SCOPE, blockingSeverities: ['medium'],
    });
    assert.equal(result.ok, false);
  });

  it('a skipped run is unverifiable, never a pass', () => {
    const result = classifyOcrOutput({ status: 'skipped', comments: [], message: 'No supported files changed.' }, SCOPE);
    assert.equal(result.ok, false);
    assert.match(result.evidenceRef, /^unverifiable: ocr selected no reviewable file/);
  });

  it('a failed run is unverifiable even when the envelope says success', () => {
    const output = complete([], { manifest: { terminal_state: 'failed' }, message: 'Review failed: 0 finding(s)' });
    const result = classifyOcrOutput(output, SCOPE);
    assert.equal(result.ok, false);
    assert.match(result.evidenceRef, /^unverifiable: ocr review failed — Review failed/);
  });

  it('a partial run with no blocking finding is unverifiable', () => {
    const result = classifyOcrOutput(complete([], { manifest: { terminal_state: 'partial' } }), SCOPE);
    assert.equal(result.ok, false);
    assert.match(result.evidenceRef, /^unverifiable: ocr covered the change only partially/);
  });

  it('a partial run that still found a blocker reports the finding', () => {
    const output = complete([comment('docs/notes.md', 'high')], { manifest: { terminal_state: 'partial' } });
    assert.match(classifyOcrOutput(output, SCOPE).evidenceRef, /^findings: 1 blocking/);
  });

  it('rejects a non-object output as unverifiable', () => {
    assert.match(classifyOcrOutput(null, SCOPE).evidenceRef, /^unverifiable: ocr output is not a JSON object/);
    assert.match(classifyOcrOutput([], SCOPE).evidenceRef, /^unverifiable:/);
  });
});

describe('issue #3196 createOcrVerifier', () => {
  it('runs ocr review in the task root with fixed JSON arguments', () => {
    const fake = fakeSpawn({ status: 0, stdout: JSON.stringify(complete([])), stderr: '' });
    const verify = createOcrVerifier({ spawnSync: fake.spawnSync, platform: 'linux', timeoutMs: 1234 });
    const result = verify('/repo', docsTask());
    assert.equal(result.ok, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].command, 'ocr');
    assert.deepEqual(fake.calls[0].args, ['review', '--format', 'json', '--audience', 'agent']);
    assert.equal(fake.calls[0].options.cwd, '/repo');
    assert.equal(fake.calls[0].options.timeout, 1234);
    assert.equal(fake.calls[0].options.shell, false);
  });

  it('goes through the shell on Windows, where ocr is an npm .cmd shim', () => {
    const fake = fakeSpawn({ status: 0, stdout: JSON.stringify(complete([])), stderr: '' });
    createOcrVerifier({ spawnSync: fake.spawnSync, platform: 'win32' })('C:\\repo', docsTask());
    assert.equal(fake.calls[0].options.shell, true);
  });

  it('a missing binary is unverifiable, not a finding', () => {
    const error = Object.assign(new Error('spawnSync ocr ENOENT'), { code: 'ENOENT' });
    const verify = createOcrVerifier({ spawnSync: fakeSpawn({ error }).spawnSync, platform: 'linux' });
    const result = verify('/repo', docsTask());
    assert.equal(result.ok, false);
    assert.equal(result.evidenceRef, 'unverifiable: ocr unavailable — spawnSync ocr ENOENT');
  });

  it('a timeout is unverifiable and names the limit', () => {
    const error = Object.assign(new Error('spawnSync ocr ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const verify = createOcrVerifier({ spawnSync: fakeSpawn({ error }).spawnSync, platform: 'linux', timeoutMs: 50 });
    assert.equal(verify('/repo', docsTask()).evidenceRef, 'unverifiable: ocr timed out after 50 ms');
  });

  it('no configured LLM (non-JSON exit) is unverifiable and keeps the reason', () => {
    const stderr = 'Error: resolve LLM endpoint: no valid LLM endpoint configured\nmore';
    const verify = createOcrVerifier({ spawnSync: fakeSpawn({ status: 1, stdout: '', stderr }).spawnSync, platform: 'linux' });
    assert.equal(
      verify('/repo', docsTask()).evidenceRef,
      'unverifiable: ocr exited 1 without a JSON result — Error: resolve LLM endpoint: no valid LLM endpoint configured',
    );
  });

  it('a task without allowedPaths counts no finding as its own', () => {
    const stdout = JSON.stringify(complete([comment('docs/notes.md', 'critical')]));
    const verify = createOcrVerifier({ spawnSync: fakeSpawn({ status: 0, stdout, stderr: '' }).spawnSync, platform: 'linux' });
    assert.equal(verify('/repo', {}).ok, true);
  });
});

describe('issue #3196 OCR verification beside the derivation', () => {
  it('neither a finding nor an unverifiable run moves the derivationHash or the outcome', () => {
    const plain = applyDerivation({ task: docsTask(), root: makeRoot(), repoState: CLEAN_BRANCH });
    const withFinding = applyDerivation({
      task: docsTask(),
      root: makeRoot(),
      repoState: CLEAN_BRANCH,
      verify: createOcrVerifier({
        spawnSync: fakeSpawn({ status: 0, stdout: JSON.stringify(complete([comment('docs/notes.md', 'high')])) }).spawnSync,
      }),
      verifyCommand: OCR_COMMAND,
    });
    const unreachable = applyDerivation({
      task: docsTask(),
      root: makeRoot(),
      repoState: CLEAN_BRANCH,
      verify: createOcrVerifier({ spawnSync: fakeSpawn({ error: new Error('ENOENT') }).spawnSync }),
      verifyCommand: OCR_COMMAND,
    });

    for (const result of [withFinding, unreachable]) {
      assert.equal(result.outcome, DERIVATION_OUTCOMES.APPLIED);
      assert.equal(result.record.derivationHash, plain.record.derivationHash);
      assert.equal(verifyDerivationHash(result.record).ok, true);
      assert.equal(result.record.observedVerification.ran, true);
      assert.equal(result.record.observedVerification.ok, false);
      assert.equal(result.record.observedVerification.command, OCR_COMMAND);
    }
    assert.match(withFinding.record.observedVerification.evidenceRef, /^findings: 1 blocking/);
    assert.match(unreachable.record.observedVerification.evidenceRef, /^unverifiable: ocr unavailable/);
  });

  it('a dry run never calls ocr', () => {
    const fake = fakeSpawn({ status: 0, stdout: JSON.stringify(complete([])) });
    const result = applyDerivation({
      task: docsTask(), root: makeRoot(), repoState: CLEAN_BRANCH, dryRun: true,
      verify: createOcrVerifier({ spawnSync: fake.spawnSync }),
    });
    assert.equal(result.outcome, DERIVATION_OUTCOMES.DRY_RUN);
    assert.equal(fake.calls.length, 0);
  });
});

describe('issue #3196 coder CLI --verify', () => {
  it('parses --verify and keeps the task file', () => {
    const flags = parseCoderArgs(['task.json', '--verify', 'ocr', '--dry-run']);
    assert.equal(flags.taskFile, 'task.json');
    assert.equal(flags.verify, 'ocr');
    assert.equal(flags.dryRun, true);
    assert.equal(parseCoderArgs(['task.json']).verify, '');
  });

  it('refuses an unknown verifier before touching the tree', () => {
    assert.throws(
      () => runCliCoder(['does-not-exist.json', '--verify', 'npm-test']),
      (error) => error.exitCode === 1 && /Unknown verifier "npm-test"\. Available: ocr/.test(error.message),
    );
    assert.throws(() => runCliCoder(['does-not-exist.json', '--verify', 'toString']), /Unknown verifier "toString"/);
  });

  it('prints the observed verification only when one ran', () => {
    const base = applyDerivation({ task: docsTask(), root: makeRoot(), repoState: CLEAN_BRANCH });
    assert.doesNotMatch(formatCoderText(base, { known: true }), /Verified:/);

    const verified = applyDerivation({
      task: docsTask(), root: makeRoot(), repoState: CLEAN_BRANCH,
      verify: createOcrVerifier({ spawnSync: fakeSpawn({ status: 0, stdout: JSON.stringify(complete([])) }).spawnSync }),
    });
    assert.match(
      formatCoderText(verified, { known: true }),
      /Verified: {3}ok — findings: 0 blocking of 0 on the change; session s-1/,
    );
  });
});
