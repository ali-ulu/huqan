# HUQAN / AXIOM V4-UI-0 Trust Receipt Viewer Auth Boundary Scope

**Mode:** docs-only security and product contract.
**Canonical source base:** `main @ 88f8fd17f6688072f1e30dcf6c79b9c24479afcd`
**Decision:** deployment-owned, same-origin, server-side session gateway.
**Implementation status:** not authorized by this document.

## Goal

Define the smallest browser authentication boundary that can expose the
existing materialized Trust Receipt read surface without exposing the server
API key or weakening the canonical API guard.

The viewer remains read-only and receipt-id based. It does not create a new
receipt model, receipt API, mutation path, or approval surface.

## Source Reality

The canonical materialized read route is:

```text
GET /api/trust-receipt/:receiptId?workspaceId=<optional>
```

It is protected by `denyIfUnauthorized()` and accepts the configured server API
key through Bearer or `X-API-Key` authentication. The current browser dashboard
does not send either credential.

The existing dashboard uses the aggregate receipt query route rather than the
receipt-id route. Its error handling constructs a synthetic error receipt.
Neither behavior is authorized for the no-mock viewer.

No session or cookie authentication infrastructure exists in the current
source.

## Selected Boundary

The selected direction is a same-origin session gateway owned by the
deployment.

Same-origin is not authentication by itself. The implementation must establish
an opaque browser session while keeping the upstream API key server-side.

The browser must never receive, render, persist, log, or place the API key in:

- HTML, JavaScript, or source maps;
- URL paths, query strings, or fragments;
- cookies or opaque session identifiers;
- local storage or session storage;
- console, server, access, or audit logs;
- receipt, error, or telemetry payloads.

## Session Contract

The minimum authorized future contract is:

- an opaque, cryptographically random session identifier;
- server-side in-memory session state;
- bounded idle and absolute lifetimes;
- expiry on logout, server restart, or timeout;
- no durable session database or cross-instance replication;
- no identity or role claim beyond the deployment's existing single-operator
  API-key boundary.

The session cookie must be scoped to the viewer and use:

```text
HttpOnly
Secure
SameSite=Strict
Path=/viewer
```

`Secure` is mandatory for a deployed viewer. A local-development exception must
be explicit, loopback-only, and covered by tests; it must not weaken the
deployment contract.

## Bounded Future Routes

A later implementation scope may define only:

```text
POST /viewer/session
POST or DELETE /viewer/session
GET /viewer/api/trust-receipt/:receiptId?workspaceId=<optional>
```

The first route establishes a bounded session. The second terminates it. The
third reads an existing receipt by delegating to canonical `readReceiptById()`
behavior.

The gateway must not:

- expose the API key to downstream browser requests;
- forward arbitrary paths, methods, or headers;
- call the aggregate receipt query builder;
- create or normalize a replacement receipt;
- add mutation, approval, rejection, export, or administration controls;
- alter the original Bearer and `X-API-Key` API behavior;
- broaden CORS or enable credentialed cross-origin requests.

Session-changing requests must validate strict same-origin `Origin` and `Host`
values. Login must use a same-origin HTTPS form submission or an equivalently
bounded server exchange. It must not place credentials in browser-managed
persistent storage.

## Viewer Terminal States

The eventual viewer may render only explicit states derived from the gateway
and canonical read surface:

```text
unauthorized
invalid_request
not_found
read_error
found
```

Only `found` may render receipt fields. Other states must not contain a
synthetic receipt identifier, timestamp, verdict, evidence, or receipt body.

## Required Test Ownership

The future auth implementation gate must add targeted tests for:

- missing or invalid login credentials produce no session;
- opaque session identifiers and required cookie attributes;
- session expiry, logout, and restart invalidation;
- cross-origin session-changing requests fail without state change;
- unauthenticated viewer reads return `401`;
- valid receipt-id reads preserve the canonical payload;
- malformed identifiers return `400`;
- unknown receipts and workspace mismatches return `404`;
- unsupported methods return `405`;
- reads do not mutate graph, memory, receipt, or audit state;
- the existing Bearer and `X-API-Key` API remains protected and unchanged;
- no API key appears in HTML, JavaScript, URLs, storage, logs, or responses.

The later viewer gate must separately prove exact terminal rendering, absence of
synthetic receipt data, and a no-mock authenticated browser smoke.

## Gate Sequence

```text
V4-UI-0_AUTH_BOUNDARY_SCOPE
-> V4-UI-0A_SESSION_GATEWAY_CONTRACT_TESTS
-> V4-UI-0B_SESSION_GATEWAY_IMPLEMENTATION
-> V4-UI-0C_PACKAGE_SURFACE_FIX
-> V4-UI-1S_RECEIPT_VIEWER_SCOPE
-> V4-UI-1_RECEIPT_VIEW_MODEL_CONTRACT_TESTS
-> V4-UI-2_RECEIPT_VIEWER_IMPLEMENTATION
-> V4-UI-3_NO_MOCK_BROWSER_SMOKE
-> V4_UI_PRODUCT_CLOSEOUT
```

Each successor requires its own exact-base scope and review. This document
authorizes none of them.

## Stop Conditions

Stop and open a separate product or security decision if:

- HTTPS or trusted TLS termination is unavailable for deployment;
- anonymous or cross-origin receipt access is required;
- multi-user identity, role, or workspace ACLs are required;
- sessions must survive restart or span multiple replicas;
- a generic proxy, CORS change, new receipt API, or dependency is required;
- the API key would enter browser-visible state;
- receipt sensitivity requires authorization stronger than the current global
  operator key;
- the no-mock protected-route smoke cannot be defined.

## Forbidden Scope

This gate does not authorize:

- runtime, UI, server, route, test, package, or dependency changes;
- embedding the API key in browser assets;
- weakening `denyIfUnauthorized`;
- a durable session store;
- a general authentication platform;
- receipt mutation or approval controls;
- V5, Self-Healer, Rust, connector, or deployment work;
- a V4-complete, production-ready, or public-release claim.

## Verdict

```text
V4_UI_0_AUTH_BOUNDARY_SCOPE_DEFINED
V4_UI_0A_NOT_AUTHORIZED
```
