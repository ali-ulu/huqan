'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadSqliteDriver } = require('./sqlite-availability');
const {
  ADDITIVE_COLUMNS,
  BASE_SCHEMA_SQL,
  SCHEMA_INDEXES,
  STORAGE_SCHEMA_VERSION,
} = require('./storage/schema');
const { resolveRustBin } = require('../rustGraph');
const {
  canWriteTo,
  resolvePersistencePaths,
  resolveReceiptsDir,
} = require('../persistencePaths');
const { validateEnvironmentCompatibility } = require('./environment-compat');

const DEFAULT_PROBE_TIMEOUT_MS = 4000;

const CHECK_ORDER = Object.freeze([
  ['sqlite', 'SQLite'],
  ['schema', 'Schema'],
  ['migrations', 'Migrations'],
  ['rust', 'Rust accelerator'],
  ['mcp', 'MCP'],
  ['filesystem', 'Filesystem'],
  ['config', 'Config'],
]);

function shortError(error) {
  return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').trim();
}

function expectedTables() {
  return [...BASE_SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/g)]
    .map((match) => match[1]);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function openDoctorDatabase(opts = {}) {
  const { Database, loadError } = loadSqliteDriver();
  if (!Database) throw loadError || new Error('better-sqlite3 is unavailable');
  const { dbPath } = resolvePersistencePaths({ rootDir: opts.rootDir || process.cwd() });
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  return { db, dbPath };
}

function checkSqlite(opts = {}) {
  const { db, dbPath } = openDoctorDatabase(opts);
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const values = rows.flatMap((row) => Object.values(row)).map((value) => String(value).toLowerCase());
    const ok = values.length > 0 && values.every((value) => value === 'ok');
    return {
      ok,
      detail: ok ? path.basename(dbPath) : `integrity_check: ${values.join(', ') || 'no result'}`,
      dbPath,
    };
  } finally {
    db.close();
  }
}

function checkSchema(opts = {}) {
  const { db } = openDoctorDatabase(opts);
  try {
    const missingTables = expectedTables().filter((table) => tableColumns(db, table).length === 0);
    const existingIndexes = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name),
    );
    const expectedIndexes = SCHEMA_INDEXES
      .map((sql) => /INDEX IF NOT EXISTS\s+([A-Za-z0-9_]+)/i.exec(sql)?.[1])
      .filter(Boolean);
    const missingIndexes = expectedIndexes.filter((name) => !existingIndexes.has(name));
    const pendingColumns = ADDITIVE_COLUMNS
      .filter((migration) => !tableColumns(db, migration.table).includes(migration.column))
      .map((migration) => `${migration.table}.${migration.column}`);
    const ok = missingTables.length === 0 && missingIndexes.length === 0 && pendingColumns.length === 0;
    return {
      ok,
      detail: ok
        ? `v${STORAGE_SCHEMA_VERSION}, ${ADDITIVE_COLUMNS.length} migrations applied`
        : [
          missingTables.length ? `missing tables: ${missingTables.join(', ')}` : '',
          missingIndexes.length ? `missing indexes: ${missingIndexes.join(', ')}` : '',
          pendingColumns.length ? `pending columns: ${pendingColumns.join(', ')}` : '',
        ].filter(Boolean).join('; '),
      version: STORAGE_SCHEMA_VERSION,
      missingTables,
      missingIndexes,
      pendingColumns,
    };
  } finally {
    db.close();
  }
}

function checkMigrations(opts = {}) {
  const rootDir = path.resolve(opts.rootDir || process.cwd());
  const migrationsDir = path.join(rootDir, 'migrations');
  const migrationFiles = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
    : [];
  const { db } = openDoctorDatabase(opts);
  try {
    const pending = ADDITIVE_COLUMNS
      .filter((migration) => !tableColumns(db, migration.table).includes(migration.column))
      .map((migration) => `${migration.table}.${migration.column}`);
    const liveObjects = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all().map((row) => row.name),
    );
    const missingMigrationObjects = [];
    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const declared = [
        ...[...sql.matchAll(/CREATE TABLE IF NOT EXISTS\\s+([A-Za-z0-9_]+)/gi)].map((match) => match[1]),
        ...[...sql.matchAll(/CREATE INDEX IF NOT EXISTS\\s+([A-Za-z0-9_]+)/gi)].map((match) => match[1]),
      ];
      for (const name of declared) if (!liveObjects.has(name)) missingMigrationObjects.push(`${file}:${name}`);
    }
    const ok = pending.length === 0 && missingMigrationObjects.length === 0 && migrationFiles.length > 0;
    return {
      ok,
      detail: ok
        ? `${ADDITIVE_COLUMNS.length}/${ADDITIVE_COLUMNS.length} additive; ${migrationFiles.length} SQL artifact(s) applied`
        : [
          pending.length ? `pending: ${pending.join(', ')}` : '',
          migrationFiles.length === 0 ? 'migrations/ has no .sql files' : '',
          missingMigrationObjects.length ? `missing migration objects: ${missingMigrationObjects.join(', ')}` : '',
        ].filter(Boolean).join('; '),
      applied: ADDITIVE_COLUMNS.length - pending.length,
      total: ADDITIVE_COLUMNS.length,
      pending,
      migrationFiles,
      missingMigrationObjects,
      source: 'lib/storage/schema.js + migrations/',
    };
  } finally {
    db.close();
  }
}

function parseCargoVersion(rootDir) {
  try {
    const text = fs.readFileSync(path.join(rootDir, 'huqan-core', 'Cargo.toml'), 'utf8');
    return /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] || '';
  } catch (_) {
    return '';
  }
}

function probeJsonLines(command, args, requests, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS;
  const spawnImpl = opts.spawnImpl || spawn;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let stderr = '';
    const responses = [];
    let child;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) {
        try { child.stdin.end(); } catch (_) {}
        try { child.kill(); } catch (_) {}
      }
      if (error) reject(error);
      else resolve({ responses, stderr });
    };

    try {
      child = spawnImpl(command, args, {
        cwd: opts.cwd || process.cwd(),
        env: opts.env || process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      const error = new Error(`health probe timed out after ${timeoutMs}ms`);
      error.code = 'DOCTOR_PROBE_TIMEOUT';
      finish(error);
    }, timeoutMs);

    child.on('error', finish);
    child.on('exit', (code, signal) => {
      if (!settled && responses.length < requests.length) {
        finish(new Error(`health probe exited early (code=${code}, signal=${signal || 'none'}): ${stderr.trim()}`));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { responses.push(JSON.parse(line)); } catch (_) { continue; }
        if (responses.length >= requests.length) {
          finish();
          return;
        }
      }
    });

    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
  });
}

async function checkRust(opts = {}) {
  const rootDir = path.resolve(opts.rootDir || process.cwd());
  const rustBin = resolveRustBin(opts.environment || process.env);
  fs.accessSync(rustBin, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
  const { responses } = await probeJsonLines(
    rustBin,
    [],
    [{ cmd: 'stats', _reqId: 1 }],
    { cwd: rootDir, env: opts.environment || process.env, timeoutMs: opts.timeoutMs, spawnImpl: opts.spawnImpl },
  );
  const response = responses.find((item) => item && item._reqId === 1) || responses[0];
  const ok = response?.ok === true && response?.stats && typeof response.stats === 'object';
  const version = parseCargoVersion(rootDir);
  return {
    ok,
    detail: ok ? (version ? `v${version}` : path.basename(rustBin)) : 'stats health check failed',
    binary: rustBin,
    version: version || null,
  };
}

async function checkMcp(opts = {}) {
  const rootDir = path.resolve(opts.rootDir || process.cwd());
  const entry = path.join(rootDir, 'bin', 'huqan-mcp.js');
  fs.accessSync(entry, fs.constants.R_OK);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  const { responses } = await probeJsonLines(
    process.execPath,
    [entry],
    requests,
    { cwd: rootDir, env: opts.environment || process.env, timeoutMs: opts.timeoutMs, spawnImpl: opts.spawnImpl },
  );
  const initialized = responses.find((item) => item?.id === 1);
  const toolsResponse = responses.find((item) => item?.id === 2);
  const tools = toolsResponse?.result?.tools;
  const ok = Boolean(initialized?.result?.serverInfo?.name) && Array.isArray(tools);
  return {
    ok,
    detail: ok ? `${tools.length} tools` : 'initialize/tools/list failed',
    server: initialized?.result?.serverInfo || null,
    toolCount: Array.isArray(tools) ? tools.length : 0,
  };
}

function checkFilesystem(opts = {}) {
  const rootDir = path.resolve(opts.rootDir || process.cwd());
  const { memoryPath } = resolvePersistencePaths({ rootDir });
  const receiptsDir = resolveReceiptsDir(opts.environment || process.env);
  const rootWritable = canWriteTo(rootDir, 'dir');
  const memoryWritable = canWriteTo(memoryPath, 'file');
  const receiptsWritable = canWriteTo(receiptsDir, 'dir');
  const ok = rootWritable && memoryWritable && receiptsWritable;
  return {
    ok,
    detail: ok ? rootDir : [
      rootWritable ? '' : 'workspace not writable',
      memoryWritable ? '' : 'memory.json not writable',
      receiptsWritable ? '' : 'receipts dir not writable',
    ].filter(Boolean).join('; '),
    rootDir,
    memoryPath,
    receiptsDir,
  };
}

function checkConfig(opts = {}) {
  const rootDir = path.resolve(opts.rootDir || process.cwd());
  const configPath = path.join(rootDir, 'config', 'trust-policy.default.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  validateEnvironmentCompatibility(opts.environment || process.env);
  const validShape = typeof config.version === 'string'
    && config.defaults && typeof config.defaults === 'object'
    && config.fallback && typeof config.fallback === 'object';
  return {
    ok: Boolean(validShape),
    detail: validShape ? `v${config.version}` : 'invalid trust-policy.default.json shape',
    configPath,
    version: config.version || null,
  };
}

const DEFAULT_CHECKERS = Object.freeze({
  sqlite: checkSqlite,
  schema: checkSchema,
  migrations: checkMigrations,
  rust: checkRust,
  mcp: checkMcp,
  filesystem: checkFilesystem,
  config: checkConfig,
});

async function runDoctorChecks(opts = {}, deps = {}) {
  const checkers = { ...DEFAULT_CHECKERS, ...(deps.checkers || {}) };
  const checks = {};
  for (const [key, label] of CHECK_ORDER) {
    try {
      const result = await Promise.resolve(checkers[key](opts));
      checks[key] = { name: label, ok: result?.ok === true, ...result };
    } catch (error) {
      checks[key] = { name: label, ok: false, detail: shortError(error), error: error?.code || 'CHECK_FAILED' };
    }
  }
  return { ok: Object.values(checks).every((check) => check.ok), checks };
}

function formatDoctorResult(result) {
  return CHECK_ORDER.map(([key, label]) => {
    const check = result.checks[key] || { ok: false, detail: 'not run' };
    const suffix = check.detail ? ` (${check.detail})` : '';
    return `${label.padEnd(17)} ${check.ok ? 'OK' : 'FAIL'}${suffix}`;
  }).join('\n');
}

async function runDoctorCommand(opts = {}, deps = {}) {
  const result = await runDoctorChecks(opts, deps);
  return { ...result, text: formatDoctorResult(result) };
}

module.exports = {
  CHECK_ORDER,
  DEFAULT_CHECKERS,
  checkSqlite,
  checkSchema,
  checkMigrations,
  checkRust,
  checkMcp,
  checkFilesystem,
  checkConfig,
  probeJsonLines,
  runDoctorChecks,
  formatDoctorResult,
  runDoctorCommand,
};
