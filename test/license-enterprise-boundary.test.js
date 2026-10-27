'use strict';

// The enterprise boundary is a path list in LICENSE-ENTERPRISE plus an SPDX
// header in every file under those paths. The two must not drift: a file added
// under lib/saml/ without the header would read as Apache-2.0, and a header
// outside the listed paths would claim commercial terms nobody published.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HEADER = 'SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise';
const ENTERPRISE_PATHS = ['lib/saml/', 'lib/oidc/', 'lib/siem/', 'lib/evidence-pack/'];

function jsFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}${entry.name}`;
    if (entry.isDirectory()) return jsFiles(`${rel}/`);
    return entry.name.endsWith('.js') ? [rel] : [];
  });
}

test('LICENSE-ENTERPRISE lists exactly the enterprise paths', () => {
  const text = fs.readFileSync(path.join(ROOT, 'LICENSE-ENTERPRISE'), 'utf8');
  const listed = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^lib\/.+\/$/.test(line));
  assert.deepEqual(listed, ENTERPRISE_PATHS);
});

test('every file under an enterprise path carries the enterprise header', () => {
  for (const dir of ENTERPRISE_PATHS) {
    const files = jsFiles(dir);
    assert.ok(files.length > 0, `${dir} must not be empty`);
    for (const file of files) {
      const firstLine = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/, 1)[0];
      assert.equal(firstLine, `// ${HEADER}`, `${file} must start with the enterprise SPDX header`);
    }
  }
});

test('no file outside the enterprise paths claims the enterprise license', () => {
  for (const file of jsFiles('lib/')) {
    if (ENTERPRISE_PATHS.some((dir) => file.startsWith(dir))) continue;
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!text.includes(HEADER), `${file} is core and must not carry the enterprise header`);
  }
});

test('the Apache LICENSE points readers at the enterprise carve-out', () => {
  const text = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(text, /Apache License\s+Version 2\.0/);
  assert.match(text, /LICENSE-ENTERPRISE/);
});
