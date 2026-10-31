'use strict';

// #4070 COG-M4 Lab cluster. The main classification map sits at the 400-line
// budget (#328), so this cluster is merged in as a plain union, exactly like
// the #4071 M10 cluster.
const M4_CLASSIFIED = Object.freeze({
  'lib/cognitive-lab-m4-episode.js': Object.freeze({ role: 'operator_tool', why: '#4070 M4 episode creates and removes only its own temporary memory store directory, opens no persistent store and adds no production authority.' }),
  'lib/cognitive-lab-m4-runner.js': Object.freeze({ role: 'operator_tool', why: '#4070 explicitly invoked M4 measurement runner; writes only its own single-use manifest and report files under the caller-named work directory, opens no store and adds no production authority.' }),
});

module.exports = { M4_CLASSIFIED };
