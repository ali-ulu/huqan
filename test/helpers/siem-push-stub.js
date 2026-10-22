'use strict';

// Preloaded (`node --require`) into the real `huqan-gate-hook` process by
// test/siem-export-cli.test.js. It replaces the two ways the SIEM push sinks
// leave the machine -- `fetch` and `tls.connect` -- with recorders, so the CLI
// runs end to end, argument parsing, policy, sink and cursor included, without
// a network. Each call is appended to SIEM_STUB_LOG as one JSON line;
// SIEM_STUB_STATUS sets the HTTP status the stub answers with.

const fs = require('node:fs');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');

const logPath = process.env.SIEM_STUB_LOG;
const record = entry => fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);

globalThis.fetch = async (url, init) => {
  record({ transport: 'http', url: String(url), headers: init.headers, body: init.body });
  const status = Number(process.env.SIEM_STUB_STATUS || 200);
  return { status, headers: {}, text: async () => '{"errors":false,"items":[]}' };
};

tls.connect = (options) => {
  const socket = new EventEmitter();
  const chunks = [];
  socket.write = chunk => { chunks.push(String(chunk)); return true; };
  socket.end = callback => setImmediate(() => {
    record({ transport: 'syslog', options, payload: chunks.join('') });
    if (callback) callback();
    // A collector closes its side on our FIN; the sink counts only a clean close.
    socket.emit('close', false);
  });
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  setImmediate(() => socket.emit('secureConnect'));
  return socket;
};
