#!/usr/bin/env node
'use strict';

// Runs every case group in order, then reports. The sections are siblings of
// this file; run.js copies consumer*.js and verify-bundle.js into the throwaway
// consumer project together.

require('./consumer-package-wire');
require('./consumer-objects');
require('./consumer-bundles');
require('./consumer-python');
require('./consumer-schema');
require('./consumer-v5');
require('./consumer-replay');

const { finish } = require('./consumer-harness');

finish();
