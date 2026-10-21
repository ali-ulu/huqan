'use strict';

/**
 * The JSON-lines health probe behind the doctor's Rust-accelerator and MCP
 * checks (#3018 family): spawn a child, write newline-delimited JSON requests,
 * collect newline-delimited JSON answers, fail bounded. Extracted from
 * cli-doctor.js so the checker stays inside its architecture line band; the
 * behaviour is unchanged, including the 4s default timeout and the
 * DOCTOR_PROBE_TIMEOUT error code.
 */

const { spawn } = require('node:child_process');

const DEFAULT_PROBE_TIMEOUT_MS = 4000;

function probeJsonLines(command, args, requests, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS;
  const spawnImpl = opts.spawnImpl || spawn;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let stderr = '';
    const responses = [];
    let child;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) {
        try { child.stdin.end(); } catch (_) {}
        try { child.kill(); } catch (_) {}
      }
      if (error) reject(error);
      else resolve({ responses, stderr });
    };

    try {
      child = spawnImpl(command, args, {
        cwd: opts.cwd || process.cwd(),
        env: opts.env || process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      const error = new Error(`health probe timed out after ${timeoutMs}ms`);
      error.code = 'DOCTOR_PROBE_TIMEOUT';
      finish(error);
    }, timeoutMs);

    child.on('error', finish);
    child.on('exit', (code, signal) => {
      if (!settled && responses.length < requests.length) {
        finish(new Error(`health probe exited early (code=${code}, signal=${signal || 'none'}): ${stderr.trim()}`));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { responses.push(JSON.parse(line)); } catch (_) { continue; }
        if (responses.length >= requests.length) {
          finish();
          return;
        }
      }
    });

    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
  });
}

module.exports = {
  DEFAULT_PROBE_TIMEOUT_MS,
  probeJsonLines,
};
