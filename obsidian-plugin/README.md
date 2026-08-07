# HUQAN Trust Panel (Obsidian plugin)

> **MOCK — does not verify against the real HUQAN kernel. Generates local
> heuristic receipts only.** See `manifest.json`.

This is the Obsidian plugin surface for the HUQAN trust panel demo. It is a
local-only mock that produces heuristic receipts and does not call the real
HUQAN runtime.

## Files

- `src/main.ts` — TypeScript source
- `main.js` — bundled output (produced by `esbuild.config.mjs`)
- `manifest.json` — Obsidian plugin manifest
- `versions.json` — release → minAppVersion map consumed by Obsidian
- `version-bump.mjs` — version bump helper (see below)
- `styles.css` — panel styles
- `esbuild.config.mjs` — bundler config
- `tsconfig.json` — TypeScript config

## Version bump process

Obsidian requires every released plugin version to be registered in
`versions.json` as `"version": "minAppVersion"`. The
`version-bump.mjs` script updates both `manifest.json` and `versions.json`
atomically.

```bash
cd obsidian-plugin
node version-bump.mjs 1.1.0
```

This will:

1. Set `manifest.json` `version` to the given value.
2. Add a new entry to `versions.json` mapping the new version to the current
   `minAppVersion` from `manifest.json`.

After running it, commit both files together and tag the release.

### Why only one version is registered

`versions.json` currently contains a single entry (`"1.0.0": "1.5.0"`) because
the plugin has only had one release so far. Each subsequent release must run
`version-bump.mjs` so the new version is registered before publishing to the
Obsidian community plugin directory.
