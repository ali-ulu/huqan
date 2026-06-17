const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('real user smoke blockers', () => {
  it('node cli.js --help exits without entering interactive mode or loading memory', () => {
    const cwd = makeTempDir('axiom-cli-help-');
    try {
      const result = spawnSync(process.execPath, [path.join(repoRoot, 'cli.js'), '--help'], {
        cwd,
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /AXIOM komutlari:/);
      assert.doesNotMatch(result.stdout, /axiom>/);
      assert.doesNotMatch(result.stderr, /Load error/i);
      assert.strictEqual(fs.existsSync(path.join(cwd, 'memory.json')), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('egitim.js persists seeded Turkish facts as UTF-8 without mojibake', () => {
    const cwd = makeTempDir('axiom-egitim-');
    try {
      const result = spawnSync(process.execPath, [path.join(repoRoot, 'egitim.js')], {
        cwd,
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 0, result.stderr);
      const memory = fs.readFileSync(path.join(cwd, 'memory.json'), 'utf8');
      assert.match(memory, /HUQAN/);
      assert.match(memory, /dış marka ürün kimliğidir/);
      assert.match(memory, /mant\u0131k/);
      assert.match(memory, /do\u011fru d\u00fc\u015f\u00fcnme y\u00f6ntemi/);
      assert.match(memory, /bilgi grafi\u011fi motoru/);
      assert.doesNotMatch(memory, /Ã|Ä|Å/);

      const kernel = new Kernel({
        memoryPath: path.join(cwd, 'memory.json'),
        dbPath: path.join(cwd, 'memory.db'),
      });
      assert.strictEqual(kernel.ask('HUQAN nedir?').data.unknown, false);
      assert.match(kernel.ask('HUQAN nedir?').data.answer, /huqan/i);
      assert.strictEqual(kernel.verify('mantik dogru dusunme yontemidir').data.status, 'dogrulandi');
      assert.strictEqual(kernel.verify('AXIOM bilgi grafigi motorudur').data.status, 'dogrulandi');
      kernel.graph.close?.();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('verifies seeded Turkish facts with natural Turkish and ASCII variants', () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false });
    kernel.learn('mant\u0131k do\u011fru d\u00fc\u015f\u00fcnme y\u00f6ntemidir');
    kernel.learn('AXIOM bilgi grafi\u011fi motorudur');

    const turkish = kernel.verify('mant\u0131k do\u011fru d\u00fc\u015f\u00fcnme y\u00f6ntemidir');
    const ascii = kernel.verify('mantik dogru dusunme yontemidir');
    const huqan = kernel.ask('HUQAN nedir?');
    const axiom = kernel.verify('AXIOM bilgi grafigi motorudur');
    const unknown = kernel.verify('mantik kahve makinesidir');

    assert.strictEqual(turkish.data.status, 'dogrulandi');
    assert.strictEqual(ascii.data.status, 'dogrulandi');
    assert.strictEqual(huqan.data.unknown, false);
    assert.strictEqual(axiom.data.status, 'dogrulandi');
    assert.strictEqual(unknown.data.status, 'celiski');
  });
});
