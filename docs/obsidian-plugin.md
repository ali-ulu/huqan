# HUQAN Trust Panel for Obsidian

The Obsidian plugin is maintained and released from its dedicated public repository:

<https://github.com/ali-ulu/huqan-obsidian>

The plugin is not part of the root HUQAN npm package. The dedicated repository is
the single source of truth for its TypeScript source, committed bundle,
manifest, release workflow, tests, and GitHub Releases.

## Runtime contract

The plugin uses only the following read-only HUQAN surfaces:

- `GET /health` for the connection test.
- `POST /v2/verify` for selected text and bounded note verification.

The plugin does not call ingest, learn, approval, mutation, or action endpoints.
It accepts only loopback endpoints and sends the configured API key only to the
local HUQAN server.

## Local development

Clone both repositories when developing the integration:

```bash
git clone https://github.com/ali-ulu/huqan.git
git clone https://github.com/ali-ulu/huqan-obsidian.git
```

Start the local HUQAN server from the root repository, then run the plugin's own
checks from the dedicated repository:

```bash
cd huqan
npm ci
HUQAN_API_KEY="replace-with-a-long-random-key" npm run server

cd ../huqan-obsidian
npm ci
npm run check
```

The plugin release tag must exactly match its `manifest.json` and
`package.json` version. Stable release assets are published by the dedicated
repository's GitHub Actions workflow.

## Repository update flow

There is intentionally no bidirectional copy or generated plugin bundle in this
repository. The dedicated `ali-ulu/huqan-obsidian` repository is the single source
of truth for plugin code and releases. The HUQAN repository remains the source of
truth for the local runtime and the `/health` and `/v2/verify` API surfaces used by
the plugin.

When a HUQAN runtime change may affect those surfaces, the
`.github/workflows/obsidian-plugin-compatibility.yml` workflow checks the proposed
HUQAN revision against the current `huqan-obsidian` `main` branch. It checks out
both public repositories, starts the proposed local server with a disposable test
key, and runs `npm run check:runtime` from the plugin repository. The workflow is
therefore a compatibility gate, not a code synchronization mechanism.

The normal ownership rule is:

| Change | Edit here | Result |
| --- | --- | --- |
| Plugin UI, commands, settings, or bundle | `ali-ulu/huqan-obsidian` | Plugin PR, tests, tag, and GitHub Release |
| HUQAN `/health` or `/v2/verify` behavior | `ali-ulu/huqan` | Runtime PR plus Obsidian compatibility check |
| Shared integration contract | Both repositories, in separate scoped PRs | Compatibility check must pass before release |

This avoids two copies of `main.js` diverging. A runtime release does not silently
rewrite the plugin, and a plugin release does not silently modify the HUQAN server.
