'use strict';

/**
 * #1676: local credential artifacts must never reach the Docker build context.
 *
 * The runtime stage ends in `COPY . .`, so anything the daemon sends is baked
 * into an image layer -- a later `RUN rm` does not remove it. This test is the
 * regression check: it evaluates .dockerignore the way the daemon does (Go
 * filepath.Match semantics, `**` spanning path segments, last matching pattern
 * wins, `!` re-includes) and asserts that representative secret filenames are
 * excluded while the files the image genuinely needs are not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const IGNORE_FILE = path.join(__dirname, '..', '.dockerignore');

function patternToRegExp(pattern) {
  const segments = pattern.split('/');
  let source = '^';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      // `**` spans zero or more path segments.
      source += last ? '.*' : '(?:.*/)?';
      return;
    }
    let segmentSource = '';
    for (const character of segment) {
      if (character === '*') segmentSource += '[^/]*';
      else if (character === '?') segmentSource += '[^/]';
      else segmentSource += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    source += segmentSource;
    if (!last) source += '/';
  });
  // A matched directory excludes everything beneath it.
  source += '(?:/.*)?$';
  return new RegExp(source);
}

function loadRules() {
  return fs
    .readFileSync(IGNORE_FILE, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const negated = line.startsWith('!');
      const pattern = negated ? line.slice(1) : line;
      return { negated, pattern, regexp: patternToRegExp(pattern) };
    });
}

const rules = loadRules();

/** True when the daemon would leave the path out of the build context. */
function isExcluded(filePath) {
  let excluded = false;
  for (const rule of rules) {
    if (rule.regexp.test(filePath)) excluded = !rule.negated;
  }
  return excluded;
}

const SECRET_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
  'config/.env',
  'packages/huqan-core/.env.test',
  '.npmrc',
  'packages/huqan-core/.npmrc',
  '.yarnrc.yml',
  '.netrc',
  '.pypirc',
  '.aws/credentials',
  '.ssh/id_rsa',
  '.ssh/id_ed25519',
  '.gnupg/secring.gpg',
  'id_rsa',
  'id_ed25519.pub',
  'server.key',
  'certs/server.key',
  'server.pem',
  'certs/fullchain.pem',
  'tls.crt',
  'certs/tls.crt',
  'client.p12',
  'client.pfx',
  'secrets.json',
  'config/secrets.json',
  'app.secrets.json',
  'credentials',
  'config/credentials',
  'service-account.json',
  'service-account-prod.json',
  'gha-creds-1234.json',
];

for (const secretPath of SECRET_PATHS) {
  test(`${secretPath} is excluded from the Docker build context`, () => {
    assert.equal(isExcluded(secretPath), true, `${secretPath} would be copied into the image`);
  });
}

const REQUIRED_PATHS = [
  'package.json',
  'package-lock.json',
  'server.js',
  'mcpServer.js',
  'cli.js',
  'graph.js',
  'index.js',
  'lib/mutation-journal.js',
  'schemas/v5/agent-identity-conformance.js',
  'README.md',
  '.env.example',
  'config/.env.example',
];

for (const requiredPath of REQUIRED_PATHS) {
  test(`${requiredPath} is still available to the build`, () => {
    assert.equal(isExcluded(requiredPath), false, `${requiredPath} was excluded from the build context`);
  });
}

test('the runtime stage copies the whole context, so the denylist is the only guard', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY --chown=node:node \. \.$/m);
});
