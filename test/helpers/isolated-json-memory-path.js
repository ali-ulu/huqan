'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const roots = new Set();

function isolatedJsonMemoryPath(label = 'kernel') {
  const safeLabel = String(label).replace(/[^a-z0-9_-]+/gi, '-');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-test-json-${safeLabel}-`));
  roots.add(root);
  return path.join(root, 'memory.json');
}

process.once('exit', () => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_) {}
  }
});

module.exports = { isolatedJsonMemoryPath };

