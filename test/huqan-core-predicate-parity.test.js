'use strict';

/**
 * Predicate-parser parity between `lib/predicate-parser.js` and the Rust
 * `parse_predicate` in `huqan-core/src/main.rs` (#3039).
 *
 * The two backends read the same `learn` input, so a predicate must not become
 * one relation through JavaScript and a different one through Rust. Before this
 * test the Rust parser only looked at trailing letters: `araba` became
 * `yapabilir`, `kültür` became `tür`, and every negated verb fell through to
 * `özellik`. Those are exactly the divergences asserted below.
 *
 * ## What is compared, and what is deliberately not
 *
 * `relation` is compared exactly: it is the semantic half of the parse and the
 * bug in #3039 was a wrong relation.
 *
 * `object` is compared after lowercasing and removing the combining dot that
 * `to_lowercase` leaves on `İ` (U+0307). The Rust crate lowercases the whole
 * predicate before parsing while the JavaScript parser preserves the caller's
 * case; aligning that is a separate concern from relation parity and is out of
 * scope here. Any object difference that is NOT pure case-folding is treated as
 * a failure.
 *
 * ## Skip behaviour
 *
 * The release binary is not tracked, so these cases skip when it is absent
 * rather than failing. A skip is not a parity proof.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { parsePredicate } = require('../lib/predicate-parser');

const ROOT = path.join(__dirname, '..');
const BIN_CANDIDATES = [
  path.join(ROOT, 'huqan-core', 'target', 'release', process.platform === 'win32' ? 'huqan-core.exe' : 'huqan-core'),
  path.join(ROOT, 'huqan-core', 'target', 'x86_64-pc-windows-gnu', 'release', 'huqan-core.exe'),
];
const BIN = BIN_CANDIDATES.find(candidate => fs.existsSync(candidate));
const skip = BIN ? false : 'huqan-core release binary not built';

// Cases chosen so that each one exercises a branch that used to diverge:
// bare noun, real copula, a word that only looks like a copula, negation,
// `farkındalıkdeğildir`, future/progressive verb suffixes, explicit relations
// both bare and with an object in front.
const CASES = [
  'araba', 'kitap', 'kedi', 'masa', 'su', 'süt',
  'sıcaktır', 'başkenttir',
  'kültür', 'müdür', 'tür',
  'hissetmez', 'anlamaz', 'bilmez',
  'değildir', 'farkındalıkdeğildir',
  'gelecek', 'bakacak', 'yazıyor',
  'bağlıdır', 'gerektirir', 'olmadan', 'dayanır',
  'neden olur', 'engeller', 'sağlar', 'tetikler',
  'sistem bağlıdır', 'sistem gerektirir',
  'ilaç hastalığı engeller', 'spor sağlık sağlar',
  'aşılama hastalığa neden olur', 'kedi hayvandır',
  'arabayı neden olur', 'kitabı neden olur',
];

function rustRelations(cases) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`huqan-core exit ${code}: ${stderr}`));
      const lines = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      // Two replies per case: the learn ack, then the edge list for that node.
      const edges = lines.filter(reply => Object.prototype.hasOwnProperty.call(reply, 'edges'));
      resolve(edges.map(reply => {
        assert.equal(reply.edges.length, 1, 'each learned predicate must add exactly one edge');
        return { relation: reply.edges[0].relation, object: reply.edges[0].to };
      }));
    });
    const commands = [];
    cases.forEach((predicate, index) => {
      commands.push({ cmd: 'learn', text: `s${index} ${predicate}` });
      commands.push({ cmd: 'get_edges', id: `s${index}` });
    });
    proc.stdin.end(commands.map(command => JSON.stringify(command)).join('\n'));
  });
}

const foldForComparison = value => String(value).toLowerCase().replace(/\u0307/g, '');

describe('huqan-core parity: predicate parser', { skip }, () => {
  it('emits the same relation as the JavaScript parser for every case', async () => {
    const rust = await rustRelations(CASES);
    assert.equal(rust.length, CASES.length);
    CASES.forEach((predicate, index) => {
      const js = parsePredicate(predicate, word => word);
      assert.equal(
        rust[index].relation,
        js.relation,
        `relation parity for ${JSON.stringify(predicate)}`,
      );
    });
  });

  it('emits an object that matches except for case folding', async () => {
    const rust = await rustRelations(CASES);
    CASES.forEach((predicate, index) => {
      const js = parsePredicate(predicate, word => word);
      assert.equal(
        foldForComparison(rust[index].object),
        foldForComparison(js.object),
        `object parity for ${JSON.stringify(predicate)}`,
      );
    });
  });
});
