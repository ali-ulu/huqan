'use strict';

const { spawnSync } = require('node:child_process');
const { runDeclaredTest } = require('./test-execution');
const { verifyProjectInitialization } = require('./project-initialization-permission');

// Fixed native verification: caller-provided verify/fs/spawn cannot certify init.
function verifyProject({ root, record }) {
  try {
    const preflight = verifyProjectInitialization({ root, record });
    if (!preflight.ok) return { ok: false, reason: preflight.reason,
      test: { ran: false, ok: false, exitCode: null, reason: preflight.reason } };
  } catch {
    return { ok: false, reason: 'PROJECT_PREFLIGHT_FAILED',
      test: { ran: false, ok: false, exitCode: null, reason: 'PROJECT_PREFLIGHT_FAILED' } };
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const test = runDeclaredTest({ root, test: { command: 'node --test test/api.test.js' },
    spawn: (command, args, configuration) => spawnSync(command, args, { ...configuration, env }) });
  if (!test.ok) return { ok: false, reason: test.reason, test };
  try {
    const independent = verifyProjectInitialization({ root, record });
    return { ok: independent.ok, reason: independent.reason || null,
      test: independent.ok ? test : { ...test, ok: false, reason: independent.reason }, independent };
  } catch {
    return { ok: false, reason: 'PROJECT_INDEPENDENT_VERIFICATION_FAILED',
      test: { ...test, ok: false, reason: 'PROJECT_INDEPENDENT_VERIFICATION_FAILED' } };
  }
}

module.exports = { verifyProject };
