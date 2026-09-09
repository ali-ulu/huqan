# decision-explainer

`plugins/decision-explainer.js` turns a gate/verdict decision object
(`.decision` or `.verdict` plus `.reason`) into a human-readable Turkish
sentence. It is also an `afterTask` hook: when a step result carries a gate
decision, it logs the explanation to the console.

Surface, deliberately narrow:

- programmatic API: `explainDecision(decision)` and the `explain`
  capability via `runCapability('explain')`
- passive log: the `afterTask` hook
- no CLI command, no MCP tool, no HTTP route

That absence is a product decision, not a gap: the explainer narrates
decisions other surfaces already made, it does not make or serve any
itself. Adding a CLI/MCP/HTTP entry is a separate product decision and
must not ride along with packaging fixes.

Packaging: the plugin ships in the published tarball via the
`plugins/decision-explainer.js` and
`plugins/decision-explainer.manifest.json` entries in `package.json`
files (issue #1983, H-10). If either entry is dropped, the installed
package silently loses the `explain` capability, so both are pinned by
the tarball regression test.
