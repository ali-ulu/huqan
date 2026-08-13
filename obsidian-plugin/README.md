# HUQAN Evidence & Trust for Obsidian

Verify statements in an Obsidian note against a **real local HUQAN runtime**.
The plugin does not use a mock verifier and does not send note text or API keys
to a remote service.

## What it does

- **Verify current note** — scans a bounded number of Markdown statements and
  checks each one with HUQAN `/v2/verify`.
- **Verify selected text** — checks the selected passage against HUQAN.
- Shows HUQAN's canonical `verified`, `contradicted`, and `unknown` statuses.
- Shows confidence, explanation, evidence summaries, and manipulation-risk
  labels returned by the HUQAN runtime.
- Keeps the configured endpoint loopback-only (`127.0.0.1`, `localhost`, or
  `::1`) so a saved API key cannot be sent to an arbitrary host.
- Bounds full-note scans to 1–40 statements (20 by default).

## Requirements

- Obsidian desktop 1.5.0 or newer.
- A local HUQAN server from this repository.
- A `HUQAN_API_KEY` configured on that local server.

## Run HUQAN locally

From a HUQAN checkout:

```bash
npm ci
HUQAN_API_KEY="replace-with-a-long-random-key" npm run server
```

On Windows PowerShell:

```powershell
$env:HUQAN_API_KEY="replace-with-a-long-random-key"
npm run server
```

The server listens on `http://127.0.0.1:3000` by default.

## Configure the plugin

Open **Settings → Community plugins → HUQAN Trust Panel** and set:

1. Local HUQAN endpoint (default: `http://127.0.0.1:3000`)
2. The same HUQAN API key used to start the server
3. HUQAN workspace (default: `default`)
4. Maximum statements to check per note

Use **Test HUQAN** before the first verification.

## Commands

- `HUQAN: Verify current note`
- `HUQAN: Verify selected text`
- `HUQAN: Test connection`

The shield ribbon icon runs **Verify current note**.

## Privacy and security boundary

The plugin stores its settings in Obsidian's local plugin data. The API key is
therefore a local secret, not an encrypted credential store. To reduce its
blast radius, the plugin refuses to send the key to non-loopback hosts.

Verification is read-only. This plugin does not call HUQAN ingest, learn,
approval, mutation, or action endpoints.

## What a result means

HUQAN verifies a statement against the evidence available in the configured
HUQAN workspace. `unknown` means HUQAN did not have enough evidence. It is not
a claim that the statement is false. Likewise, this plugin is not a universal
fact checker and does not promise truth or hallucination elimination.

## Development

```bash
cd obsidian-plugin
npm ci
npm run build
```

Release artifacts are:

- `main.js`
- `manifest.json`
- `styles.css`

For each release, update the plugin version and `versions.json` together.
