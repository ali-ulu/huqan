'use strict';

// The gate daemon's transport (#perf). The main classification map sits at the
// 400-line budget (#328), so this entry is merged in as a plain union, exactly
// like the #4070 M4 and #4071 M10 clusters.
const GATE_DAEMON_CLASSIFIED = Object.freeze({
  'lib/gate-hook-daemon.js': Object.freeze({
    role: 'enforcement',
    why: 'the gate hook\'s own transport (#perf): one long-lived process answers hook calls over a local'
      + ' unix socket (a named pipe on Windows), so a call does not reload the whole evaluation chain'
      + ' every time. Its three capabilities are all part of being that transport -- it binds the socket,'
      + ' chmods it 0600 and writes its own pid beside it, and spawns the detached daemon with argv fixed'
      + ' in source (bin/huqan-gate-hook.js daemon serve). It never decides: every request runs the same'
      + ' runHookEvaluation a one-shot call does, one at a time, fail-closed on any error, and the socket'
      + ' is local only. Gating the gate\'s own listener would be circular',
  }),
  'lib/gate-hook-daemon-state.js': Object.freeze({
    role: 'enforcement',
    why: 'where the gate daemon keeps its machine-local state (#perf, split out of lib/gate-hook-daemon.js'
      + ' at the 400-line budget): the socket path and its pid/log/identity siblings under the 0700 state'
      + ' root, plus symlink-safe writes (O_NOFOLLOW/O_EXCL, 0600) and a pid-liveness probe. The fs_write'
      + ' sites the inventory records are the daemon\'s own pid, log and identity files, reached through'
      + ' rmSync and writeFileSync; openLogPrivate opens the log through a flag-based openSync, which the'
      + ' scanner does not count today (see the flag-based-open blind spot in scripts/binding-site-scan.js),'
      + ' so this entry names the files, not every call that touches them. The egress site is a connect()'
      + ' to the local unix socket to prove a listener owns a pid before SIGTERM, never a remote host. It'
      + ' decides nothing: it only says where the transport lives and whether it is alive',
  }),
});

module.exports = { GATE_DAEMON_CLASSIFIED };
