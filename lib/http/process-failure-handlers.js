'use strict';

// Production Gate A item 1 (#2366): process-level failure must have an
// operator-readable reason and a deliberate exit. Node terminates on an
// un-awaited rejection / uncaught exception with no taxonomy log today
// (verified: zero unhandledRejection/uncaughtException handlers in runtime).
//
// Single responsibility: translate the two process events into the structured
// error taxonomy and exit non-zero. Never swallow: a silent handler is worse
// than the crash. Entry points (server.js, cli.js, mcpServer.js,
// bin/huqan-gate-hook.js) keep only thin wiring (ARCH-001).

const PROCESS_FAILURE_CODES = Object.freeze({
  UNHANDLED_REJECTION: 'PROCESS_UNHANDLED_REJECTION',
  UNCAUGHT_EXCEPTION: 'PROCESS_UNCAUGHT_EXCEPTION',
});

const PROCESS_FAILURE_EVENTS = Object.freeze({
  unhandledRejection: 'process.unhandled_rejection',
  uncaughtException: 'process.uncaught_exception',
});

function failureCodeFor(kind, cause) {
  const code = cause && typeof cause.code === 'string' ? cause.code.trim() : '';
  if (code && /^[A-Za-z0-9._:-]{1,128}$/.test(code)) return code;
  return kind === 'uncaughtException'
    ? PROCESS_FAILURE_CODES.UNCAUGHT_EXCEPTION
    : PROCESS_FAILURE_CODES.UNHANDLED_REJECTION;
}

function createProcessFailureHandlers({ logError, exit, target = process } = {}) {
  if (typeof logError !== 'function') throw new TypeError('logError is required');
  if (!target || typeof target.on !== 'function' || typeof target.removeListener !== 'function') {
    throw new TypeError('target with on/removeListener is required');
  }
  const exitFn = typeof exit === 'function'
    ? exit
    : (code) => {
      try {
        target.exitCode = code;
      } catch (_) {}
      target.exit(code);
    };

  let handling = false;

  function failAndExit(kind, cause) {
    if (handling) return;
    handling = true;
    try {
      logError(kind, cause);
    } catch (_) {
      // Logging must never suppress the deliberate exit below.
    }
    try {
      exitFn(1);
    } catch (_) {
      try {
        target.exit(1);
      } catch (_) {}
    }
  }

  function onUnhandledRejection(reason) {
    failAndExit('unhandledRejection', reason);
  }

  function onUncaughtException(error) {
    failAndExit('uncaughtException', error);
  }

  function bind() {
    target.on('unhandledRejection', onUnhandledRejection);
    target.on('uncaughtException', onUncaughtException);
    return Object.freeze({ uninstall });
  }

  function uninstall() {
    target.removeListener('unhandledRejection', onUnhandledRejection);
    target.removeListener('uncaughtException', onUncaughtException);
  }

  return Object.freeze({
    bind,
    uninstall,
    PROCESS_FAILURE_CODES,
    PROCESS_FAILURE_EVENTS,
  });
}

module.exports = {
  PROCESS_FAILURE_CODES,
  PROCESS_FAILURE_EVENTS,
  failureCodeFor,
  createProcessFailureHandlers,
};
