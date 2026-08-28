'use strict';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

function createGracefulShutdown({ server, closeResources, logError, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS }) {
  if (!server || typeof server.close !== 'function') throw new TypeError('server is required');
  if (typeof closeResources !== 'function') throw new TypeError('closeResources is required');
  if (typeof logError !== 'function') throw new TypeError('logError is required');

  let shutdownInProgress = false;
  function shutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    const forceExitTimer = setTimeout(() => {
      process.exitCode = 1;
      process.exit(1);
    }, timeoutMs);
    forceExitTimer.unref?.();

    const finish = () => {
      try {
        closeResources();
        process.exitCode = 0;
      } catch (error) {
        process.exitCode = 1;
        logError(signal, error);
      } finally {
        clearTimeout(forceExitTimer);
      }
    };

    if (server.listening) server.close(finish);
    else finish();
  }

  function bind() {
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }

  return Object.freeze({ bind, shutdown });
}

module.exports = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createGracefulShutdown,
};
