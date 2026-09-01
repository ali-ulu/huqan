'use strict';

const { registerPiGuard } = require('huqan');

module.exports = function huqanExternalActionGuard(pi) {
  registerPiGuard(pi);
};
