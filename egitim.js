'use strict';
// #363 (security): the original training/demo entry moved out of the repo root
// and was hardened to run only in demo mode (HUQAN_DEMO_MODE=1 or --demo).
// The canonical descriptive name is now scripts/knowledge-graph-demo.js.
// This root compatibility location does no work that touches production memory;
// it only redirects callers that still invoke `node egitim.js`.
console.error('egitim.js is a deprecated compatibility entry (#363). New usage:');
console.error('  HUQAN_DEMO_MODE=1 node scripts/knowledge-graph-demo.js --demo');
console.error('The demo only ever writes to an isolated temporary directory; it never touches production memory.json.');
process.exitCode = 2;
