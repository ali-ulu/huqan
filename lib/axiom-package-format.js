'use strict';

/**
 * The AXIOM-era module name, retained as a re-export.
 *
 * The implementation moved to lib/huqan-package-format.js, which is what it
 * had always been: the module reads both ATP 0.1 (`axiom-package`) and HTP 0.2
 * (`huqan-package`), and writes only the canonical one. Naming it after the
 * legacy format it merely reads was backwards.
 *
 * This file stays because lib/ ships in package.json's `files` and an external
 * consumer may already require it by this path. Nothing in this repository
 * does.
 */
module.exports = require('./huqan-package-format');
