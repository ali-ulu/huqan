'use strict';

const fs = require('node:fs');
const Database = require('better-sqlite3');

const dbPath = process.argv[2];
if (!dbPath) process.exit(2);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS fault_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO fault_probe (value) VALUES (?)').run('must-not-commit');
fs.writeSync(1, 'READY\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
