"use strict";

// Extracted 1:1 into lib/risk-classify.js (mechanical pure-function
// move for #328, zero behaviour change). This module is now a
// re-export shim so existing require() paths keep working.
module.exports = require("./risk-classify");
