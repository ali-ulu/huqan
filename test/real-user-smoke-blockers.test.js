const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');

const repoRoot = path.resolve(__dirname, '..');
const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    if (!['EPERM', 'EBUSY'].includes(err?.code)) {
      throw err;
    }
  }
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
      assert.match(result.stdout, /HUQAN commands:/);
      assert.doesNotMatch(result.stdout, /axiom>/);
      assert.doesNotMatch(result.stderr, /Load error/i);
      assert.strictEqual(fs.existsSync(path.join(cwd, 'memory.json')), false);
    } finally {
      removeTempDir(cwd);
    }
  });

  it('scripts/egitim-demo.js (demo) persists seeded Turkish facts as UTF-8 without mojibake, isolated from production memory', () => {
    const cwd = makeTempDir('axiom-egitim-');
    try {
      const demoMemoryDir = path.join(cwd, 'demo-memory');
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, 'scripts', 'egitim-demo.js'), '--demo', '--persist-dir', demoMemoryDir],
        { cwd, encoding: 'utf8' },
      );

      assert.strictEqual(result.status, 0, result.stderr);
      const memory = fs.readFileSync(path.join(demoMemoryDir, 'memory.json'), 'utf8');
      assert.match(memory, /HUQAN/);
      assert.match(memory, /dış marka ürün kimliğidir/);
      assert.match(memory, /mant\u0131k/);
      assert.match(memory, /do\u011fru d\u00fc\u015f\u00fcnme y\u00f6ntemi/);
      assert.match(memory, /bilgi grafi\u011fi motoru/);
      assert.doesNotMatch(memory, /Ã|Ä|Å/);

      // #363: production memory (CWD memory.json) must never be touched.
      assert.strictEqual(fs.existsSync(path.join(cwd, 'memory.json')), false);

      const kernel = new Kernel({
        memoryPath: path.join(demoMemoryDir, 'memory.json'),
        dbPath: path.join(demoMemoryDir, 'memory.db'),
      });
      assert.strictEqual(kernel.ask('HUQAN nedir?').data.unknown, false);
      assert.match(kernel.ask('HUQAN nedir?').data.answer, /huqan/i);
      assert.strictEqual(kernel.verify('mantik dogru dusunme yontemidir').data.status, 'verified');
      assert.strictEqual(kernel.verify('AXIOM bilgi grafigi motorudur').data.status, 'verified');
      kernel.graph.close?.();
    } finally {
      removeTempDir(cwd);
    }
  });

  it('verifies seeded Turkish facts with natural Turkish and ASCII variants', () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false });
    kernel.learn('mant\u0131k do\u011fru d\u00fc\u015f\u00fcnme y\u00f6ntemidir', TEST_FIXTURE_LEARN_BYPASS);
    kernel.learn('AXIOM bilgi grafi\u011fi motorudur', TEST_FIXTURE_LEARN_BYPASS);

    const turkish = kernel.verify('mant\u0131k do\u011fru d\u00fc\u015f\u00fcnme y\u00f6ntemidir');
    const ascii = kernel.verify('mantik dogru dusunme yontemidir');
    const huqan = kernel.ask('HUQAN nedir?');
    const axiom = kernel.verify('AXIOM bilgi grafigi motorudur');
    const unknown = kernel.verify('mantik kahve makinesidir');

    assert.strictEqual(turkish.data.status, 'verified');
    assert.strictEqual(ascii.data.status, 'verified');
    assert.strictEqual(huqan.data.unknown, false);
    assert.strictEqual(axiom.data.status, 'verified');
    assert.strictEqual(unknown.data.status, 'unknown');
  });
});
