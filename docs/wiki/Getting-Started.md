# Getting Started

HUQAN requires Node.js **22.13.0 or newer**.

## Install

```bash
npm install -g huqan
```

The package exposes three binaries:

- `huqan` — CLI
- `huqan-mcp` — MCP server over stdio
- `huqan-gate` — pre-execution guard for external agents

Optional PDF ingest and PDF receipt export dependencies can be omitted. JSON receipt export is unaffected.

## Sixty-second quickstart

```bash
npx -y huqan quickstart
```

The quickstart demonstrates the core governed-mutation flow:

```text
propose -> review -> approve -> verify -> Trust Receipt
```

The important point is that a mutating request is not written immediately. It is held for review when policy requires it, then approved by an operator boundary, then verified and recorded.

The quickstart uses a temporary store and does not weaken the gate around your own state.

## As a library

```js
const Kernel = require('huqan');
const kernel = new Kernel();
```

`require('huqan')` resolves to KernelV2, the canonical runtime.

## Local server

```bash
HUQAN_API_KEY=replace-with-a-secret npm run server
```

The local server exposes read-only and guarded HTTP surfaces, including the backend-connected local UI and read-only Trust Receipt Viewer.

## MCP

A minimal MCP configuration looks like this:

```json
{
  "mcpServers": {
    "huqan": {
      "command": "npx",
      "args": ["-y", "--package=huqan", "huqan-mcp"]
    }
  }
}
```

`--package=huqan` matters because the npm package name and MCP binary name differ.

## External-agent guard

`huqan-gate` accepts a brand-independent action envelope and makes a pre-execution decision. It ships projections for several agent environments, but enforcement exists only when the client actually calls the guard before execution.

A hookless client still needs a wrapper, gateway, or sandbox boundary around execution.

Read the full source guide: [docs/external-action-guard.md](https://github.com/ali-ulu/huqan/blob/main/docs/external-action-guard.md).

## Verify the repository

From a clone:

```bash
npm ci
npm test
npm run conformance:external
npm run conformance:a2a
```

The repository also contains package/install smoke evidence in the main test suite. Passing repository tests should not be interpreted as proof that every module is reachable from every production entry point.

## Next

Read [How HUQAN Works](How-HUQAN-Works) before diving into individual subsystems.
