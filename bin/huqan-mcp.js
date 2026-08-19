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
 */

require('../mcpServer').runStdio();
