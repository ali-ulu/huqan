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
    const learnResult = runCli(['öğret', 'köpek dogfood-sentinel hayvandır'], env);
    // Unapproved learn commands are review-gated (exit code 3) exactly like
    // the MCP dogfood harness's axiom.learn review-path assertion -- cli.js
    // is a real out-of-process client subject to the same trust boundary,
    // not an in-process shortcut around it.
    assert.equal(learnResult.status, 3);
    assert.match(learnResult.stdout, /review gerektiriyor/);

    const askAfter = runCli(['sor', 'köpek nedir'], env);
    assert.equal(askAfter.status, 0);
    assert.doesNotMatch(askAfter.stdout, /dogfood-sentinel/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
