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
