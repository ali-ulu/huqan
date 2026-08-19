# Local Install Guide

> Get Huqan running on your machine in under 5 minutes.

## Requirements

- **Node.js >= 20** (no GPU, no API key, no Docker)
- **OS**: macOS, Linux, or Windows (PowerShell)
- **Disk**: ~50 MB (including dependencies)
- **RAM**: ~100 MB at runtime

---

## Quick install

```bash
git clone https://github.com/ali-ulu/huqan.git
cd huqan
npm run setup:sqlite
```

---

## Load the knowledge base

```bash
node egitim.js
```

This loads the initial Turkish knowledge base (~5 seconds). You can skip this — Huqan works without it, but queries will return "evidence missing" for most questions.

---

## Verify installation

```bash
npm run setup:sqlite
npm test
```

Expected: all tests pass (0 failures). Some tests may be skipped — that's normal.

---

## Running Huqan

### CLI (interactive)

```bash
node cli.js
```

```
> learn: cats are animals
> ask: cat nedir
> verify: kedi bitkidir
```

Turkish compatibility aliases remain supported: `öğret`, `sor`, `neden`, `karşılaştır`, `doğrula`, `yükle`.

### Web UI

```bash
node server.js
# Open http://localhost:3000
```

Static demo note:
- `demo/index.html` is the canonical static public demo surface.
- `public/index.html` is the canonical local backend-connected UI served by `node server.js`.
- `docs/index.html` is only a docs/demo chooser and does not replace the local UI.

English-first developer UX:
- Public docs use English command names first.
- Turkish commands remain supported for compatibility.
- Unsafe GET verification is not supported. Use guarded POST endpoints.

### MCP Server (for Claude Desktop / Cursor)

```bash
node mcpServer.js
```

Add to your MCP client config — see [MCP setup instructions](./demo-mcp-agent-brake-layer.md#setup-2-minutes).

---

## What you can do immediately

| Action | Command |
|--------|---------|
| Teach it something | `learn: cats are animals` (CLI) or `POST /upload` (API) |
| Ask a question | `ask: cat nedir` (CLI) or `GET /api?q=cat+nedir` (API) |
| Verify a claim | `verify: kedi bitkidir` (CLI) or `POST /verify` (API) |
| Export the graph | `GET /graph-data` (API) |
| Connect to Claude | `node mcpServer.js` + MCP config |

---

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api?q=query` | Read-only allowlisted query surface |
| GET | `/verify?statement=...` | `405 Method Not Allowed` |
| GET | `/dogrula?statement=...` | `405 Method Not Allowed` |
| GET | `/v2/verify?statement=...` | `405 Method Not Allowed` |
| POST | `/verify` | Guarded verification endpoint |
| POST | `/dogrula` | Guarded verification endpoint |
| POST | `/v2/verify` | Guarded structured verification endpoint |
| POST | `/upload` | English alias for guarded load endpoint |
| POST | `/yukle` | Load text into knowledge base |
| GET | `/graph-data` | Export the knowledge graph (API key required) |

---

## Causal relationships

Huqan natively understands:

```
CAUSES      — A causes B
PREVENTS    — A prevents B
ENABLES     — A enables B
DEPENDS_ON  — A depends on B
LEADS_TO    — A leads to B
```

Teach causal chains:
```
> su isitilirsa kaynar        # CAUSES
> kaynar su icebilir mi       # ask → traces causal chain
```

---

## Troubleshooting

**`npm run setup:sqlite` fails:**
- Check Node.js version: `node --version` (the project requires Node.js >= 20)
- Retry after `npm cache clean --force`.
- If the message reports an ABI mismatch, the script attempts `npm rebuild better-sqlite3`; if that also fails, remove `node_modules` and run the setup command again.

**Port 3000 already in use:**
```bash
# Find and kill the process
lsof -i :3000        # macOS/Linux
netstat -ano | findstr :3000  # Windows
```

**MCP server not detected by Claude Desktop:**
- Use absolute paths in `claude_desktop_config.json`
- Restart Claude Desktop after config changes

**Tests show failures in `mcpServer.test.js`:**
- `mcpServer.test.js` is now aligned with V2.6 gate behavior (PR #16).
- If it fails, treat it as a regression or environment issue, not an expected failure.
- Run `node --test mcpServer.test.js` to isolate.
