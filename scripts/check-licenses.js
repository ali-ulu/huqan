#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DENIED_LICENSE = /(?:^|[\s(])(?:AGPL-(?:1\.0|2\.0)|GPL-(?:1\.0|2\.0|3\.0)|LGPL-(?:2\.0|2\.1|3\.0)|SSPL|BUSL|Commons-Clause|UNLICENSED|PROPRIETARY)(?:-only|-or-later)?(?:$|[\s)])/i;
const NON_COMMERCIAL = /(?:CC-BY-NC|CC-BY-ND)/i;

function packageNameFromPath(packagePath) {
  if (!packagePath.startsWith('node_modules/')) return packagePath || '<root>';
  return packagePath.slice('node_modules/'.length);
}

function checkLicenses(lockfile, exceptions = {}) {
  const violations = [];
  const packages = lockfile && lockfile.packages;
  if (!packages || typeof packages !== 'object') {
    return [{ package: '<lockfile>', license: '<missing>', reason: 'package-lock.json has no packages map' }];
  }

  for (const [packagePath, metadata] of Object.entries(packages)) {
    if (packagePath === '') continue;
    const name = packageNameFromPath(packagePath);
    const declaredLicense = metadata && metadata.license;
    const license = typeof declaredLicense === 'string' && declaredLicense.trim() ? declaredLicense : '<missing>';
    const exception = exceptions[name];

    if (exception && exception.license === license && exception.reason) continue;
    if (license === '<missing>') {
      violations.push({ package: name, license, reason: 'dependency does not declare a license' });
      continue;
    }
    if (DENIED_LICENSE.test(license) || NON_COMMERCIAL.test(license) || /SEE LICENSE IN/i.test(license)) {
      violations.push({ package: name, license, reason: 'license is not approved for HUQAN dependency use' });
    }
  }

  return violations;
}

function parseArgs(argv) {
  const lockIndex = argv.indexOf('--lockfile');
  const exceptionsIndex = argv.indexOf('--exceptions');
  return {
    lockfilePath: lockIndex >= 0 ? argv[lockIndex + 1] : path.join(process.cwd(), 'package-lock.json'),
    exceptionsPath: exceptionsIndex >= 0 ? argv[exceptionsIndex + 1] : path.join(process.cwd(), 'config', 'license-exceptions.json'),
  };
}

function readJson(filePath, optional = false) {
  if (optional && !fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main(argv = process.argv.slice(2)) {
  const { lockfilePath, exceptionsPath } = parseArgs(argv);
  const lockfile = readJson(lockfilePath);
  const exceptions = readJson(exceptionsPath, true);
  const violations = checkLicenses(lockfile, exceptions);

  if (violations.length) {
    console.error(`License compliance failed: ${violations.length} violation(s)`);
    for (const item of violations) console.error(`- ${item.package}: ${item.license} (${item.reason})`);
    return 1;
  }

  const dependencyCount = Math.max(0, Object.keys(lockfile.packages || {}).length - 1);
  console.log(`License compliance passed: ${dependencyCount} locked dependencies checked`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkLicenses, main, packageNameFromPath };
