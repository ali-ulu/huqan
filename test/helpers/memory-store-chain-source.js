'use strict';

// Reads the MemoryStore implementation the way the delegation-contract tests
// pin it: the entry file plus the method-group chain it installs
// (lib/memory-store-*-methods.js, #2120). Moved methods keep their verbatim
// class shape, so the pinned bodies and call-site counts hold over the
// concatenation; a group that moved anywhere outside this chain would escape
// every check, which is what this reader exists to prevent.
//
// Only the installed method groups are concatenated: the entry also requires
// its delegates (memory-store-write, memory-store-sqlite-writer, ...), whose
// own definitions would double the pinned call-site counts if they were
// folded in too.
const fs = require('node:fs');
const path = require('node:path');

const CHAIN_MEMBER = /^\.\/memory-store-[a-z]+-methods$/;

function readMemoryStoreChain(entryPath) {
  const entryDir = path.dirname(entryPath);
  const parts = [fs.readFileSync(entryPath, 'utf8')];
  const seen = new Set([path.resolve(entryPath)]);
  const source = parts[0];
  for (const match of source.matchAll(/require\('(\.\/memory-store-[^']+)'\)/g)) {
    const spec = match[1];
    if (!CHAIN_MEMBER.test(spec)) continue;
    const file = path.resolve(entryDir, `${spec.slice(2)}.js`);
    if (seen.has(file)) continue;
    seen.add(file);
    parts.push(fs.readFileSync(file, 'utf8'));
  }
  return parts.join('\n');
}

module.exports = { readMemoryStoreChain };
