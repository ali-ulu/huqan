// #363 güvenlik regresyon testleri: knowledge-graph demo script'i scripts/ altında,
// opt-in demo modu gerektirir (AXIOM_DEMO_MODE=1 veya --demo), require edilmekle
// çalışmaz ve production memory'ye (CWD memory.json) asla dokunmaz.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'knowledge-graph-demo.js');

const demoMod = require('../scripts/knowledge-graph-demo');

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

describe('#363 knowledge-graph demo güvenliği', () => {
  it('module require edilmesi demo çalıştırmaz ve hiçbir dosya yazmaz', () => {
    const cwd = makeTempDir('axiom-egitim-require-');
    try {
      const result = spawnSync(
        process.execPath,
        ['-e', `require(${JSON.stringify(scriptPath)}); console.log('loaded-ok');`],
        { cwd, encoding: 'utf8' },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /loaded-ok/);
      assert.strictEqual(fs.existsSync(path.join(cwd, 'memory.json')), false);
    } finally {
      removeTempDir(cwd);
    }
  });

  it('demo bayrağı/ortam değişkeni yoksa exit 2 ve hiçbir memory dosyası yazılmaz', () => {
    const cwd = makeTempDir('axiom-egitim-nodemo-');
    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, AXIOM_DEMO_MODE: '' },
      });
      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /demo mode is off/i);
      assert.strictEqual(fs.existsSync(path.join(cwd, 'memory.json')), false);
      assert.strictEqual(fs.existsSync(path.join(cwd, 'memory.db')), false);
    } finally {
      removeTempDir(cwd);
    }
  });

  it('isDemoRequested yalnızca --demo veya AXIOM_DEMO_MODE=1 ile true döner', () => {
    assert.strictEqual(demoMod.isDemoRequested(['--demo'], {}), true);
    assert.strictEqual(demoMod.isDemoRequested([], { AXIOM_DEMO_MODE: '1' }), true);
    assert.strictEqual(demoMod.isDemoRequested([], {}), false);
    assert.strictEqual(demoMod.isDemoRequested([], { AXIOM_DEMO_MODE: '0' }), false);
    assert.strictEqual(demoMod.isDemoRequested(['--other'], {}), false);
  });

  it('varsayılan kalıcılık dizini tmp içindedir, CWD değildir (#363 izolasyon)', () => {
    const cwd = makeTempDir('axiom-egitim-nopd-');
    try {
      const intended = demoMod.resolvePersistDir([], cwd);
      assert.strictEqual(path.isAbsolute(intended), true);
      assert.strictEqual(intended.startsWith(cwd), false);
      assert.match(intended, /huqan-egitim-demo/);
      assert.strictEqual(intended.startsWith(os.tmpdir()), true);
    } finally {
      removeTempDir(cwd);
    }
  });

  it('--persist-dir açıkça verilirse CWD\'nin altına da yazılabilir (bilinçli hedef)', () => {
    const cwd = makeTempDir('axiom-egitim-pd-');
    try {
      const target = path.join(cwd, 'demo-memory');
      const resolved = demoMod.resolvePersistDir(['--persist-dir', target], cwd);
      assert.strictEqual(resolved, target);
    } finally {
      removeTempDir(cwd);
    }
  });

  it('package.json manifest egitim.js içermez, canonical knowledge-graph demo içerir', () => {
    const pkg = require('../package.json');
    assert.ok(!pkg.files.includes('egitim.js'), 'egitim.js npm files içinde olmamalı');
    assert.ok(!pkg.files.includes('scripts/egitim-demo.js'), 'legacy scripts/egitim-demo.js npm files içinde olmamalı');
    assert.ok(pkg.files.includes('scripts/knowledge-graph-demo.js'), 'scripts/knowledge-graph-demo.js npm files içinde olmalı');
    assert.match(pkg.scripts['demo:knowledge-graph'], /scripts\/knowledge-graph-demo\.js/);
    assert.match(pkg.scripts.train, /scripts\/knowledge-graph-demo\.js/);
  });
});
