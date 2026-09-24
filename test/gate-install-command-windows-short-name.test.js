'use strict';

// #2838: unspaced() exists so a gate path with spaces can be recorded as its 8.3
// short name (#1797), because no quoted spelling of a hook command runs in both
// cmd.exe and PowerShell. Node's default argv quoting escapes the inner quotes of
// SHORT_NAME_COMMAND as `\"` before cmd.exe ever sees them, so cmd fails to parse
// the command and unspaced() silently returns the original, still-spaced path.
// windowsVerbatimArguments: true is what test/windows-short-name-real-directory.test.js
// already relies on for the same `for %I in (...) do @echo %~sI` shape; this test
// pins that unspaced() itself gets a real short name back, on a real directory.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, after } = require('node:test');

const { unspaced } = require('../lib/external-action-gate-install-command');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-unspaced-'));
const spacedDirectory = path.join(base, 'a directory with spaces');
fs.mkdirSync(spacedDirectory);
const spacedTarget = path.join(spacedDirectory, 'huqan-gate-hook.js');
fs.writeFileSync(spacedTarget, 'long-path');

after(() => fs.rmSync(base, { recursive: true, force: true }));

describe('unspaced() on a real path that contains a space', { skip: process.platform !== 'win32' ? 'short names exist only on Windows' : false }, () => {
  it('returns a short name with no space, pointing at the same file', () => {
    const short = unspaced(spacedTarget);
    assert.notEqual(short, spacedTarget);
    assert.equal(/\s/.test(short), false);
    fs.appendFileSync(short, ':short-path');
    assert.equal(fs.readFileSync(spacedTarget, 'utf8'), 'long-path:short-path');
  });
});

describe('unspaced() outside Windows', { skip: process.platform === 'win32' ? 'this is the non-Windows branch' : false }, () => {
  it('returns the target unchanged', () => {
    assert.equal(unspaced(spacedTarget), spacedTarget);
  });
});
