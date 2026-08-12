'use strict';
// #363 (security): the egitim demo script moved to scripts/egitim-demo.js, was
// dropped from the npm "files" allowlist, and was hardened to run only in demo
// mode (HUQAN_DEMO_MODE=1 or --demo). This old root location no longer does any
// work that touches production memory; it only redirects the caller.
console.error('egitim.js has moved and been hardened (#363). New usage:');
console.error('  HUQAN_DEMO_MODE=1 node scripts/egitim-demo.js --demo');
console.error('The demo only ever writes to an isolated temporary directory; it never touches production memory.json.');
process.exitCode = 2;
