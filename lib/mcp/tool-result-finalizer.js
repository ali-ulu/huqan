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
  // The conformance gate only builds an envelope around a plain object, so a
  // handler that returns a bare string reaches here unconformed -- and AB7
  // still has to scrub it.
  const scrub = typeof conformed === 'string' || (conformed && typeof conformed === 'object');
  return scrub ? scrubSecrets(conformed).scrubbed : conformed;
}

module.exports = { finalizeMcpToolResult };
