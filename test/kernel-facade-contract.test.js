const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PackageKernel = require('..');
const KernelV2 = require('../kernel.v2');
const Kernel = require('../kernel');
const { withoutNestedMember, nestedMemberBody } = require('./helpers/kernel-declaration');

const FACADE_METHODS = Object.freeze([
  'learn', 'ask', 'verify', 'reason', 'compare', 'dream',
  'detectGaps', 'detectContradictions', 'getPersistenceDescriptor',
  'reload', 'persist', 'optimize', 'recordCliMutationAudit',
  'entropy', 'consolidate', 'selfEvolve', 'startAutoThink', 'stopAutoThink',
  'usePlugin',
]);

const REPO_ROOT = path.resolve(__dirname, '..');

function makeKernel() {
  const root = path.join(os.tmpdir(), `huqan-kernel-facade-${process.pid}-${Date.now()}`);
  return new PackageKernel({
    noLoad: true, loadPlugins: false, useSQLite: false, memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'), dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
}

// =========================================================================
// Existing facade contract tests
// =========================================================================

test('package entry resolves to the canonical kernel constructor', () => {
  // #329: the canonical runtime is KernelV2, and the package root export now
  // matches it. Before this, every entry point built a KernelV2 while
  // require('huqan') handed out the v1 Kernel -- one runtime, two public
  // kernel surfaces.
  assert.equal(PackageKernel, KernelV2);
  assert.notEqual(PackageKernel, Kernel);
  assert.equal(typeof PackageKernel, 'function');
  assert.equal(PackageKernel.name, 'KernelV2');
});

test('the v1 kernel stays reachable under an explicitly deprecated name', () => {
  assert.equal(PackageKernel.KernelV2, KernelV2);
  assert.equal(PackageKernel.KernelV1, Kernel, 'v1 must not disappear abruptly');
});

test('the package entry keeps the static contract markers it published as v1', () => {
  // These were reachable as require('huqan').X while main pointed at
  // kernel.js. Forwarding the same objects keeps `err instanceof
  // require('huqan').ProvenanceError` true for errors the kernel throws.
  assert.equal(PackageKernel.ProvenanceError, Kernel.ProvenanceError);
  assert.equal(PackageKernel.createAdmissionBypassOpts, Kernel.createAdmissionBypassOpts);
  assert.equal(PackageKernel.AXIOM_ERROR, Kernel.AXIOM_ERROR);
  assert.equal(PackageKernel.CONTRACT_VERSION, Kernel.CONTRACT_VERSION);
});

test('Kernel exposes the documented static contract markers', () => {
  assert.equal(typeof PackageKernel.CONTRACT_VERSION, 'string');
  assert.match(PackageKernel.CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof PackageKernel.AXIOM_ERROR, 'object');
  assert.equal(PackageKernel.AXIOM_ERROR.INVALID_INPUT, 'INVALID_INPUT');
});

test('Kernel instances expose the frozen high-level facade methods', () => {
  const kernel = makeKernel();
  try {
    assert.equal(kernel.contractVersion, PackageKernel.CONTRACT_VERSION);
    for (const method of FACADE_METHODS) {
      assert.equal(typeof kernel[method], 'function', method);
    }
  } finally {
    kernel.graph.close();
  }
});

test('graph and memory remain observable compatibility surfaces', () => {
  const kernel = makeKernel();
  try {
    assert.equal(typeof kernel.graph, 'object');
    assert.equal(typeof kernel.graph.load, 'function');
    assert.equal(typeof kernel.graph.save, 'function');
    assert.equal(typeof kernel.memory, 'object');
    assert.equal(typeof kernel.memory.close, 'function');
  } finally {
    kernel.graph.close();
  }
});

test('kernel.d.ts aligned with graph/memory surfaces', () => {
  const declaration = fs.readFileSync(path.join(REPO_ROOT, 'kernel.d.ts'), 'utf8');
  const classStart = declaration.indexOf('declare class Kernel');
  assert.notEqual(classStart, -1, 'Kernel declaration must remain present');
  const kd = declaration.slice(classStart);
  assert.match(kd, /\bgraph\s*:\s*\{[\s\S]*?\bload\(\)\s*:\s*void\s*;[\s\S]*?\bsave\(\)\s*:\s*void\s*;[\s\S]*?\}\s*;/);
  assert.match(kd, /\bmemory\s*:\s*\{[\s\S]*?\bclose\(\)\s*:\s*void\s*;[\s\S]*?\}\s*;/);
  assert.match(kd, /\bgetPersistenceDescriptor\(\)\s*:\s*Readonly<\{\s*memoryPath\s*:\s*string\s*;\s*dbPath\s*:\s*string\s*;\s*\}>\s*;/);
  assert.match(kd, /\breload\(\)\s*:\s*void\s*;/);
  assert.match(kd, /\bpersist\(\)\s*:\s*void\s*;/);
  assert.match(kd, /\boptimize\(\)\s*:\s*\{\s*pruned\s*:\s*number\s*;\s*removedNodes\s*:\s*number\s*;\s*\}\s*;/);
  assert.match(declaration, /export type CliMutationAuditIntent\s*=\s*Readonly<\{/);
  assert.match(declaration, /export interface NormalizedAuditEvent\s*\{/);
  assert.match(declaration, /export type CliMutationAuditResult\s*=\s*Readonly<\{/);
  assert.match(kd, /\brecordCliMutationAudit\(intent\s*:\s*CliMutationAuditIntent\)\s*:\s*CliMutationAuditResult\s*;/);

  // The guarantee is about the Kernel's own surface. kernel.graph
  // .appendAuditEvent is a real runtime method (graph.js defines it,
  // agent.v3.js calls it), so the widened graph typing legitimately declares
  // it; matching the bare substring over the whole class body conflated the
  // two objects. Assert on each surface separately instead.
  const kernelOwnSurface = withoutNestedMember(kd, 'graph');
  assert.doesNotMatch(kernelOwnSurface, /\bappendAuditEvent\s*\(/,
    'Kernel itself must not expose a public audit append');
  assert.doesNotMatch(kd, /\b_appendAuditEvent\s*\(/,
    'the private seam must not be declared as API anywhere');
  assert.match(nestedMemberBody(kd, 'graph'), /\bappendAuditEvent\s*\(/,
    'the graph surface must keep describing its real method, so narrowing the types back is caught');
  const seams = kd.slice(kd.indexOf('getPersistenceDescriptor'), kd.indexOf('paranoidMode'));
  assert.doesNotMatch(seams, /\bPromise\b|\bany\b|\bRecord\s*</);
  assert.doesNotMatch(seams, /\w+\?\s*\(/);
});

test('Kernel declarations preserve sync learn return variants', () => {
  const kd = fs.readFileSync(path.join(REPO_ROOT, 'kernel.d.ts'), 'utf8');
  const v2d = fs.readFileSync(path.join(REPO_ROOT, 'kernel.v2.d.ts'), 'utf8');
  assert.match(kd, /export interface LearnDocumentResult\s*\{/);
  assert.match(kd, /export interface LearnFromLLMResult\s*\{/);
  assert.match(kd, /learnDocument\(text:\s*string\):\s*number;/);
  assert.match(kd, /learnDocument\(text:\s*string,\s*opts:\s*LearnOptions\s*&\s*\{\s*returnDetails:\s*true\s*\}\):\s*LearnDocumentResult;/);
  assert.match(kd, /learnDocument\(text:\s*string,\s*opts:\s*LearnOptions\s*&\s*\{\s*returnDetails\?:\s*false\s*\}\):\s*number;/);
  assert.match(kd, /learnFromLLM\(text:\s*string,\s*opts\?:\s*LearnOptions\):\s*LearnFromLLMResult;/);
  assert.doesNotMatch(kd, /learn(?:Document|FromLLM)[^;]*\bPromise\b/);
  assert.match(v2d, /type KernelV2LearnFromLLMResult\s*=/);
});

// =========================================================================
// 4C1 — Package manifest & allowlist
// =========================================================================

test('4C1: package.json manifest', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  // #329: main/types point at the root export module, which resolves to the
  // canonical KernelV2 rather than the internal v1 implementation.
  assert.equal(pkg.main, 'index.js');
  assert.equal(pkg.types, 'index.d.ts');
  assert.ok(pkg.files.includes('index.js'), 'the root export must ship');
  assert.ok(pkg.files.includes('index.d.ts'), 'the root declaration must ship');
  assert.ok(pkg.files.includes('kernel.js'), 'the deprecated v1 export must still resolve');
  assert.equal(typeof pkg.bin, 'object');
  assert.equal(pkg.bin.huqan, './cli.js');
  assert.ok(Array.isArray(pkg.files), 'files allowlist must be present');
  assert.ok(pkg.files.length > 0, 'files allowlist must not be empty');
});

test('4C1: exports map absent', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.exports, undefined, 'exports map must not be present');
});

test('4C1: every allowlist entry exists on disk', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const entry of pkg.files) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, entry)), `missing: ${entry}`);
  }
});

test('4C1: no forbidden entries in allowlist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const forbidden = pkg.files.filter(e => {
    const bn = path.basename(e);
    return e.startsWith('test/') || e.startsWith('.github/') || e.startsWith('evidence/') ||
      e.startsWith('demo/') || (e.startsWith('docs/') && e !== 'docs/seed/axiom-identity.seed.json') ||
      e.startsWith('fixtures/') || e.startsWith('obsidian-plugin/') || e.startsWith('axiom-core/') ||
      e.startsWith('schemas/') || e.startsWith('lib/v5/') || e.startsWith('.kiro/') ||
      bn.endsWith('.test.js') || bn === 'results.json' || bn === 'memory.json' ||
      bn.startsWith('memory.db') || bn === 'agent.memory.json' || bn.endsWith('.agent.json') ||
      bn === '.env' || bn === 'npm-pack-dry-run.json';
  });
  assert.deepStrictEqual(forbidden, [], `forbidden: ${forbidden.join(', ')}`);
});

test('4C1: required closure paths in allowlist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const fileSet = new Set(pkg.files);
  const required = [
    'kernel.js', 'kernel.v2.js', 'cli.js', 'server.js', 'mcpServer.js',
    'kernel.d.ts', 'kernel.v2.d.ts',
    'lib/memory-store.js', 'lib/verify.js', 'lib/learn-use-case.js',
    'lib/provenance-ingest.js', 'lib/memory-admission-gate.js',
    'lib/conflict-detector.js', 'lib/kernel-read-use-cases.js',
    'lib/sdk.js', 'lib/atp-conformance.js', 'lib/axiom-package-format.js',
    'graph.js', 'dream.js', 'plugin.js', 'nlp/index.js',
    'config/trust-policy.default.json',
    'packages/axiom-verify/index.js', 'packages/axiom-verify/package.json',
    'packages/huqan-verify/index.js', 'packages/huqan-verify/package.json',
  ];
  for (const entry of required) assert.ok(fileSet.has(entry), `required: ${entry}`);
});

// =========================================================================
// 4C1 — Declaration alignment
// =========================================================================

test('4C1: ProvenanceError runtime/declaration alignment', () => {
  assert.equal(typeof PackageKernel.ProvenanceError, 'function');
  const err = new PackageKernel.ProvenanceError('test');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof PackageKernel.ProvenanceError);
  assert.equal(err.name, 'ProvenanceError');
  assert.equal(err.code, 'PROVENANCE_REQUIRED');
  const decl = fs.readFileSync(path.join(REPO_ROOT, 'kernel.d.ts'), 'utf8');
  assert.match(decl, /declare class ProvenanceError extends Error/);
  assert.match(decl, /name:\s*'ProvenanceError'/);
  assert.match(decl, /code:\s*'PROVENANCE_REQUIRED'/);
  assert.match(decl, /static ProvenanceError:\s*typeof ProvenanceError/);
});

test('4C1: strictProvenance option declaration', () => {
  const decl = fs.readFileSync(path.join(REPO_ROOT, 'kernel.d.ts'), 'utf8');
  assert.match(decl, /strictProvenance\?\s*:\s*boolean/);
});

test('4C1: kernel.v2.d.ts allowed members', () => {
  const v2d = fs.readFileSync(path.join(REPO_ROOT, 'kernel.v2.d.ts'), 'utf8');
  const allowed = [
    'readonly graph', 'readonly contractVersion', 'getPersistenceDescriptor',
    'reload', 'persist', 'optimize', 'usePlugin', 'entropy',
    'detectGaps', 'detectContradictions', 'startAutoThink', 'stopAutoThink',
  ];
  for (const m of allowed) {
    if (m.startsWith('readonly ')) assert.match(v2d, new RegExp(`readonly\\s+${m.slice(9)}`));
    else assert.match(v2d, new RegExp(`\\b${m}\\(`));
  }
});

test('4C1: kernel.v2.d.ts forbidden members absent', () => {
  const v2d = fs.readFileSync(path.join(REPO_ROOT, 'kernel.v2.d.ts'), 'utf8');
  assert.doesNotMatch(v2d, /\bplugins\b/);
  assert.doesNotMatch(v2d, /\bgetStats\b/);
  assert.doesNotMatch(v2d, /\b_[a-z]/);
  assert.doesNotMatch(v2d, /\[key\s*:\s*string\]/);
});

// =========================================================================
// 4C1 — NPM pack verification (fail-closed)
// =========================================================================

function runPack() {
  const result = cp.spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT, timeout: 60000, encoding: 'utf8', shell: true,
    env: { ...process.env, NO_COLOR: '1' },
  });

  if (result.error) assert.fail(`npm pack spawn error: ${result.error.message}`);
  if (result.status !== 0 && result.status !== null) {
    assert.fail(`npm pack exit ${result.status}: ${(result.stderr || result.stdout || '').slice(0, 500)}`);
  }
  const out = (result.stdout || '').trim();
  if (!out) assert.fail('npm pack produced empty stdout');
  // npm --json wraps output; try full parse first, then find JSON array
  let parsed;
  try { parsed = JSON.parse(out); } catch {
    const match = out.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch {}
    }
    if (!parsed) assert.fail(`npm pack JSON parse error. first 500: ${out.slice(0, 500)}`);
  }
  assert.ok(Array.isArray(parsed), 'npm pack output root is not an array');
  // find the files array: either flat or inside a top-level package record
  let files = Array.isArray(parsed[0]?.files) ? parsed[0].files : null;
  if (!files) files = parsed.find(e => Array.isArray(e?.files))?.files;
  if (!files) files = parsed.find(e => e && e.path && !Array.isArray(e)) ? parsed : null;
  if (!files) files = parsed; // fallback: use parsed as-is
  assert.ok(Array.isArray(files), `npm pack output missing files array. keys: ${Object.keys(parsed[0]||{}).join(',')}`);
  return files;
}

test('4C1: verifier license metadata matches the packed root license', () => {
  const root = require('../package.json');
  const canonical = require('../packages/huqan-verify/package.json');
  const legacy = require('../packages/axiom-verify/package.json');
  assert.equal(root.license, 'AGPL-3.0-only');
  assert.equal(canonical.license, root.license);
  assert.equal(legacy.license, root.license);

  const packedPaths = new Set(runPack().map(file => file.path));
  assert.ok(packedPaths.has('LICENSE'), 'packed tarball must contain the root license text');
  assert.ok(packedPaths.has('packages/huqan-verify/package.json'),
    'packed tarball must contain canonical verifier metadata');
  assert.ok(packedPaths.has('packages/axiom-verify/package.json'),
    'packed tarball must contain legacy verifier metadata');
});

test('4C1: packed manifest — correct tarball structure', () => {
  const files = runPack();
  assert.ok(files.length > 0, 'packed files array must not be empty');
  const pkgMeta = files.find(f => f.path === 'package.json');
  assert.ok(pkgMeta, 'packed tarball must contain package.json');
  const packedPaths = new Set(files.map(f => f.path));
  assert.ok(packedPaths.has('kernel.js'), 'kernel.js must be in tarball');
  assert.ok(packedPaths.has('kernel.d.ts'), 'kernel.d.ts must be in tarball');
  assert.ok(packedPaths.has('packages/huqan-verify/index.js'), 'canonical verifier must be in tarball');
  assert.ok(packedPaths.has('packages/huqan-verify/package.json'), 'canonical verifier manifest must be in tarball');
  assert.ok(packedPaths.has('packages/axiom-verify/index.js'), 'legacy verifier re-export must be in tarball');
  assert.ok(packedPaths.has('packages/axiom-verify/package.json'), 'legacy verifier manifest must be in tarball');
});

test('4C1: packed manifest — zero forbidden entries', () => {
  const files = runPack();
  const forbiddenPatterns = [
    /^test\//, /^\.github\//, /^evidence\//, /^demo\//,
    /^docs\/(?!seed\/axiom-identity\.seed\.json)/, /^fixtures\//,
    /^obsidian-plugin\//, /^axiom-core\//, /^schemas\//, /^lib\/v5\//,
    /^\.kiro\//, /\.test\.js$/,
  ];
  const forbidden = [];
  for (const f of files) {
    const p = f.path || '';
    for (const pat of forbiddenPatterns) {
      if (pat.test(p)) { forbidden.push(p); break; }
    }
  }
  assert.deepStrictEqual(forbidden, [], `forbidden packed: ${forbidden.join(', ')}`);
});

// =========================================================================
// 4C1 — Actual tarball install + smoke (installed-tarball contract)
// =========================================================================

let INSTALL_DIR = null;
let TARBALL_PATH = null;

function setupTarballInstall() {
  if (INSTALL_DIR) return { installDir: INSTALL_DIR, tarballPath: TARBALL_PATH };
  INSTALL_DIR = path.join(os.tmpdir(), `huqan-4c1-smoke-${Date.now()}`);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  const packResult = cp.spawnSync('npm', ['pack', '--json', '--ignore-scripts', `--pack-destination=${INSTALL_DIR}`], {
    cwd: REPO_ROOT, timeout: 60000, encoding: 'utf8', shell: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (packResult.error) assert.fail(`pack spawn error: ${packResult.error.message}`);
  if (packResult.status !== 0) assert.fail(`pack exit ${packResult.status}`);
  const packOut = (packResult.stdout || '').trim();
  let packMeta;
  try { packMeta = JSON.parse(packOut); } catch (e) {
    const lines = packOut.split('\n').filter(l => l.trim()).slice(-1);
    if (lines.length === 1) try { packMeta = JSON.parse(lines[0]); } catch {}
    if (!packMeta) assert.fail(`pack JSON parse error: ${packOut.slice(0, 500)}`);
  }
  assert.ok(Array.isArray(packMeta), 'pack output is not an array');
  const top = packMeta[0];
  assert.ok(top && top.filename, 'missing top-level package record in pack output');
  TARBALL_PATH = path.join(INSTALL_DIR, top.filename);
  assert.ok(fs.existsSync(TARBALL_PATH), `tarball not found: ${TARBALL_PATH}`);

  // npm init + install in temp project
  cp.spawnSync('npm', ['init', '-y'], { cwd: INSTALL_DIR, encoding: 'utf8', shell: true, timeout: 15000 });
  const installResult = cp.spawnSync('npm', ['install', '--no-audit', '--no-fund', TARBALL_PATH], {
    cwd: INSTALL_DIR, encoding: 'utf8', timeout: 120000, shell: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (installResult.error) assert.fail(`npm install error: ${installResult.error.message}`);
  if (installResult.status !== 0) assert.fail(`npm install exit ${installResult.status}: ${installResult.stderr?.slice(0, 300)}`);
  assert.ok(fs.existsSync(path.join(INSTALL_DIR, 'node_modules', 'huqan')), 'huqan must be installed');
  return { installDir: INSTALL_DIR, tarballPath: TARBALL_PATH };
}

function runInstalledNode(code, opts = {}) {
  const info = setupTarballInstall();
  const result = cp.spawnSync(process.execPath, ['-e', code], {
    cwd: info.installDir, timeout: opts.timeout || 20000, encoding: 'utf8',
    env: {
      ...process.env,
      ...(opts.env || {}),
      AXIOM_DISABLE_AUTO_LISTEN: '1',
      AXIOM_USE_SQLITE: 'false',
    },
  });
  return result;
}

function cleanupTarballInstall() {
  if (INSTALL_DIR) {
    try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch {}
    INSTALL_DIR = null; TARBALL_PATH = null;
  }
}

test('4C1: installed tarball smoke — all retained deep imports load', () => {
  const imports = [
    'huqan', 'huqan/kernel', 'huqan/kernel.js',
    'huqan/kernel.v2', 'huqan/kernel.v2.js',
    'huqan/cli', 'huqan/cli.js',
    'huqan/lib/sdk', 'huqan/lib/sdk.js',
    'huqan/mcpServer', 'huqan/mcpServer.js',
    'huqan/server', 'huqan/server.js',
    'huqan/packages/huqan-verify', 'huqan/packages/axiom-verify',
  ];

  for (const imp of imports) {
    const code = `
      const mod = require('${imp}');
      if (!mod) process.exit(1);
      if (typeof mod.closeAxiom === 'function') mod.closeAxiom();
      if (mod.graph && typeof mod.graph.close === 'function') mod.graph.close();
    `;
    const result = runInstalledNode(code, { timeout: 20000 });
    assert.equal(result.status, 0, `deep import "${imp}" failed. stderr: ${result.stderr?.slice(0, 400)}`);
  }

  const compatibility = runInstalledNode(`
    const canonical = require('huqan/packages/huqan-verify');
    const legacy = require('huqan/packages/axiom-verify');
    if (canonical !== legacy || canonical.packageName !== 'huqan-verify' || canonical.status !== 'skeleton') process.exit(1);
  `);
  assert.equal(compatibility.status, 0,
    `verifier compatibility failed. stderr: ${compatibility.stderr?.slice(0, 400)}`);

  cleanupTarballInstall();
});

test('4C1: installed CLI help smoke', () => {
  const info = setupTarballInstall();
  // Use node directly to run the installed CLI entrypoint
  const cliPath = path.join(info.installDir, 'node_modules', 'huqan', 'cli.js');
  assert.ok(fs.existsSync(cliPath), `installed CLI not found: ${cliPath}`);
  const result = cp.spawnSync(process.execPath, [cliPath, '--help'], {
    cwd: info.installDir, timeout: 20000, encoding: 'utf8',
    env: { ...process.env, AXIOM_USE_SQLITE: 'false', NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, `CLI help exit ${result.status}: ${(result.stderr || result.stdout || '').slice(0, 300)}`);
  cleanupTarballInstall();
});

test('4C1: installed dependency resolution', () => {
  const info = setupTarballInstall();
  const code = `
    const { createRequire } = require('node:module');
    const pkgRequire = createRequire(require.resolve('huqan/package.json'));
    const db = pkgRequire('better-sqlite3');
    if (typeof db !== 'function') process.exit(1);
  `;
  const result = cp.spawnSync(process.execPath, ['-e', code], {
    cwd: info.installDir, timeout: 15000, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, `installed better-sqlite3 resolution failed. stderr: ${result.stderr?.slice(0, 400)}`);
  cleanupTarballInstall();
});

test('4C1: installed server require smoke', () => {
  const code = `
    const server = require('huqan/server');
    if (!server) process.exit(1);
    if (typeof server.closeAxiom === 'function') server.closeAxiom();
  `;
  const result = runInstalledNode(code, {
    timeout: 15000,
    env: { AXIOM_DISABLE_AUTO_LISTEN: '1', AXIOM_USE_SQLITE: 'false' },
  });
  assert.equal(result.status, 0, `installed server require failed. stderr: ${result.stderr?.slice(0, 400)}`);
  cleanupTarballInstall();
});
