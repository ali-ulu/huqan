# HUQAN / AXIOM V4-UI-1 Receipt Viewer Scope

**Mode:** docs-only product and implementation-boundary contract.
**Canonical source base:** `main @ b556ff7ea99a34e29524df8196766af701e45d11`
**UI-2S amendment base:** `main @ 937ee4e105216b0bbb8672931c933b13c490a4a4`
**Implementation status:** not authorized by this document.

## Source Reality

At this base, V4-UI-0A session primitives, V4-UI-0B session gateway, and the
V4-UI-0C package-surface recovery are merged. The viewer gateway exposes only:

```text
POST /viewer/session
DELETE /viewer/session
GET /viewer/api/trust-receipt/:receiptId?workspaceId=<optional>
```

There is no viewer HTML, receipt view-model, static viewer route, or browser
smoke. `public/index.html` is the legacy dashboard and is not the viewer.

## Gate Split

Each successor remains an exact-base, separately reviewed gate:

```text
V4-UI-1S  receipt viewer scope (this document)
V4-UI-1   pure receipt view-model plus passing contract tests
V4-UI-2S  exact static-asset and browser-module scope amendment
V4-UI-2   viewer HTML/modules, exact static routes, and rendering tests
V4-UI-3   no-mock authenticated browser smoke
V4-UI-P   product closeout audit
```

UI-1 must be green when introduced. It does not authorize deliberately-red
tests or browser/runtime implementation hidden inside a test-only gate.

## Closed Terminal States

The view-model maps one parsed gateway response to exactly one state:

```text
unauthorized
invalid_request
not_found
read_error
found
```

Only `found` may carry a non-null receipt. Every other state must carry
`receipt: null` and must not synthesize a receipt id, timestamp, verdict,
evidence, chain status, or receipt-shaped placeholder.

## Actual Gateway Mapping

| Gateway response | View-model state |
|---|---|
| `200`, `ok: true`, object `receipt` | `found` |
| `401`, `error.code: unauthorized` | `unauthorized` |
| `400`, `error.code: invalid_receipt_id` | `invalid_request` |
| `404`, `error.code: receipt_not_found` | `not_found` |
| `500`, `error.code: receipt_read_failed` | `read_error` |
| malformed, unparseable, network, or any unmapped response | `read_error` |

This fallback deliberately includes `403 cross_origin`, unsupported methods or
media types, oversized payloads, rate limiting, and route-level `404 not_found`.
UI-1 must not reinterpret them as a sixth state or silently map them to
`unauthorized` or receipt `not_found`.

The current gateway maps all non-`not_found` result failures to
`400 invalid_receipt_id`; a thrown receipt read maps to
`500 receipt_read_failed`. UI-1 mirrors this observed boundary. It does not
change or reinterpret gateway behavior.

## UI-1 Contract

UI-1 may change only:

```text
public/viewer/receipt-view-model.mjs
test/v4-ui-1-receipt-view-model.test.js
package.json (files allowlist entry only)
```

The `.mjs` module exports exactly `TERMINAL_STATES` and
`mapReceiptResponse`. It is the single mapping implementation. The CommonJS test
loads it with dynamic `import()`. UI-2 later imports the same bytes in the
browser. No CommonJS copy, UMD wrapper, browser global, duplicated inline
mapping, bundler, or build step is allowed.

The module must be pure and deterministic:

- no `Date`, randomness, timer, file, network, or process I/O;
- no `fetch`, DOM, `window`, or `document` access;
- no global mutable state;
- same input produces a deeply equal output;
- receipt data is pass-through only on `found`;
- no API key, cookie, or session identifier is added to output.

## UI-2 Preview

UI-2S records one required source-reality amendment: the pure mapper cannot
also own DOM or fetch behavior, while inline executable script would weaken
the viewer CSP. UI-2 may therefore own only:

```text
public/viewer/index.html
public/viewer/app.mjs
lib/viewer/viewer-gateway.js (three exact static GET routes only)
test/v4-ui-2-receipt-viewer-render.test.js
test/v4-ui-2-viewer-asset-nonexposure.test.js
package.json (files allowlist entries only)
```

The three bounded static routes are:

```text
GET /viewer                         -> public/viewer/index.html
GET /viewer/app.mjs                 -> public/viewer/app.mjs
GET /viewer/receipt-view-model.mjs -> public/viewer/receipt-view-model.mjs
```

Both `.mjs` routes use an explicit JavaScript MIME type. No request path may be
joined to a filesystem path. Unknown assets, traversal attempts, and other
methods fail closed. `public/index.html` remains unchanged.

The HTML loads only `/viewer/app.mjs` as an external module. `app.mjs` imports
the existing mapper module, uses relative same-origin requests, renders only
with DOM node creation and `textContent`, and never uses browser storage,
`innerHTML`, server error text, or remote assets. Static responses must set
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and
`Referrer-Policy: no-referrer`. The HTML response also sets a restrictive CSP
with `default-src 'none'`, `script-src 'self'`, `connect-src 'self'`,
`style-src 'self'`, `base-uri 'none'`, `object-src 'none'`,
`frame-ancestors 'none'`, and `form-action 'self'`.

## Forbidden Scope

This sequence does not authorize:

- a dependency, framework, bundler, or generic static-file server;
- a new receipt API, mutation endpoint, or aggregate receipt query;
- CORS changes or credentialed cross-origin requests;
- receipt synthesis, fallback receipt data, or test fixtures presented as real;
- approval, rejection, export, mutation, or administration controls;
- changes to canonical API authentication or session primitives;
- V4-complete, production-ready, or public-release claims.

UI-2's separately reviewed page route and two exact `.mjs` assets are the only
new static paths permitted by this scope.

## Acceptance Criteria

UI-1 closes only when:

1. the module exports exactly `TERMINAL_STATES` and `mapReceiptResponse`;
2. tests cover all five states and defensive fallback behavior;
3. malformed `200` responses never become `found`;
4. every non-`found` output has `receipt: null` and no receipt fields;
5. repeat evaluation is deeply equal and input is not mutated;
6. package dry-run includes the `.mjs` module;
7. V4-UI-0A/0B and receipt-read regressions remain green;
8. the exact changed-file scope is preserved.

## Stop Conditions

Stop rather than inventing behavior if:

- a sixth terminal state is required;
- UI-1 needs gateway, session, DOM, or legacy dashboard changes;
- the gateway response contract must change to complete the mapper;
- UI-2 needs a generic proxy/static server, CORS change, or dependency;
- any failure path appears to need a synthetic or partial receipt.

## Non-Claims

This document does not claim that a viewer page exists, a browser flow has
run, the current 400/500 mapping is final, or UI-2/UI-3 are implemented.

## Gate Sequence

```text
V4-UI-0_AUTH_BOUNDARY_SCOPE
-> V4-UI-0A_SESSION_GATEWAY_CONTRACT_TESTS (complete)
-> V4-UI-0B_SESSION_GATEWAY_IMPLEMENTATION (complete)
-> V4-UI-0C_PACKAGE_SURFACE_FIX (complete)
-> V4-UI-1S_RECEIPT_VIEWER_SCOPE (this document)
-> V4-UI-1_RECEIPT_VIEW_MODEL_CONTRACT_TESTS
-> V4-UI-2S_STATIC_ASSET_SCOPE_AMENDMENT
-> V4-UI-2_RECEIPT_VIEWER_IMPLEMENTATION
-> V4-UI-3_NO_MOCK_BROWSER_SMOKE
-> V4_UI_PRODUCT_CLOSEOUT
```

## Verdict

```text
V4_UI_1_SCOPE_DEFINED
V4_UI_1_NOT_YET_IMPLEMENTED
```
