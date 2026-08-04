# EXTERNAL-CLIENT-HTTP-ADAPTER-0 — Observed Overflow Amendment

## Gate Identity

- Repository: `ali-ulu/huqan`
- Exact amendment base: `main @ d1a21cedc2338d231622ee268e4085cdabe61dfe`
- Trigger: Route Adversarial-0 PR #233
- Failing exact head: `931a5539af5f68b323e3fe272be993f7d07606b5`
- Failing workflow/job: `30950731105 / 92132051354`
- Classification: `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_BLOCKED_CONTRACT_CONFLICT`
- Mode: docs-only exact-base authorization amendment

This amendment authorizes no runtime behavior by itself. It records one source-real
transport conflict discovered by the first real loopback Route Adversarial-0
proof and defines the minimum successor correction needed to unblock that proof.

## Source Reality

At the exact base:

1. `lib/external-client-http-adapter.js` bounds observed request bytes at
   `1_048_576` and selects a frozen `413` failure descriptor when the next
   chunk would exceed that limit.
2. The body reader finishes the overflow result with its stop flag enabled.
3. `stop(request)` prefers `request.destroy()` over `request.pause()`.
4. A real Node `IncomingMessage.destroy()` tears down the transport before a
   loopback route can reliably copy the selected descriptor to the response.
5. PR #233 therefore receives `400` at
   `test/external-client-route-adversarial.test.js:206` where the real HTTP
   boundary requires `413`.
6. The declared `Content-Length` overflow case immediately preceding it passes;
   the failure is the observed-byte/chunked case.
7. Adapter unit tests use a test `EventEmitter` request whose `destroy()` only
   records a flag. Those tests prove descriptor selection but do not falsify
   real socket delivery after destruction.
8. The Route Adversarial-0 authorization permits only three test-owned files and
   forbids modifying the adapter. The runtime defect cannot be hidden by
   changing the expected status, replacing the real HTTP client, or masking
   `destroy()` in the test harness.
9. Canonical `main` advanced after PR #233 branched. The route proof must be
   reconstructed from current canonical `main` after this correction merges.

## Decision

Observed body overflow must remain a bounded `413` at the real HTTP response
boundary. Adapter cleanup must not destroy the underlying request socket before
the caller can copy the returned descriptor.

The narrow successor implementation may change exactly:

```text
lib/external-client-http-adapter.js
lib/external-client-http-adapter.test.js
```

No other file is authorized by this amendment.

## Required Runtime Contract

The successor must preserve all existing Adapter-0 behavior except transport
cleanup after bounded body-read rejection:

- declared length above the fixed limit returns `413` before body listeners;
- observed bytes above the fixed limit return `413` before parsing or
  delegation;
- invalid chunks, stream errors, aborts and premature close remain bounded and
  never delegate;
- read timeout remains `408` and never delegates;
- all listeners and the timer are detached exactly once;
- no request bytes, internal error, path, key or dependency evidence is exposed;
- no retry, queue, compensation or second delegation is introduced;
- the adapter still returns only the existing frozen descriptor shape;
- no new status, header, response field or public vocabulary is introduced.

For a real Node request that has unread bytes after a bounded rejection, cleanup
must release or drain body consumption without resetting the socket before the
caller writes the response. Reusing the native readable-stream drain primitive
is preferred over adding a helper, dependency, registry or buffering layer.

A non-Node-compatible hostile request shape must still settle once and fail
closed. The implementation must not depend on writable caller-controlled
properties or monkey-patching.

## Required Tests

The existing adapter unit-test owner must prove at least:

1. exact observed-limit acceptance and one-byte overflow rejection;
2. observed overflow returns `413` without delegation;
3. cleanup chooses the native drain/release path when available;
4. buffered unread chunks are not retained by adapter listeners;
5. listener/timer cleanup remains exact;
6. fallback behavior for a hostile stream lacking the native drain primitive is
   bounded and settles once;
7. error, abort, close and timeout tests remain mutation/delegation-free;
8. no change to declared-length, media-type, UTF-8, JSON, depth/value,
   dependency-status or success mapping tests; and
9. both authorized files remain at or below 300 physical lines.

After the successor merges and reconciles, Route Adversarial-0 PR #233 must be
rebuilt from current canonical `main`. Its real-loopback observed overflow test
must remain an unchanged `413` assertion; a harness facade, expected `400`, raw
adapter-only assertion or socket-destruction shim does not close this gate.

## Required Validation

```bash
node --test lib/external-client-http-adapter.test.js
node --test test/external-client-route-adversarial.test.js
npm test
npm pack --dry-run
git diff --check
git status --short
```

Report exact test counts when available. A workflow conclusion without its test
summary is recorded only as a workflow conclusion.

## Forbidden Changes

This amendment does not authorize:

- changing Route Adversarial-0 expected status from `413` to `400`;
- modifying its harness to hide, replace or defer `IncomingMessage.destroy()`;
- modifying `server.js`, route registration or endpoint configuration;
- changing the fixed body-size or timeout constants;
- adding configurable request limits;
- adding a dependency, package export, schema, public error, response field or
  response header;
- buffering bytes beyond the existing fixed maximum;
- retry, queue, asynchronous compensation or unknown-outcome replay;
- production profile, clock, replay-path, SDK, mutation or receipt composition;
- production reachability, deployment or release claims; or
- V4-complete, Enablement-complete or V5-complete claims.

## Stop Conditions

Stop and request another exact-base amendment if the correction requires:

- any file outside the exact two-file successor scope;
- route/server ownership of adapter body parsing;
- a new descriptor field or socket-control API;
- weakening overflow, malformed-stream, timeout or no-delegation behavior;
- accepting transport reset, `400`, or client error as equivalent to the
  selected `413`; or
- changing package or deployment surface.

## Definition of Done

This docs-only amendment closes only when:

1. exact base, failing head, CI job and assertion line are recorded;
2. the failure is correctly classified as observed overflow socket delivery;
3. the unchanged real-HTTP `413` requirement is preserved;
4. successor scope is exactly the adapter and its existing unit-test owner;
5. runtime, route, package and deployment expansion remain forbidden;
6. exact-head docs CI and source-first review pass; and
7. merge reconciliation opens only the narrow Adapter-0 overflow correction.

## Non-Claims

This document does not implement the correction, make the external-client route
reachable, alter production composition, prove multi-client behavior, close
External Client Enablement-0, complete V4 Workbench, or complete V5.
