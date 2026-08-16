'use strict';

/**
 * Moved to lib/a2a/replay-store.js alongside the evaluator (P0-B).
 *
 * The route needs the same reservation owner the harness proved: replay
 * rejection is one of the fifty conformance cases, including the two-process
 * concurrent case, and a second implementation would be a second set of
 * concurrency bugs.
 */

module.exports = require('../../lib/a2a/replay-store');
