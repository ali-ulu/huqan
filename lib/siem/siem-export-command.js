// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

/**
 * The `huqan-gate-hook siem-export` command (#4093, PR-B3, PR-B4).
 *
 * The marshal lives beside the sink it drives rather than in
 * lib/gate-hook-management.js, because the SIEM export is an outbound adapter
 * and the dependency rule keeps Core from knowing one (Core may require
 * Adapters only never). bin/huqan-gate-hook.js is the composition root that
 * chooses this command, the same way it already does for `browser-session` and
 * `canary`.
 *
 *   --sink file    (default) append to the local log a forwarder watches; no network
 *   --sink syslog  --url syslog+tls://host[:port]   RFC 5424 over TLS
 *   --sink http    --url https://...  --format hec|ecs   token from HUQAN_SIEM_HTTP_TOKEN
 *   --policy <file>            the command policy whose dataResidency binds the push (must exist)
 *   --allow-unreviewed-host    accept a host AB13 would send to review
 *
 * A push sink is opt-in by naming it, and its factory judges the host by data
 * residency and expected egress before any connection is opened (INV-B6).
 */

const { argumentValue } = require('../gate-hook-input');
const { exportReceiptsToSiem } = require('./siem-export');
const { createSiemHttpSink } = require('./siem-http-sink');
const { createSiemSyslogSink } = require('./siem-syslog-sink');

const SIEM_SINKS = Object.freeze(['file', 'syslog', 'http']);
const HTTP_TOKEN_VARIABLE = 'HUQAN_SIEM_HTTP_TOKEN';

function refuse(code, message) {
  process.stdout.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exitCode = 2;
}

/** The push sink the operator named, judged by its factory; null for the file sink. */
function buildPushSink(sinkName, format, environment) {
  if (sinkName === 'file') return null;
  const common = {
    url: argumentValue('--url'),
    environment,
    policyPath: argumentValue('--policy') || undefined,
    allowReview: process.argv.includes('--allow-unreviewed-host'),
  };
  return sinkName === 'syslog'
    ? createSiemSyslogSink(common)
    : createSiemHttpSink({ ...common, format, token: environment[HTTP_TOKEN_VARIABLE] });
}

async function runSiemExportCommand(environment = process.env) {
  const sinkName = argumentValue('--sink') || 'file';
  if (!SIEM_SINKS.includes(sinkName)) {
    refuse('UNKNOWN_SIEM_SINK', `unknown sink ${sinkName}; expected one of ${SIEM_SINKS.join(', ')}`);
    return;
  }
  const format = argumentValue('--format') || 'jsonl';
  let sink;
  try {
    sink = buildPushSink(sinkName, format, environment);
  } catch (error) {
    // A refused URL, a missing token or a blocked destination: nothing was read
    // and nothing was sent. The message names the reason, never the token.
    refuse(String((error && error.code) || 'SIEM_SINK_INVALID'), String((error && error.message) || error));
    return;
  }
  const maxBytes = argumentValue('--max-bytes');
  const result = await exportReceiptsToSiem({
    path: argumentValue('--receipt-log') || undefined,
    siemPath: argumentValue('--siem-log') || undefined,
    cursorPath: argumentValue('--cursor') || undefined,
    format,
    maxBytes: maxBytes ? Number.parseInt(maxBytes, 10) : undefined,
    dryRun: process.argv.includes('--dry-run'),
    environment,
    ...(sink ? { sink } : {}),
  });
  const output = sink
    ? { ...result, destination: { residency: sink.policy.residency, expectedEgress: sink.policy.expectedEgress }, warnings: sink.policy.warnings }
    : result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  // A sink that would not take the events is a failure worth a non-zero exit,
  // so a scheduled export does not look successful in a log.
  process.exitCode = result.failure ? 1 : 0;
}

module.exports = { HTTP_TOKEN_VARIABLE, SIEM_SINKS, runSiemExportCommand };
