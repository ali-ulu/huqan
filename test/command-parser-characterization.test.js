'use strict';

// #2401: parseCommand is characterized before its 53-branch chain becomes an
// ordered rule table. test/fixtures/command-parser.golden.json holds each
// input (every prefix and fixed word in both spellings, upper case, padded,
// with and without a payload; the regex commands; the compare and question
// heuristics; unknown input) with the parse it produced, with no kernel and
// with a kernel that knows one node. Order and diacritic folding are the
// behavior under test. Regenerate only for an intended change:
//   HUQAN_UPDATE_GOLDEN=1 node --test test/command-parser-characterization.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseCommand } = require('../lib/command-parser');

const GOLDEN = path.join(__dirname, 'fixtures', 'command-parser.golden.json');

const KNOWN_NODE_KERNEL = Object.freeze({
  normalizeWord: (word) => String(word).toLowerCase(),
  graph: { getNode: (id) => (id === 'known-node' ? { id } : null) },
});

function parseBoth(input) {
  return {
    input,
    noKernel: parseCommand(input),
    knownNode: parseCommand(input, KNOWN_NODE_KERNEL),
  };
}

test('parseCommand matches its recorded parse for every characterized input', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  if (process.env.HUQAN_UPDATE_GOLDEN === '1') {
    const regenerated = golden.map((row) => JSON.parse(JSON.stringify(parseBoth(row.input))));
    fs.writeFileSync(GOLDEN, `${JSON.stringify(regenerated, null, 1)}\n`);
    return;
  }
  const mismatches = [];
  for (const row of golden) {
    const actual = JSON.parse(JSON.stringify(parseBoth(row.input)));
    try {
      assert.deepEqual(actual, row);
    } catch {
      mismatches.push({ input: row.input, expected: row, actual });
    }
  }
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} input(s) parse differently`);
});

test('the characterized inputs reach every command the parser can return', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const commands = new Set(golden.flatMap((row) => [row.noKernel.command, row.knownNode.command]));
  for (const command of [
    'company-ingest', 'company-query', 'ingest-status', 'öğret', 'sor', 'neden', 'karşılaştır', 'verify', 'yükle',
    'onayla', 'receipt', 'audit', 'hypotheses', 'mri', 'tartis', 'celiski', 'llm-sor', 'plan', 'ajan', 'restore',
    'exit', 'quickstart', 'doctor', 'durum', 'rüya', 'kaydet', 'backup', 'onaylar', 'düşün', 'çıkış', 'selam',
    'yardım', 'optimize', 'konsolide', 'evolve', 'coder', 'anlamadım',
  ]) {
    assert.ok(commands.has(command), `command ${command} is reached`);
  }
});
