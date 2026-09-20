# Deprecation policy

This document is the product rule for retiring public surface. The companion
gate is `scripts/check-deprecations.js` (issue #2649, task M4).

## Lifecycle

| Stage | When | Required artifacts |
|-------|------|--------------------|
| **Deprecated** | Minor `X.Y` | `@deprecated` JSDoc on the export / command / tool / route; migration note in docs or the tag text itself |
| **Warned** | Next minor `X.Y+1` (or later) | Callable surfaces emit `process.emitWarning` or `console.warn` on use |
| **Removed** | Next major `X+1.0` | Code gone; major version bump; changelog **Breaking Changes** |

Applies to: package exports, CLI commands, MCP tools, REST routes, and
documented config options.

## Library import rule

The package root (`require('huqan')`) must stay free of side effects. A
deprecated **export alias** on the root object may therefore be JSDoc-only
until removal, provided the tag states the replacement and the removal window
("Removed in the next major" is enough). Callable entry points (CLI handlers,
MCP tools, HTTP routes) still need a runtime warning when invoked.

## Tag shape

```js
/** @deprecated Use KernelV2 / require('huqan'). Removed in the next major. */
module.exports.KernelV1 = Kernel;
```

Preferred fragments inside the tag text:

- `Use <replacement>` — where callers should go
- `Deprecated in vX.Y` — optional, when the minor is known
- `Removed in the next major` or `Removed in vX.0` — removal window

## Enforcement

`node scripts/check-deprecations.js` (and the `deprecations` verify stage) fails when:

1. An `@deprecated` tag has no migration hint (`Use …` / `use …` / replacement path)
2. A deprecated **non-root** surface has no paired `emitWarning` / `console.warn` in the same file (root export aliases are exempt under the library import rule)
3. A tag claims `Removed in vN` while `package.json` version is still at or past that major

Silent root aliases are listed in `config/deprecation-allowlist.json` when they
must stay warn-free; the default allowlist covers `KernelV1` on `index.js`.
