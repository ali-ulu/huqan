'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI_PATH = path.resolve(__dirname, '..', 'cli.js');

function runCli(args, envOverrides = {}) {
  const result = cp.spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, ...envOverrides },
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function hasScriptPty() {
  if (process.platform !== 'linux') return false;
  return cp.spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
}

const posixQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// Runs `approve` inside a pty and types the approval id back, as the operator would.
function approveAtTerminal(approvalId, envOverrides) {
  const command = [process.execPath, CLI_PATH, 'approve', approvalId, 'approved'].map(posixQuote).join(' ');
  const result = cp.spawnSync('script', ['-qec', command, '/dev/null'], {
    env: { ...process.env, ...envOverrides },
    encoding: 'utf8',
    input: `${approvalId}\n`,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

test('cli.js dogfood client runs a real out-of-process ask and gets a graph-backed answer', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-dogfood-'));
  const env = {
    AXIOM_DB_PATH: path.join(tempDir, 'memory.db'),
    AXIOM_MEMORY_PATH: path.join(tempDir, 'memory.json'),
  };
  try {
    const askBefore = runCli(['sor', 'kopek nedir'], env);
    assert.equal(askBefore.status, 0);
    assert.match(askBefore.stdout, /Bilmiyorum|Cevap/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cli.js dogfood client routes öğret through the review gate as a real child process', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-dogfood-learn-'));
  const env = {
    AXIOM_DB_PATH: path.join(tempDir, 'memory.db'),
    AXIOM_MEMORY_PATH: path.join(tempDir, 'memory.json'),
  };
  try {
    const learnResult = runCli(['learn:', 'kopek dogfood-sentinel hayvandir'], env);
    // Unapproved learn commands are review-gated, exactly like the MCP dogfood
    // harness's axiom.learn review-path assertion -- cli.js is a real
    // out-of-process client subject to the same trust boundary, not an
    // in-process shortcut around it. The code is review_required (5). Plain
    // text used to leave 3 here, which is capability_not_available in the one
    // exit-code table -- a different outcome entirely (#1995).
    assert.equal(learnResult.status, 5);
    assert.match(learnResult.stdout, /requires review/);
    const approvalId = learnResult.stdout.match(/approval-[0-9a-f-]+/)?.[0];
    assert.ok(approvalId, 'learn must return the durable approval id');

    const approvals = runCli(['approvals'], env);
    assert.equal(approvals.status, 0);
    assert.match(approvals.stdout, new RegExp(approvalId));

    const askAfter = runCli(['sor', 'kopek nedir'], env);
    assert.equal(askAfter.status, 0);
    assert.doesNotMatch(askAfter.stdout, /dogfood-sentinel/);

    // #3560: a child process has no terminal, so deciding the approval is
    // refused (exit 4) and the fact stays out of canonical state.
    const refused = runCli(['approve', approvalId, 'approved'], env);
    assert.equal(refused.status, 4);
    assert.match(`${refused.stdout}${refused.stderr}`, /operator_terminal_required/);
    const stillUnverified = runCli(['verify:', 'kopek dogfood-sentinel hayvandir'], env);
    assert.doesNotMatch(stillUnverified.stdout, /Verify: verified/);

    // The operator at a terminal: a pty where util-linux `script` exists.
    if (!hasScriptPty()) return;
    const approved = approveAtTerminal(approvalId, env);
    assert.equal(approved.status, 0, approved.stdout + approved.stderr);
    assert.match(approved.stdout, /written to canonical state/);

    const verified = runCli(['verify:', 'kopek dogfood-sentinel hayvandir'], env);
    assert.equal(verified.status, 0);
    assert.match(verified.stdout, /Verify: verified/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
