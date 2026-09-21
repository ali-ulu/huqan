'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function tempDir(t, prefix = 'huqan-fault-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function spawnFixture(name, args = [], options = {}) {
  return spawn(process.execPath, [path.join(__dirname, '..', '..', 'fixtures', 'faults', name), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
  });
}

function waitForLine(child, expected = 'READY', timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error('fixture timed out before readiness: ' + stderr)), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
    }

    function finish(error) {
      cleanup();
      if (error) reject(error);
      else resolve(stdout);
    }

    function onStdout(chunk) {
      stdout += chunk.toString('utf8');
      if (stdout.split(/\r?\n/).includes(expected)) finish();
    }

    function onStderr(chunk) {
      stderr += chunk.toString('utf8');
    }

    function onError(error) {
      finish(error);
    }

    function onExit(code, signal) {
      finish(new Error('fixture exited before readiness: code=' + code + ' signal=' + signal + ' stderr=' + stderr));
    }

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('fixture did not exit after fault injection'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

module.exports = { spawnFixture, tempDir, waitForExit, waitForLine };
