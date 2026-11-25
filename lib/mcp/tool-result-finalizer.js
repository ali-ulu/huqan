'use strict';

// The last two steps every `tools/call` result passes through, in order:
// the tool's advertised output schema (#3483), then AB7 secret scrubbing.
//
// The order is the point. Conformance first, so the schema check sees the
// result the handler actually produced; scrubbing second, because `toToolResult`
// copies the result into both `content[0].text` and `structuredContent` and this
// is the last point at which a secret that reached a handler's output can still
// be stopped. Scrubbing only replaces string leaves, so the conformed shape
// survives it.

const { conformMcpToolOutput } = require('./output-conformance-gate');
const { scrubSecrets } = require('../secret-scrub-gate');

function finalizeMcpToolResult(kernel, name, value) {
  const conformed = conformMcpToolOutput(kernel, name, value);
  return conformed && typeof conformed === 'object' ? scrubSecrets(conformed).scrubbed : conformed;
}

module.exports = { finalizeMcpToolResult };
