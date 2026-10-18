#!/usr/bin/env node
'use strict';

/**
 * The `huqan-mcp` executable.
 *
 * A file of its own rather than a shebang on mcpServer.js: that module sits at
 * exactly the 800-line threshold scripts/check-file-size.js enforces, and one
 * more line would have pushed it over. Separating the entry point from the
 * server is the shape the ratchet asks for anyway -- being executable is a
 * packaging concern, not part of what the server does.
 *
 * mcpServer.js starts its own stdio loop under `require.main === module`, which
 * is false when it is required from here, so the loop is started explicitly.
 *
 * `proxy` is the second mode (ADR-018 §3, #3999): the per-session helper an
 * agent's MCP client spawns instead of the server itself. It signs every
 * frame with the client envelope and carries it to the protected loopback
 * service; it reads no protected state. Without `proxy`, this is the plain
 * in-process stdio server it always was.
 */

if (process.argv[2] === 'proxy') {
  const { parseProxyArgs, runProxy } = require('../lib/mcp/stdio-proxy');
  try {
    runProxy(parseProxyArgs(process.argv.slice(3)));
  } catch (error) {
    process.stderr.write(`huqan-mcp proxy: ${error.message}\n`);
    process.exitCode = 1;
  }
} else {
  require('../mcpServer').runStdio();
}
