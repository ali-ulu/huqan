'use strict';

/**
 * The syslog push transport for the SIEM export (#4093, PR-B4).
 *
 * RFC 5424 messages over TCP with TLS (RFC 5425), framed by octet counting
 * (RFC 6587 section 3.4.1) so a message is never split or merged on a
 * newline. Only `syslog+tls://host[:port]` is accepted; there is no UDP and no
 * plain TCP, because both would carry the guard's decisions in clear text
 * (INV-B5). The server certificate is verified against the system trust store
 * -- or `NODE_EXTRA_CA_CERTS` for a private CA -- and there is no switch to
 * turn verification off.
 *
 * Syslog over TCP has no application acknowledgement. `write` returns only
 * after the frames were flushed and the connection then closed without an
 * error -- a collector that rejects the session after the handshake (a TLS 1.3
 * client-certificate alert, say) surfaces as an error before that close.
 * That is still "sent", not "stored", and the at-least-once cursor plus the
 * stable `event.id` are what make a re-send harmless. A connection, handshake,
 * write or timeout failure throws, so the export keeps its cursor (INV-B4).
 * The whole exchange has one deadline, so a collector that trickles bytes
 * cannot hold the export open.
 *
 * Severity follows the guard's decision (block -> warning, review -> notice,
 * anything else -> informational) on facility local0. The message body is the
 * line the chosen format rendered (CEF, ECS JSON or jsonl), untouched.
 *
 * The factory judges the host with lib/siem/siem-push-policy.js (AB12
 * residency, AB13 expected egress) before it returns, so no caller can hold a
 * syslog sink that skipped the check (INV-B6).
 */

const os = require('node:os');
const tls = require('node:tls');
const { assertPushDestinationAllowed } = require('./siem-push-policy');

const DEFAULT_SYSLOG_TLS_PORT = 6514;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const FACILITY_LOCAL0 = 16;
const SEVERITY = Object.freeze({ block: 4, review: 5 });
const SEVERITY_INFORMATIONAL = 6;
const APP_NAME = 'huqan';
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

const SIEM_SYSLOG_ERRORS = Object.freeze({
  INVALID_CONFIG: 'SIEM_SYSLOG_INVALID_CONFIG',
  TIMEOUT: 'SIEM_SYSLOG_TIMEOUT',
  FAILED: 'SIEM_SYSLOG_FAILED',
});

function sinkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseSyslogUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch (_) { parsed = null; }
  if (!parsed || parsed.protocol !== 'syslog+tls:' || !parsed.hostname) {
    throw sinkError(SIEM_SYSLOG_ERRORS.INVALID_CONFIG, 'the syslog sink needs syslog+tls://host[:port]; UDP and plain TCP are not offered');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw sinkError(SIEM_SYSLOG_ERRORS.INVALID_CONFIG, 'a syslog endpoint is a host and a port, without credentials, path, query or fragment');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = parsed.port ? Number(parsed.port) : DEFAULT_SYSLOG_TLS_PORT;
  return { host, port, href: `syslog+tls://${parsed.host}` };
}

/** An RFC 5424 header field: printable US-ASCII without spaces, bounded, or the nil value. */
function headerField(value, maximum) {
  const cleaned = String(value || '').replace(/[^\x21-\x7e]+/g, '-').slice(0, maximum);
  return cleaned || '-';
}

function timestampOf(event) {
  const value = event && event['@timestamp'];
  return typeof value === 'string' && RFC3339.test(value) ? value : '-';
}

function priorityOf(event) {
  const severity = SEVERITY[event && event['huqan.decision']] ?? SEVERITY_INFORMATIONAL;
  return FACILITY_LOCAL0 * 8 + severity;
}

function frame(line, event, hostname) {
  const message = [
    `<${priorityOf(event)}>1`,
    timestampOf(event),
    hostname,
    APP_NAME,
    '-',
    headerField(event && event['event.action'], 32),
    '-',
    line,
  ].join(' ');
  return `${Buffer.byteLength(message, 'utf8')} ${message}`;
}

function connectOptions(target) {
  return {
    host: target.host,
    port: target.port,
    // SNI and certificate name checks need a name; an IP literal has none.
    servername: /^[\d.]+$|:/.test(target.host) ? undefined : target.host,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
}

/** Sends `payload` over one TLS connection; settles once, on clean close or first failure. */
function sendOverTls(connect, target, payload, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let flushed = false;
    let socket = null;
    const failure = (error) => sinkError(SIEM_SYSLOG_ERRORS.FAILED, `syslog endpoint ${target.href} failed: ${String((error && error.code) || (error && error.name) || 'Error')}`);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        if (socket) socket.destroy();
        reject(error);
      } else {
        resolve();
      }
    };
    // One deadline for the whole exchange; the idle timeout below alone would
    // keep resetting for a collector that trickles bytes.
    const deadline = setTimeout(() => finish(sinkError(SIEM_SYSLOG_ERRORS.TIMEOUT, `syslog endpoint ${target.href} did not finish within ${timeout} ms`)), timeout);
    try {
      socket = connect(connectOptions(target));
    } catch (error) {
      finish(failure(error));
      return;
    }
    socket.setTimeout(timeout, () => finish(sinkError(SIEM_SYSLOG_ERRORS.TIMEOUT, `syslog endpoint ${target.href} did not answer within ${timeout} ms`)));
    socket.on('error', (error) => finish(failure(error)));
    // Success is a clean close after our frames were flushed, never the flush alone.
    socket.on('close', (hadError) => finish(flushed && !hadError ? null : failure({ code: 'CLOSED_BEFORE_SEND_COMPLETED' })));
    socket.on('secureConnect', () => {
      socket.write(payload);
      socket.end((error) => {
        if (error) finish(failure(error));
        else flushed = true;
      });
    });
  });
}

/**
 * @param {object} options
 * @param {string} options.url `syslog+tls://host[:port]`, port 6514 by default
 * @param {object} [options.environment] read for AB13
 * @param {string} [options.policyPath] / dataResidency / expectedEgress / allowReview: see siem-push-policy
 * @returns {{kind: 'syslog', path: string, host: string, policy: object, write: Function}}
 */
function createSiemSyslogSink({
  url,
  environment = process.env,
  policyPath,
  dataResidency,
  expectedEgress,
  allowReview = false,
  connect = tls.connect,
  hostname = os.hostname(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const target = parseSyslogUrl(url);
  if (typeof connect !== 'function') throw sinkError(SIEM_SYSLOG_ERRORS.INVALID_CONFIG, 'a TLS connect implementation is required');
  const policy = assertPushDestinationAllowed({ host: target.host, policyPath, dataResidency, expectedEgress, allowReview, environment });
  const localHost = headerField(hostname, 255);
  const numericTimeout = Number(timeoutMs);
  const timeout = Number.isFinite(numericTimeout) ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(numericTimeout))) : DEFAULT_TIMEOUT_MS;

  async function write(lines, events = []) {
    if (lines.length === 0) return { delivered: 0 };
    const payload = lines.map((line, index) => frame(line, events[index], localHost)).join('');
    await sendOverTls(connect, target, payload, timeout);
    return { delivered: lines.length };
  }

  return Object.freeze({ kind: 'syslog', path: target.href, host: target.host, policy, write });
}

module.exports = {
  DEFAULT_SYSLOG_TLS_PORT,
  SIEM_SYSLOG_ERRORS,
  createSiemSyslogSink,
};
