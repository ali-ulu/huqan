# Browser observation spike (P0-2b)

Refs #2155 (CDP live browser session observation).

Minimal chain, no new runtime dependency:

```text
browser-use / Playwright action
  -> examples/browser-observation-client.js (external-event envelope)
  -> huqan-gate generic (review/block on payment, submit, exfil targets)
  -> observed result -> receipt
```

## What's covered

- `browser.navigated`, `browser.clicked`, `custom/browser.typed`,
  `custom/browser.submitted` map to `huqan.external-event.v1`.
- Targets are page-level (`page:<host><path>#<element>`); DOM text, inputs,
  cookies and screenshots never enter the envelope.
- Payment/submit targets default to `review` hint so the gate never silently
  allows them.

## Runtime follow-up

The spike remains dependency-free and does not connect to CDP itself. Runtime session observation now lives in `lib/browser-session-observer.js` (#2155):

- explicit opt-in only via `huqan-gate browser-session --cdp <loopback-url> --session-id <id>`,
- loopback-only CDP endpoints to avoid turning the observer into an SSRF/remote-debug bridge,
- connection, navigation, DOM-ready/load, console type/count, and network request/response metadata,
- safe page destinations only (scheme + host + path; no query, fragment, headers, bodies, DOM text, console arguments, screenshots, or page titles),
- optional `--outcome-receipt <id>` binding so runtime browser events can be correlated to the external-action outcome receipt,
- each observation persisted as a hash-sealed `browser_session_event_receipt` and projected into the existing Activity timeline.

The observer intentionally does not persist sensitive DOM content. Consented page preview remains a separate mechanism in `lib/browser-hook-outcome.js`.
