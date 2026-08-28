'use strict';

/**
 * Validate the PR Guardian webhook destination before anything is sent (#1677).
 *
 * The workflow reads its destination from the `PR_GUARDIAN_WEBHOOK_URL`
 * repository variable and POSTs pull-request metadata -- title, body, branch
 * names, actor -- plus an HMAC signature to it. Repository variables are not
 * secrets, so the destination is externally supplied configuration and deserves
 * the same checking as any other URL arriving from outside the code. Over plain
 * HTTP the payload and the `x-hub-signature-256` header travel in the clear.
 *
 * The rules, and why each one:
 *
 *   - HTTPS only for anything that leaves the machine. A cleartext remote
 *     destination exposes the payload to whatever sits on the path.
 *   - Plain HTTP is accepted only for a loopback host, and only outside
 *     Actions. A loopback request never reaches a network interface, which is
 *     what makes local development safe; a runner has no legitimate loopback
 *     destination, so under GITHUB_ACTIONS the exception is off entirely.
 *   - No credentials in the URL. `https://user:pass@host` puts a secret into a
 *     repository variable and into every log line that echoes the destination.
 *   - No fragment. A fragment is never sent to a server, so its presence means
 *     the configured value is not the URL its author thought it was.
 *   - No query string. The workflow appends a fixed path to this value, so a
 *     query would land in the middle of the resulting URL rather than at its
 *     end.
 *   - An explicit host and a scheme that is exactly http or https. Anything
 *     else -- an empty host, a scheme-relative value, a `javascript:` or
 *     `file:` URL -- is a malformed origin for this purpose.
 *
 * Used as a CLI it reads PR_GUARDIAN_WEBHOOK_URL and exits non-zero with a
 * GitHub Actions error annotation, so the workflow stops before the payload
 * step builds or signs anything.
 */

/** 127.0.0.0/8, ::1 and localhost never leave the machine. */
function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const mapped = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  const octets = mapped.split('.');
  if (octets.length !== 4) return false;
  if (!octets.every(octet => /^[0-9]{1,3}$/.test(octet) && Number(octet) <= 255)) return false;
  return Number(octets[0]) === 127;
}

/**
 * @param {string} rawUrl The configured destination.
 * @param {object} [options]
 * @param {boolean} [options.onActions] True when running under GitHub Actions,
 *   where the loopback exception is not available.
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
function checkWebhookUrl(rawUrl, { onActions = false } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, reason: 'PR_GUARDIAN_WEBHOOK_URL is empty' };
  }
  if (rawUrl.trim() !== rawUrl) {
    return { ok: false, reason: 'PR_GUARDIAN_WEBHOOK_URL has leading or trailing whitespace' };
  }
  // Checked before parsing: new URL() silently strips tabs, newlines and other
  // C0 characters, which would validate one string and send another.
  if (/[\u0000-\u0020\u007f]/.test(rawUrl)) {
    return { ok: false, reason: 'PR_GUARDIAN_WEBHOOK_URL contains whitespace or control characters' };
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return { ok: false, reason: 'PR_GUARDIAN_WEBHOOK_URL is not an absolute URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `unsupported scheme "${url.protocol.replace(':', '')}"; use https` };
  }
  if (!url.hostname) return { ok: false, reason: 'PR_GUARDIAN_WEBHOOK_URL has no host' };
  if (url.username || url.password) {
    return { ok: false, reason: 'PR_GUARDIAN_WEBHOOK_URL must not embed credentials' };
  }
  if (url.hash) return { ok: false, reason: 'PR_GUARDIAN_WEBHOOK_URL must not contain a fragment' };
  if (url.search) return { ok: false, reason: 'PR_GUARDIAN_WEBHOOK_URL must not contain a query string' };

  if (url.protocol === 'https:') return { ok: true, url };

  if (!isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      reason: `refusing to send the signed payload over cleartext HTTP to ${url.hostname}; use https`,
    };
  }
  if (onActions) {
    return {
      ok: false,
      reason: 'a loopback HTTP destination is for local development only, never for a runner',
    };
  }
  return { ok: true, url };
}

/** GitHub sets GITHUB_ACTIONS=true on hosted and self-hosted runners alike. */
function runningOnActions(environment = process.env) {
  return String(environment.GITHUB_ACTIONS || '').toLowerCase() === 'true';
}

function main() {
  const result = checkWebhookUrl(process.env.PR_GUARDIAN_WEBHOOK_URL, {
    onActions: runningOnActions(),
  });
  if (!result.ok) {
    process.stderr.write(`::error::PR Guardian webhook destination rejected: ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  // Origin only: the path may carry a deployment prefix, and echoing the whole
  // configured value adds nothing to confirming what was accepted.
  process.stdout.write(`PR Guardian webhook destination accepted: ${result.url.origin}\n`);
}

if (require.main === module) main();

module.exports = { checkWebhookUrl, isLoopbackHost, runningOnActions };
