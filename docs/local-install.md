# Local Install Guide

> Get Huqan running on your machine in under 5 minutes.

## Requirements

- **Node.js >= 18** (no GPU, no API key, no Docker)
- **OS**: macOS, Linux, or Windows (PowerShell)
- **Disk**: ~50 MB (including dependencies)
- **RAM**: ~100 MB at runtime

---

## Quick install

```bash
git clone https://github.com/agiulucom42-del/axiom.git
cd axiom
npm install
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
> kedi hayvandır          # teach: "cats are animals"
> kedi nedir              # ask: "what is a cat?" → "kedi: hayvan, canlı"
> kedi bitkidir           # verify: "cats are plants" → contradiction detected
```

### Web UI

```bash
node server.js
# Open http://localhost:3000
```

### MCP Server (for Claude Desktop / Cursor)

```bash
node mcpServer.js
```

Add to your MCP client config — see [MCP setup instructions](./demo-mcp-agent-brake-layer.md#setup-2-minutes).

---

## What you can do immediately

| Action | Command |
|--------|---------|
| Teach it something | `kedi hayvandır` (CLI) or `POST /yukle` (API) |
| Ask a question | `kedi nedir` (CLI) or `GET /api?q=kedi+nedir` (API) |
| Verify a claim | `kedi bitkidir` (CLI) or `POST /dogrula` (API) |
| Export the graph | `GET /graph-data` (API) |
| Connect to Claude | `node mcpServer.js` + MCP config |

---

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api?q=query` | Ask a question |
| POST | `/dogrula` | Verify a statement |
| POST | `/yukle` | Load text into knowledge base |
| GET | `/graph-data` | Export the knowledge graph |

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

**`npm install` fails:**
- Check Node.js version: `node --version` (must be >= 18)
- Try `npm cache clean --force` then retry

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
- This is expected after V2.6-PR2 gate enforcement changes
- Core test suite (`test/*.test.js`) should pass: `node --test test/*.test.js`
