# V4 Source-Reality Reconciliation

## Checkpoint

- Repository: `ali-ulu/huqan`
- Source base: `main @ 263aa9581e20d7eb68fade2a2d77ef38306e62b7`
- Previous checkpoint: `SELF-HEALER-0_RUNTIME_REACHABILITY_RECONCILIATION`
- Decision: `V4_PRIMITIVES_GREEN_PRODUCT_UI_OPEN`
- Mode: source-reality and decision only

This task-pack reconciles the tested V4 trust primitives and read models with
the absence of a production Workbench user interface. It does not authorize UI
implementation.

## Source authority

Use this order when evidence conflicts:

1. live source and reachable production call paths at the pinned base;
2. current executable tests;
3. V4 closeout and task-pack documents;
4. V5 planning documents that depend on V4;
5. historical dashboards or roadmap summaries.

## Implemented and tested

The current source contains tested V4 building blocks:

- canonical verdict vocabulary and fail-closed mapping;
- canonical trust-receipt payloads and deterministic serialization;
- receipt-chain linking, tamper detection, and export verification;
- materialized receipt indexing and read-only lookup;
- read-only HTTP trust-receipt access;
- MCP verdict and memory-admission metadata;
- a Trust Receipt / Verdict Inspector helper;
- a Memory Admission / Context Integrity Inspector helper.

The focused V4 suite at the pinned base passes:

`84 tests / 84 pass / 0 fail / 0 skipped`

This proves the bounded primitives and read models. It does not prove a
Workbench product surface.

## Reachability

The read-only trust-receipt HTTP route is production-reachable.

The two Workbench inspector helpers are imported by their direct tests, but no
live server route, MCP tool, CLI command, browser page, or packaged UI invokes
them at the pinned base.

No browser smoke establishes:

- a rendered receipt view;
- receipt lookup and terminal-state display;
- workspace-boundary behavior through a UI;
- memory/context integrity display;
- no-mock operation from a browser to the live Kernel-backed transport.

## Reconciled status

Use these separate claims:

| Surface | Status |
| --- | --- |
| V4 verdict, receipt, read-index, and transport primitives | `GREEN` |
| V4 WB1/WB2 inspector helpers | `GREEN_AS_LIBRARY_BUILDING_BLOCKS` |
| Kernel-connected Workbench UI | `NOT_IMPLEMENTED` |
| Browser no-mock smoke | `NOT_PROVEN` |
| V4 product/UI closeout | `OPEN` |

Historical wording that says V4 runtime/read surfaces closed green is accurate
only for the bounded primitives and read models. It must not be expanded into a
claim that a Workbench UI or browser workflow exists.

## Decision

`V4_PRIMITIVES_GREEN_PRODUCT_UI_OPEN`

Do not rewrite the receipt, verdict, read-index, or inspector logic.

If a V4 product surface is later authorized, the smallest first surface is a
read-only Trust Receipt viewer that reuses:

1. the existing receipt read transport;
2. the existing Trust Receipt / Verdict Inspector;
3. the existing terminal statuses and workspace filters.

Do not begin with a broad Workbench shell, dashboard platform, mutable control
plane, new receipt model, or duplicate API.

## Required future trigger

Open a V4 UI implementation chain only when the product decision specifies:

- the supported user and workflow;
- the deployment surface;
- authentication and workspace boundary;
- the exact receipt lookup input;
- the terminal states and fields shown;
- whether the view is local-only or remotely exposed;
- browser test ownership and supported browsers.

## Minimum future proof

A future read-only receipt viewer must prove:

1. it uses the existing Kernel-backed receipt transport;
2. it uses or faithfully delegates to the existing inspector contract;
3. unknown or invalid receipt IDs fail closed without synthetic data;
4. explicit workspace mismatch does not disclose another workspace;
5. the viewer does not create receipts, append audits, or mutate Graph/Memory;
6. loading, not-found, invalid, read-error, and success states are visible;
7. a browser smoke runs against the real transport with no mocked receipt path;
8. existing V4 targeted tests remain green.

## Deferred surface

The Memory Admission / Context Integrity Inspector remains a tested library
building block. It should not be added to the first viewer unless the product
workflow independently requires it.

## Non-claims

This decision does not claim:

- an implemented Workbench UI;
- browser or deployment readiness;
- complete V4 product closeout;
- write, approval, or mutation controls in a UI;
- a new public API;
- universal trust-receipt availability;
- V5 ecosystem, public certification, or trust-network completion.
