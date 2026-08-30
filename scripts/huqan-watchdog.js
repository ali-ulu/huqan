#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { createAuditJournal, createRuntimeWatchdog } = require('../lib/runtime-watchdog');

function defaultAuditPath(environment = process.env) {
  const base = environment.LOCALAPPDATA || environment.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'HUQAN', 'watchdog-audit.jsonl');
}

function bindHumanApprovalConsole({ watchdog, input = process.stdin, output = process.stdout } = {}) {
  if (!watchdog || typeof watchdog.approveAndShutdown !== 'function') throw new TypeError('watchdog is required');
  if (!input.isTTY || !output.isTTY) return Object.freeze({ bound: false, close() {} });

  let buffer = '';
  let state = 'command';
  function prompt(text) { output.write(text); }
  function onLine(rawLine) {
    const line = rawLine.trim();
    if (state === 'command') {
      if (line !== 'shutdown') {
        if (line) prompt('Bilinmeyen komut. Kapatma için shutdown yazın.\nwatchdog> ');
        return;
      }
      state = 'confirm';
      prompt('İnsan onayı için ONAYLIYORUM yazın: ');
      return;
    }
    if (state === 'confirm') {
      if (line !== 'ONAYLIYORUM') {
        watchdog.denyShutdown('interactive human confirmation rejected');
        state = 'command';
        prompt('Kapatma reddedildi.\nwatchdog> ');
        return;
      }
      state = 'identity';
      prompt('Onaylayan kişi: ');
      return;
    }
    if (!line) {
      watchdog.denyShutdown('human identity missing');
      state = 'command';
      prompt('Kapatma reddedildi.\nwatchdog> ');
      return;
    }
    state = 'consumed';
    watchdog.approveAndShutdown({ approvedBy: line, approvalId: crypto.randomUUID() });
  }

  function onData(chunk) {
    buffer += chunk.toString('utf8');
    for (;;) {
      const boundary = buffer.search(/\r?\n/);
      if (boundary < 0) break;
      const hasCrLf = buffer[boundary] === '\r';
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (hasCrLf ? 2 : 1));
      onLine(line);
    }
  }

  input.on('data', onData);
  input.resume();
  prompt('Kapatma için shutdown yazın.\nwatchdog> ');
  return Object.freeze({ bound: true, close() { input.off('data', onData); input.pause(); } });
}

async function main({ environment = process.env, input = process.stdin, output = process.stdout } = {}) {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const port = String(environment.PORT || '3000');
  const auditPath = environment.HUQAN_WATCHDOG_AUDIT_PATH || defaultAuditPath(environment);
  const audit = createAuditJournal({ auditPath: path.resolve(auditPath) });
  let consoleBinding = null;
  const watchdog = createRuntimeWatchdog({
    serverPath,
    healthUrl: `http://127.0.0.1:${port}/health`,
    audit,
    environment,
    onTerminal: ({ exitCode }) => {
      consoleBinding?.close();
      process.exitCode = exitCode;
    },
  });

  process.on('SIGINT', () => watchdog.denyShutdown('SIGINT is not human approval; type shutdown in the watchdog console'));
  process.on('SIGTERM', () => watchdog.denyShutdown('SIGTERM cannot authorize shutdown; type shutdown in the watchdog console'));

  watchdog.start();
  output.write(`HUQAN watchdog active. Audit: ${audit.inspect().auditPath}\n`);
  consoleBinding = bindHumanApprovalConsole({ watchdog, input, output });
  return watchdog;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`HUQAN watchdog failed closed: ${error.code || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { bindHumanApprovalConsole, defaultAuditPath, main };
