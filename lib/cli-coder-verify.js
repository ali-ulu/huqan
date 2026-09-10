'use strict';

/**
 * `coder verify` — re-derive a recorded derivation and report whether the tree
 * under review actually contains its output.
 *
 *   coder verify <record.json> [--base <git-ref>] [--base-dir <dir>] [--root <dir>]
 *
 * The point of this command is that it is run by somebody other than whoever
 * produced the patch. In CI that is the whole value: the reviewer is not taking
 * the record's word for anything, the transform runs again on the base commit
 * and the answer comes from that run.
 *
 * Base defaults to a git ref rather than a directory because that is what a
 * pull request checkout already has -- `git show <ref>:<path>` reads the
 * pre-change file without a second working tree.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const nodePath = require('node:path');

const { VERIFY_REASONS, directoryReader, verifyDerivation } = require('./coder/verify-derivation');

const DEFAULT_BASE_REF = 'origin/main';

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function parseVerifyArgs(tokens) {
  const flags = { recordFile: '', baseRef: '', baseDir: '', root: '' };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--base') { flags.baseRef = tokens[index + 1] || ''; index += 1; }
    else if (token === '--base-dir') { flags.baseDir = tokens[index + 1] || ''; index += 1; }
    else if (token === '--root') { flags.root = tokens[index + 1] || ''; index += 1; }
    else if (token === '--json') { /* handled by the caller via opts.json */ }
    else if (!flags.recordFile && !token.startsWith('--')) flags.recordFile = token;
  }
  return flags;
}

/**
 * Read a path as of a git ref. A file that did not exist at that ref is `null`,
 * not an error: "absent on the base side" is a legitimate state for a
 * transform that creates files, and the digest comparison handles it.
 */
function gitReader(root, ref) {
  return function read(relative) {
    try {
      return childProcess.execFileSync('git', ['show', `${ref}:${String(relative || '')}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
}

function readRecord(recordFile) {
  let raw;
  try {
    raw = fs.readFileSync(recordFile, 'utf8');
  } catch (error) {
    throw cliError(`Derivation record could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw cliError(`Derivation record is not valid JSON: ${error.message}`);
  }
}

function formatVerifyText(verdict, record, baseLabel) {
  const lines = [
    `Record:     ${record.recordHash || '(none)'}`,
    `Derivation: ${record.derivationHash || '(none)'}`,
    `Transform:  ${record.operationType || '(none)'} (catalog ${record.catalogVersion || '?'})`,
    `Base:       ${baseLabel}`,
    `Checks:     ${verdict.checks.length ? verdict.checks.join(' -> ') : '(none passed)'}`,
  ];
  if (verdict.ok) {
    lines.push('Result:     VERIFIED — the tree under review is what this transform derives');
    lines.push('');
    lines.push('Re-derived files:');
    for (const path of verdict.verifiedPaths) lines.push(`  ${path}`);
  } else {
    lines.push(`Result:     NOT VERIFIED — ${verdict.reason}`);
    if (verdict.detail) lines.push(`Detail:     ${verdict.detail}`);
  }
  return lines.join('\n');
}

function runCliCoderVerify(tokens, opts = {}) {
  const flags = parseVerifyArgs(tokens);
  if (!flags.recordFile) {
    throw cliError('Usage: coder verify <record.json> [--base <git-ref>] [--base-dir <dir>] [--root <dir>]');
  }

  const root = nodePath.resolve(flags.root || process.cwd());
  const record = readRecord(flags.recordFile);

  // A directory base is the local case; a git ref is the CI case. Both are
  // offered because a verifier with no git available is still a useful
  // verifier, and silently falling back between them would hide which tree
  // the answer actually came from.
  const usingDir = Boolean(flags.baseDir);
  const baseRef = flags.baseRef || DEFAULT_BASE_REF;
  const readBase = usingDir ? directoryReader(nodePath.resolve(flags.baseDir)) : gitReader(root, baseRef);
  const baseLabel = usingDir ? `directory ${nodePath.resolve(flags.baseDir)}` : `git ref ${baseRef}`;

  const verdict = verifyDerivation({ record, readBase, readHead: directoryReader(root) });

  if (opts.json) {
    return {
      status: verdict.ok ? 'completed' : 'failed',
      data: {
        verified: verdict.ok,
        reason: verdict.reason,
        detail: verdict.detail,
        checks: verdict.checks,
        base: baseLabel,
        derivationHash: verdict.derivationHash || record.derivationHash || '',
        verifiedPaths: verdict.verifiedPaths || [],
      },
    };
  }

  const report = formatVerifyText(verdict, record, baseLabel);
  // A failed verification has to leave a non-zero exit code, or CI would treat
  // "NOT VERIFIED" as a passing step. The report travels as the error message
  // so the reason is still what the operator reads, not a bare exit code.
  if (!verdict.ok) throw cliError(report);
  return report;
}

module.exports = {
  DEFAULT_BASE_REF,
  VERIFY_REASONS,
  gitReader,
  parseVerifyArgs,
  runCliCoderVerify,
};
