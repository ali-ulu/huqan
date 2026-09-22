#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSyncWindowsAware } = require('./spawn-windows-aware');

const ROOT = path.resolve(__dirname, '..');
const TYPESCRIPT_VERSION = '5.9.2';

function publishedDeclarations(packageJson) {
  return (packageJson.files || [])
    .filter((file) => file.endsWith('.d.ts'))
    .map((file) => ({
      file,
      specifier: file === 'index.d.ts'
        ? packageJson.name
        : `${packageJson.name}/${file.replace(/\.d\.ts$/, '')}`,
    }))
    .sort((a, b) => a.specifier.localeCompare(b.specifier));
}

function identifierFor(file, index) {
  const stem = file.replace(/\.d\.ts$/, '').replace(/[^A-Za-z0-9_$]/g, '_');
  return `PublicDecl_${index}_${stem || 'root'}`;
}

function generateConsumerSources(packageJson, rootDir = ROOT) {
  const declarations = publishedDeclarations(packageJson);
  const esm = [];
  const cjs = [];

  declarations.forEach((entry, index) => {
    const id = identifierFor(entry.file, index);
    const source = fs.readFileSync(path.join(rootDir, entry.file), 'utf8');
    if (/\bexport\s*=/.test(source)) {
      esm.push(`import ${id} from '${entry.specifier}';`, `void ${id};`);
    } else {
      esm.push(`import * as ${id} from '${entry.specifier}';`, `void ${id};`);
    }
    cjs.push(`import ${id} = require('${entry.specifier}');`, `void ${id};`);
  });

  return {
    declarations,
    esm: `${esm.join('\n')}\n`,
    cjs: `${cjs.join('\n')}\n`,
  };
}

function run(command, args, options = {}) {
  let executable = command;
  if (process.platform === 'win32' && command === 'npm') executable = 'npm.cmd';
  const result = spawnSyncWindowsAware(executable, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 10 * 60 * 1000,
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const generated = generateConsumerSources(packageJson);
  if (generated.declarations.length === 0) throw new Error('No published .d.ts files found in package.json#files.');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-consumer-compile-'));
  try {
    const packOutput = run('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      tempRoot,
    ]);
    const packed = JSON.parse(packOutput);
    if (!Array.isArray(packed) || !packed[0]?.filename) throw new Error('npm pack did not report a tarball filename.');
    const tarball = path.join(tempRoot, packed[0].filename);

    const consumerDir = path.join(tempRoot, 'consumer');
    fs.mkdirSync(consumerDir, { recursive: true });
    fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
      name: 'huqan-consumer-compile-fixture',
      private: true,
      version: '0.0.0',
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(consumerDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'node',
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        skipLibCheck: false,
      },
      include: ['import-style.ts', 'require-style.ts'],
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(consumerDir, 'import-style.ts'), generated.esm);
    fs.writeFileSync(path.join(consumerDir, 'require-style.ts'), generated.cjs);

    run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=optional',
      tarball,
      `typescript@${TYPESCRIPT_VERSION}`,
    ], { cwd: consumerDir });

    const tsc = path.join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc');
    run(process.execPath, [tsc, '--project', 'tsconfig.json', '--noEmit', '--strict'], { cwd: consumerDir });
    console.log(
      `Consumer compile passed for ${generated.declarations.length} published declaration surface(s) `
      + `with TypeScript ${TYPESCRIPT_VERSION}.`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = { generateConsumerSources, publishedDeclarations };
