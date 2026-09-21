# Deprecation policy

This package retires surfaces loudly, on a clock, and with a way forward.
A deprecation is a record in `deprecations.json`, and the checker
(`npm run check:deprecations`) fails the gate when a record is incomplete,
its removal release has arrived but the code is still here, the runtime never
warns, or the migration guide does not exist.

## Recording a deprecation

Add one object to `deprecations.json`:

```json
{
  "name": "KernelV1",
  "kind": "export",
  "deprecatedIn": "0.12.0",
  "removalIn": "1.0.0",
  "migrationPath": "docs/migrations/kernel-v2.md",
  "warnedIn": ["index.js"]
}
```

- `kind` is one of `export`, `cli`, `mcp-tool`, `route`, `config`.
- `deprecatedIn` names the release that retired the surface from the default.
- `removalIn` names the release by which the removal must have shipped. The
  policy is "Deprecated in X.Y, warning from X.Y on, removed in X+1.0": a
  removal major equal to the current major is always early, and the checker
  only asks for the removal once the current release reaches `removalIn`.
- `migrationPath` is a repo-relative path the checker requires to exist.
- `warnedIn` lists the implementation files where the checker requires a
  runtime warning (`process.emitWarning` or `console.warn`).

## Runtime warnings

Warn where the old surface is used, not where it is defined when definition
and use differ. A warning must name the replacement and the removal release:

```js
process.emitWarning(
  'KernelV1 is deprecated since 0.12.0 and will be removed in 1.0.0. Use KernelV2.',
  { type: 'DeprecationWarning' },
);
```

Warnings stay side-effect free: defining a deprecated export must not warn,
only calling it may.
