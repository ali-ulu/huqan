'use strict';

// #4093 PR-B4: the syslog push transport. RFC 5424 messages over TCP+TLS with
// RFC 6587 octet-counting framing; there is deliberately no UDP and no plain
// TCP (INV-B5). The TLS socket is injected, so the framing, the verification
// options and the failure paths are asserted without a network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { SIEM_SYSLOG_ERRORS, createSiemSyslogSink } = require('../lib/siem/siem-syslog-sink');
const { SIEM_PUSH_ERRORS } = require('../lib/siem/siem-push-policy');

// No policy file, no expected-egress environment: the destination gates are inert.
const HERMETIC = Object.freeze({ environment: {}, dataResidency: null });

function event(id, decision, action = 'admit') {
  return { 'event.id': id, 'event.action': action, 'huqan.decision': decision, '@timestamp': '2026-10-21T15:01:00.000Z' };
}

/** A stand-in TLS socket: records what was written and how it was opened. */
function fakeConnect({ fail = null, stall = false, endError = null, closeEarly = false } = {}) {
  const opened = [];
  const connect = (options) => {
    const socket = new EventEmitter();
    socket.written = [];
    socket.destroyed = false;
    socket.write = (chunk) => { socket.written.push(String(chunk)); return true; };
    socket.end = (callback) => {
      setImmediate(() => {
        if (closeEarly) { socket.emit('close', false); return; }
        if (callback) callback(endError);
        socket.emit('close', Boolean(endError));
      });
    };
    socket.setTimeout = (ms, onTimeout) => { if (stall) setImmediate(onTimeout); };
    socket.destroy = (error) => { socket.destroyed = true; if (error) setImmediate(() => socket.emit('error', error)); };
    opened.push({ options, socket });
    setImmediate(() => {
      if (fail) socket.emit('error', fail);
      else if (!stall) socket.emit('secureConnect');
    });
    return socket;
  };
  return { connect, opened };
}

function frames(raw) {
  const out = [];
  let rest = raw;
  while (rest.length > 0) {
    const space = rest.indexOf(' ');
    const length = Number(rest.slice(0, space));
    const body = Buffer.from(rest.slice(space + 1), 'utf8').subarray(0, length).toString('utf8');
    out.push(body);
    rest = rest.slice(space + 1 + body.length);
  }
  return out;
}

test('refuses non-tls syslog and plain http endpoints', () => {
  for (const url of ['udp://siem.example.com:514', 'tcp://siem.example.com:514', 'syslog://siem.example.com:514', 'http://siem.example.com']) {
    assert.throws(() => createSiemSyslogSink({ ...HERMETIC, url }), { code: SIEM_SYSLOG_ERRORS.INVALID_CONFIG });
  }
});

test('refuses a syslog endpoint that carries credentials, a path, a query or a fragment', () => {
  for (const url of ['syslog+tls://u:p@siem.example.com:6514', 'syslog+tls://siem.example.com:6514/x', 'syslog+tls://siem.example.com:6514?a=b', 'syslog+tls://siem.example.com:6514#f']) {
    assert.throws(() => createSiemSyslogSink({ ...HERMETIC, url }), { code: SIEM_SYSLOG_ERRORS.INVALID_CONFIG });
  }
});

test('connects over TLS 1.2+ with certificate verification on and the RFC 5425 default port', async () => {
  const { connect, opened } = fakeConnect();
  const sink = createSiemSyslogSink({ ...HERMETIC, url: 'syslog+tls://siem.example.com', connect, hostname: 'h' });
  assert.equal(sink.kind, 'syslog');
  assert.equal(sink.host, 'siem.example.com');
  await sink.write(['m'], [event('a', 'allow')]);
  const { options } = opened[0];
  assert.equal(options.host, 'siem.example.com');
  assert.equal(options.port, 6514);
  assert.equal(options.servername, 'siem.example.com');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.minVersion, 'TLSv1.2');
});

test('frames each event as an octet-counted RFC 5424 message with severity from the decision', async () => {
  const { connect, opened } = fakeConnect();
  const sink = createSiemSyslogSink({ ...HERMETIC, url: 'syslog+tls://siem.example.com:6514', connect, hostname: 'gate-host' });
  const result = await sink.write(
    ['CEF:0|HUQAN|block', 'CEF:0|HUQAN|review', 'CEF:0|HUQAN|allow ü'],
    [event('a', 'block'), event('b', 'review'), event('c', 'allow', 'stop')],
  );
  assert.equal(result.delivered, 3);
  const messages = frames(opened[0].socket.written.join(''));
  // local0 (16): block -> warning (4), review -> notice (5), otherwise informational (6).
  assert.deepEqual(messages, [
    '<132>1 2026-10-21T15:01:00.000Z gate-host huqan - admit - CEF:0|HUQAN|block',
    '<133>1 2026-10-21T15:01:00.000Z gate-host huqan - admit - CEF:0|HUQAN|review',
    '<134>1 2026-10-21T15:01:00.000Z gate-host huqan - stop - CEF:0|HUQAN|allow ü',
  ]);
});

test('a header field a forwarder could misparse is replaced, never passed through', async () => {
  const { connect, opened } = fakeConnect();
  const sink = createSiemSyslogSink({ ...HERMETIC, url: 'syslog+tls://siem.example.com', connect, hostname: 'bad host\nname' });
  await sink.write(['x'], [{ 'event.id': 'a', 'event.action': 'ad min', '@timestamp': 'not a time' }]);
  const [message] = frames(opened[0].socket.written.join(''));
  assert.equal(message, '<134>1 - bad-host-name huqan - ad-min - x');
});

test('a TLS handshake failure rejects the write so the cursor stays', async () => {
  const failure = Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  const { connect, opened } = fakeConnect({ fail: failure });
  const sink = createSiemSyslogSink({ ...HERMETIC, url: 'syslog+tls://siem.example.com', connect, hostname: 'h' });
  await assert.rejects(sink.write(['x'], [event('a', 'allow')]), { code: SIEM_SYSLOG_ERRORS.FAILED });
  assert.deepEqual(opened[0].socket.written, []);
});

test('a connection that stalls times out and is torn down', async () => {
  const { connect, opened } = fakeConnect({ stall: true });
  const sink = createSiemSyslogSink({ ...HERMETIC, url: 'syslog+tls://siem.example.com', connect, hostname: 'h', timeoutMs: 100 });
  await assert.rejects(sink.write(['x'], [event('a', 'allow')]), { code: SIEM_SYSLOG_ERRORS.TIMEOUT });
  assert.equal(opened[0].socket.destroyed, true);
});

test('writing nothing opens no connection', async () => {
  const { connect, opened } = fakeConnect();
  const sink = createSiemSyslogSink({ ...HERMETIC, url: 'syslog+tls://siem.example.com', connect, hostname: 'h' });
  assert.deepEqual(await sink.write([], []), { delivered: 0 });
  assert.equal(opened.length, 0);
});

test('a write the stream reports as failed is not counted as delivered', async () => {
  const { connect } = fakeConnect({ endError: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) });
  const sink = createSiemSyslogSink({ ...HERMETIC, url: 'syslog+tls://siem.example.com', connect, hostname: 'h' });
  await assert.rejects(sink.write(['x'], [event('a', 'allow')]), (error) => error.code === SIEM_SYSLOG_ERRORS.FAILED && /EPIPE/.test(error.message));
});

test('a connection that closes before the frames were flushed is a failure', async () => {
  const { connect } = fakeConnect({ closeEarly: true });
  const sink = createSiemSyslogSink({ ...HERMETIC, url: 'syslog+tls://siem.example.com', connect, hostname: 'h' });
  await assert.rejects(sink.write(['x'], [event('a', 'allow')]), { code: SIEM_SYSLOG_ERRORS.FAILED });
});

test('the destination is judged when the sink is built, so a blocked host never gets a sink', () => {
  assert.throws(() => createSiemSyslogSink({
    url: 'syslog+tls://siem.example.com',
    dataResidency: { allowedDestinations: ['example.com.tr'] },
    environment: {},
  }), { code: SIEM_PUSH_ERRORS.BLOCKED });
});

test('a connect that throws at once is reported, not left to the deadline', async () => {
  const connect = () => { throw Object.assign(new Error('bad options'), { code: 'ERR_INVALID_ARG_VALUE' }); };
  const sink = createSiemSyslogSink({ ...HERMETIC, url: 'syslog+tls://siem.example.com', connect, hostname: 'h', timeoutMs: 60_000 });
  const started = Date.now();
  await assert.rejects(sink.write(['x'], [event('a', 'allow')]), { code: SIEM_SYSLOG_ERRORS.FAILED });
  assert.ok(Date.now() - started < 5_000);
});
