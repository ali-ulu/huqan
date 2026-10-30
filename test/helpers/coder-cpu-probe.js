'use strict';

/**
 * Child-process CPU/RSS probe for the G3 Coder cost measurement (#4416).
 *
 * Loaded into every Node process a paired run spawns via
 * `NODE_OPTIONS=--require <this file>`. It records its own `process.cpuUsage()`
 * and `resourceUsage()` at exit, so the total child CPU of a CLI run — the CLI
 * orchestration process plus every test process the coder spawns — is captured
 * without a new dependency and without a wrapper that could change behaviour.
 *
 * It is deliberately side-effect-light: one append to the JSONL named by
 * `HUQAN_CPU_LOG`. If that variable is unset or the append fails, the process
 * still exits normally, so the cost measurement can only ever lose CPU data
 * (fail-closed to `NOT_MEASURED` in the caller), never the run itself.
 */

const fs = require('node:fs');

const logPath = process.env.HUQAN_CPU_LOG;
if (logPath) {
  const start = process.cpuUsage();
  const startedAt = Date.now();
  process.on('exit', () => {
    const used = process.cpuUsage(start);
    const rssBytes = process.resourceUsage().maxRSS * 1024;
    const line = JSON.stringify({
      pid: process.pid,
      userMs: used.user / 1000,
      systemMs: used.system / 1000,
      totalMs: (used.user + used.system) / 1000,
      maxRssBytes: rssBytes,
      wallMs: Date.now() - startedAt,
    });
    try { fs.appendFileSync(logPath, `${line}\n`); } catch { /* cost data only */ }
  });
}
