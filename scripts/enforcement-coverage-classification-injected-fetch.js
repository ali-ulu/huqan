'use strict';

/**
 * The entries #4196 added, in a module of their own.
 *
 * The scanner now counts the read of `globalThis.fetch`, which exposed ten
 * files. They are recorded here rather than in
 * enforcement-coverage-classification.js only because that file sat exactly
 * below the large-file threshold (#328) and this cluster is the change that
 * would have pushed it over; each entry is an ordinary classification, judged
 * by the same rules, and would move out if its file outgrew the threshold.
 * The evidence-role prefix that no longer applies is deliberately absent:
 * entries live in whichever module still describes their file honestly.
 */

const INJECTED_FETCH_CLASSIFIED = Object.freeze({
  'lib/external-action-receipt-shipper.js': Object.freeze({
    role: 'egress_operator_gated',
    why: 'appends the collector counter-seals beside the trail and ships that trail to the collector (#1781): signed, tenant-separated batches POSTed to the endpoint the operator configured, the cursor left untouched on any send failure so what is on disk stays the source of truth. '
      + 'The cursor writes moved to lib/external-action-receipt-cursor.js with the #2252 split, and the fetch reached this manifest through the #4196 scanner fix. Shipping runs as its own command after the fact -- a collector being down, slow or wrong cannot change what an agent is allowed to do. '
      + 'No agent action reaches the send. Recorded as a deliberate, written exception in ADR-014 (#4196)',
  }),
  'lib/siem/siem-http-sink.js': Object.freeze({
    role: 'egress_operator_gated',
    why: 'the HTTPS twin of the syslog sink (#4093 PR-B4, #4196): it POSTs the same allowlisted, AB9-scrubbed SIEM event of a decision already made to the HTTPS endpoint the operator named with `siem-export --sink https --url ...` (Splunk HEC or Elastic bulk by the operator\'s chosen format), '
      + 'certificate verification always on and the host judged by the same AB12/AB13 checks before the send. The export runs as its own command after the decision, so no agent tool call reaches it. '
      + 'Recorded as a deliberate, written exception in ADR-014 (#4093 addendum)',
  }),
  // The GitHub App beta and streaming path runs as its own operator-enabled
  // deployment; its outbound GitHub API calls go through an injected
  // `fetchImpl = globalThis.fetch` default, which the scanner now sees (#4196).
  'lib/github-app-beta-auth.js': Object.freeze({
    role: 'egress_operator_gated',
    why: 'mints the installation access token the GitHub App beta path uses: it posts the app\'s own signed JWT to the fixed api.github.com and reads back the token. The beta path is enabled only by operator configuration and runs as its own deployment, so no agent action reaches the fetch. Recorded as a deliberate, written exception in ADR-014',
  }),
  'lib/github-app-beta-http-boundary.js': Object.freeze({
    role: 'egress_operator_gated',
    why: 'the outbound HTTP boundary the GitHub App beta webhook handler calls api.github.com through, plus the optional best-effort repo-ingest submission whose failure never fails the webhook (#3032). '
      + 'The beta path is operator-enabled and separately deployed; the same seam production reads the global fetch from, tests inject a transport. No agent action reaches its sends. '
      + 'Recorded as a deliberate, written exception in ADR-014',
  }),
  'lib/github-app-streaming-auth.js': Object.freeze({
    role: 'egress_operator_gated',
    why: 'the streaming trust path\'s own token exchange: it posts the app\'s signed JWT to the fixed api.github.com install-token endpoint. The streaming path is operator-enabled and runs inside the same separately deployed GitHub App service, so no agent action reaches the fetch. Recorded as a deliberate, written exception in ADR-014',
  }),
  'lib/github-app-streaming-trust-handler.js': Object.freeze({
    role: 'egress_operator_gated',
    why: 'wires one webhook delivery through streaming trust: the handler itself sends nothing, but it threads the injected fetch transport into runGitHubAppStreamingTrust, so a value read of `globalThis.fetch` lands here too (#4196). '
      + 'The egress its threaded transport performs is the streaming path\'s own PR reading and check-run write, on the operator-enabled separately deployed GitHub App service. '
      + 'Recorded as a deliberate, written exception in ADR-014',
  }),
  'lib/github-app-streaming-trust.js': Object.freeze({
    role: 'egress_operator_gated',
    why: 'reads the exact PR head and its changed files from api.github.com and writes the check run back within a time budget, on the operator-enabled streaming GitHub App path; the sends carry only the evaluation of a delivery the webhook already received, never domain agent input. No agent action reaches the transport. Recorded as a deliberate, written exception in ADR-014',
  }),
  'lib/browser-session-observer.js': Object.freeze({
    role: 'adapter_read',
    why: 'observes an already-running browser session (#2155, exposed to the scanner by #4196): one GET of `/json/list` at the caller-supplied CDP endpoint, `redirect: \'error\'` and a bounded abort timeout, to read which targets exist. It sends no inputs, mutates nothing, and resolves no URL of its own beyond what the caller configured',
  }),
  'lib/cli-ingest-batch.js': Object.freeze({
    role: 'operator_tool',
    why: 'the operator\'s `huqan ingest batch` family (#4196): it reads the `--input` JSON file the operator named, caps the batch by item count and bytes, and posts it to the ingest API the CLI context configures, with bounded timeouts. It runs only under direct CLI invocation and sends only what that file contains',
  }),
  'lib/observability/notification-adapter.js': Object.freeze({
    role: 'operator_tool',
    why: 'the webhook transport the human-run `huqan integrity --notify` siren sends through (#4196): it POSTs a bounded alert payload (allowlisted alert fields, capped attempts, timeouts and backoff) HMAC-signed with the operator\'s HUQAN_NOTIFY_WEBHOOK_SECRET to the operator-configured HUQAN_NOTIFY_WEBHOOK_URL, and only when that command is explicitly invoked',
  }),
});

module.exports = { INJECTED_FETCH_CLASSIFIED };
