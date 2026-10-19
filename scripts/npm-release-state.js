'use strict';

/**
 * What the registry holds for the version this release run is publishing.
 *
 * v1.1.0 and v1.1.1 showed two ways the publish workflow misread a real
 * release:
 *
 *   - `npm publish` uploaded the tarball, npm answered `409 Cannot publish over
 *     previously staged version "1.1.0"`, and the run failed -- while the
 *     registry promoted that very upload a few minutes later.
 *   - v1.1.1 answered `You cannot publish over the previously published
 *     versions: 1.1.1` instead, and the run failed the same way, with the
 *     version already live from that commit.
 *
 * Both now ask one question: is `name@version` on the registry, did *this
 * commit* put it there through the GitHub trusted publisher, and is it the
 * tarball this run packed? Only that answer is ever adopted as a success. A
 * version from another commit, from a personal account, or carrying different
 * bytes stays a refusal, exactly as before.
 *
 *   node scripts/npm-release-state.js existing <name> <version> <sha>
 *   node scripts/npm-release-state.js settle   <name> <version> <sha> <publish-log>
 *
 * The trusted-publisher half of that question is read from a dotted `npm view`
 * path, never from `_npmUser`; see VIEW_FIELDS for why (#4056).
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/**
 * npm answers a version the registry already holds in two shapes, and which
 * one it uses depends on whether the earlier upload was still staged or
 * already promoted: a staged one is a 409, a promoted one a 403. Both mean
 * the same thing here -- the registry holds the version -- and the evidence
 * below decides whether that is ours.
 */
const ALREADY_ON_REGISTRY = /cannot publish over (?:previously staged version|the previously published versions)/i;

/**
 * The shasum of the tarball npm packed, printed before the upload attempt.
 *
 * v1.1.0's failed publish log carries it, so a run that failed still knows
 * exactly what it was about to publish, and the registry's copy of the
 * version can be compared against those bytes.
 */
const SHASUM_NOTICE = /npm notice shasum:\s*([0-9a-f]{40})/i;

const DEFAULT_SETTLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SETTLE_INTERVAL_MS = 20 * 1000;

/**
 * `gitHead` and the trusted-publisher claim, asked for by dotted path (#4056).
 * npm 11 matches `_npmUser` in `view.js`'s `cleanup()` on `data.trustedPublisher`
 * too, so it renders that object as the string
 * `"GitHub Actions <npm-oidc-no-reply@github.com>"`; npm 10 leaves it an
 * object. The dotted path is the same plain `"github"` on both, so the field
 * list is one every npm answers identically.
 *
 * `name` and `version` are requested alongside so the reply stays an object:
 * npm collapses it to a bare scalar when exactly one requested field has a
 * value, which is what a record carrying a trusted publisher but no `gitHead`
 * would otherwise be.
 *
 * `dist.shasum` is the registry's shasum of the tarball it holds, and it
 * answers the same plain way under both npm versions: the shasum of the
 * 1.1.1 tarball is `17afe43a...`, byte for byte what that release's own
 * publish step packed.
 */
const TRUSTED_PUBLISHER_FIELD = '_npmUser.trustedPublisher.id';
const SHASUM_FIELD = 'dist.shasum';
const VIEW_FIELDS = ['name', 'version', 'gitHead', TRUSTED_PUBLISHER_FIELD, SHASUM_FIELD];

/**
 * 'absent' | 'published-from-this-commit' | 'published-elsewhere'
 * | 'published-different-tarball'
 */
function classifyRegistryVersion(view, sha, expectedShasum = '') {
  if (!view) return 'absent';
  const fromThisCommit = view.gitHead === sha;
  const viaTrustedPublisher = view[TRUSTED_PUBLISHER_FIELD] === 'github';
  if (!fromThisCommit || !viaTrustedPublisher) return 'published-elsewhere';
  // The commit and the publisher say who published the version; the shasum
  // says whether the bytes on the registry are the ones this run packed and
  // every gate above it ran against.
  if (expectedShasum && view[SHASUM_FIELD] !== expectedShasum) return 'published-different-tarball';
  return 'published-from-this-commit';
}

/** Whether the publish log says the registry already holds this version. */
function isAlreadyOnRegistry(log) {
  return ALREADY_ON_REGISTRY.test(String(log || ''));
}

/** The shasum of the tarball this run packed, read from the publish log. */
function packedShasum(log) {
  const match = String(log || '').match(SHASUM_NOTICE);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Poll until the version on the registry is served from this commit, or the
 * deadline passes. Stops early on a version published from elsewhere:
 * waiting cannot turn that into ours.
 */
async function settleStagedPublish({ lookup, sha, expectedShasum = '', timeoutMs, intervalMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = classifyRegistryVersion(await lookup(), sha, expectedShasum);
    if (state !== 'absent') return state;
    if (now() + intervalMs > deadline) return state;
    await sleep(intervalMs);
  }
}

/** npm's stdout for `npm view` of one version, as this module reads it. */
function parseRegistryView(output) {
  if (!output) return null;
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  // npm 12 answers `npm view --json` with an array (#3323).
  const record = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  return record && typeof record === 'object' ? record : null;
}

/** The registry's record for name@version, or null when it serves none. */
function registryView(name, version) {
  try {
    const output = execFileSync('npm', ['view', `${name}@${version}`, ...VIEW_FIELDS, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    }).trim();
    return parseRegistryView(output);
  } catch {
    // npm exits non-zero with E404 for a version it does not serve.
    return null;
  }
}

async function main(argv, env, out, err) {
  const [command, name, version, sha, logPath] = argv.slice(2);
  if (!['existing', 'settle'].includes(command) || !name || !version || !sha || (command === 'settle' && !logPath)) {
    err('usage: npm-release-state.js existing <name> <version> <sha>\n'
      + '       npm-release-state.js settle <name> <version> <sha> <publish-log>\n');
    return 2;
  }

  if (command === 'existing') {
    const state = classifyRegistryVersion(registryView(name, version), sha);
    out(`${state}\n`);
    if (state === 'published-elsewhere') {
      err(`${name}@${version} is already on the registry from another commit or publisher.\n`
        + 'npm versions are immutable; bump the version instead.\n');
      return 1;
    }
    return 0;
  }

  let log = '';
  try {
    log = fs.readFileSync(logPath, 'utf8');
  } catch (error) {
    err(`could not read ${logPath}: ${error.message}\n`);
    return 1;
  }
  if (!isAlreadyOnRegistry(log)) return 1;

  // The tarball this run packed, so the registry's copy of the version can be
  // compared against the bytes every gate above the publish step ran on.
  const expectedShasum = packedShasum(log);
  err(`npm reported ${name}@${version} as already on the registry; waiting for it to be served from ${sha}.\n`);
  const state = await settleStagedPublish({
    lookup: async () => registryView(name, version),
    sha,
    expectedShasum,
    timeoutMs: Number(env.NPM_SETTLE_TIMEOUT_MS) || DEFAULT_SETTLE_TIMEOUT_MS,
    intervalMs: Number(env.NPM_SETTLE_INTERVAL_MS) || DEFAULT_SETTLE_INTERVAL_MS,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
  });
  out(`${state}\n`);
  if (state === 'published-from-this-commit') return 0;
  err(state === 'absent'
    ? `${name}@${version} did not appear on the registry before the deadline.\n`
    : state === 'published-different-tarball'
      ? `${name}@${version} is on the registry from this commit, but its tarball is not the one this run packed (this run packed shasum ${expectedShasum}).\n`
      : `${name}@${version} is on the registry, but not from this commit through the trusted publisher.\n`);
  return 1;
}

if (require.main === module) {
  main(process.argv, process.env, (text) => process.stdout.write(text), (text) => process.stderr.write(text))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`npm-release-state: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  classifyRegistryVersion,
  parseRegistryView,
  isAlreadyOnRegistry,
  packedShasum,
  settleStagedPublish,
  main,
};
