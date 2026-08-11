'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHA256 = /^[0-9a-f]{64}$/;

function createA2aConformanceReplayStore(directory) {
  const root = path.resolve(directory);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync.native(root) !== root) {
    throw new Error('A2A replay directory must be a real directory');
  }

  function reserve(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.keys(record).length !== 1 || !SHA256.test(record.replayKey)) {
      throw new Error('A2A replay key is invalid');
    }
    const target = path.join(root, `${record.replayKey}.reserved`);
    let descriptor;
    try {
      descriptor = fs.openSync(target, 'wx', 0o600);
      fs.writeFileSync(descriptor, record.replayKey, 'utf8');
      fs.fsyncSync(descriptor);
      return Object.freeze({ reserved: true });
    } catch (error) {
      if (error?.code === 'EEXIST') return Object.freeze({ reserved: false });
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  return Object.freeze({ reserve });
}

module.exports = Object.freeze({ createA2aConformanceReplayStore });
