'use strict';

// #4071 COG-M10 Lab cluster. The main classification map sits at the 400-line
// budget (#328), so this cluster is merged in as a plain union, exactly like
// the #4196 injected-fetch cluster.
const M10_CLASSIFIED = Object.freeze({
  'lib/cognitive-lab-m10-episode.js': Object.freeze({ role: 'operator_tool', why: '#4071 M10 episode creates and removes only its own temporary graph directory, opens no persistent store and adds no production authority.' }),
  'lib/cognitive-lab-m10-runner.js': Object.freeze({ role: 'operator_tool', why: '#4071 explicitly invoked M10 measurement runner; writes only its own single-use manifest and report files under the caller-named work directory, opens no store and adds no production authority.' }),
});

module.exports = { M10_CLASSIFIED };
