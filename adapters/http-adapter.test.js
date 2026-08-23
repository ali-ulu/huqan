const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const {
  fetchUrl,
  parseRobotsDisallow,
  isAllowedByRobots,
  parseHtml,
  ingestUrl,
  ingestUrls,
  ingestAndLearn,
} = require('./http-adapter');

/**
 * Starts an http server on 127.0.0.1 for the duration of `run(baseUrl)`,
 * then closes it. 127.0.0.1 is a private address, so every call site below
 * must pass `allowPrivateAddresses: true` -- the test-only bypass in
 * lib/ssrf-guard -- to exercise the real fetch path against it.
 */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ─── pure parsing: no server needed ─────────────────────────────────────────

test('http-adapter: parseHtml splits by h1-h3 headings', () => {
  const html = '<html><body><h1>Title</h1><p>Intro text</p><h2>Scope</h2><p>Scope text</p></body></html>';
  const entries = parseHtml(html, 'https://example.com/doc');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].entryKey, 'Title');
  assert.equal(entries[0].content, 'Intro text');
  assert.equal(entries[1].entryKey, 'Scope');
  assert.equal(entries[1].content, 'Scope text');
});

test('http-adapter: parseHtml falls back to one root entry with no headings', () => {
  const html = '<html><body><p>Just a paragraph, no headings.</p></body></html>';
  const entries = parseHtml(html, 'https://example.com/doc');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entryKey, 'root');
  assert.equal(entries[0].content, 'Just a paragraph, no headings.');
});

test('http-adapter: parseHtml strips script/style/comments and decodes entities', () => {
  const html = '<html><body><script>evil()</script><style>.x{}</style><!-- c --><h1>A &amp; B</h1><p>1 &lt; 2 &nbsp;end</p></body></html>';
  const entries = parseHtml(html, 'https://example.com/doc');
  assert.equal(entries[0].entryKey, 'A & B');
  assert.equal(entries[0].content, '1 < 2 end');
});

test('http-adapter: parseRobotsDisallow matches the "*" block by default', () => {
  const text = 'User-agent: *\nDisallow: /private\nDisallow: /admin\n';
  const disallow = parseRobotsDisallow(text, 'huqan-http-adapter/1.0');
  assert.deepEqual(disallow, ['/private', '/admin']);
});

test('http-adapter: parseRobotsDisallow prefers a matching specific user-agent block', () => {
  const text = [
    'User-agent: *',
    'Disallow: /everyone',
    '',
    'User-agent: huqan-http-adapter',
    'Disallow: /only-huqan',
  ].join('\n');
  const disallow = parseRobotsDisallow(text, 'huqan-http-adapter/1.0');
  assert.deepEqual(disallow, ['/only-huqan']);
});

test('http-adapter: parseRobotsDisallow returns empty when nothing matches', () => {
  assert.deepEqual(parseRobotsDisallow('', 'huqan-http-adapter'), []);
  assert.deepEqual(parseRobotsDisallow('User-agent: googlebot\nDisallow: /x\n', 'huqan-http-adapter'), []);
});

// ─── SSRF guard is actually wired in ────────────────────────────────────────

test('http-adapter: fetchUrl refuses a private address without the test bypass', async () => {
  await withServer((req, res) => { res.end('should never be reached'); }, async (baseUrl) => {
    await assert.rejects(
      () => fetchUrl(`${baseUrl}/`),
      (err) => err.code === 'SSRF_PRIVATE_ADDRESS_BLOCKED'
    );
  });
});

// ─── functional: real fetch against a local server ──────────────────────────

test('http-adapter: fetchUrl fetches a body over the real fetch path', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello from server');
  }, async (baseUrl) => {
    const res = await fetchUrl(`${baseUrl}/`, { allowPrivateAddresses: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.toString('utf8'), 'hello from server');
  });
});

test('http-adapter: fetchUrl follows redirects and re-validates each hop', async () => {
  await withServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/end' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('landed');
  }, async (baseUrl) => {
    const res = await fetchUrl(`${baseUrl}/start`, { allowPrivateAddresses: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.toString('utf8'), 'landed');
    assert.equal(res.redirects, 1);
    assert.ok(res.finalUrl.endsWith('/end'));
  });
});

test('http-adapter: fetchUrl gives up after maxRedirects', async () => {
  await withServer((req, res) => {
    res.writeHead(302, { Location: '/loop' });
    res.end();
  }, async (baseUrl) => {
    await assert.rejects(
      () => fetchUrl(`${baseUrl}/loop`, { allowPrivateAddresses: true, maxRedirects: 2 }),
      (err) => err.code === 'HTTP_TOO_MANY_REDIRECTS'
    );
  });
});

test('http-adapter: fetchUrl enforces maxBytes', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('x'.repeat(1000));
  }, async (baseUrl) => {
    await assert.rejects(
      () => fetchUrl(`${baseUrl}/`, { allowPrivateAddresses: true, maxBytes: 100 }),
      (err) => err.code === 'HTTP_RESPONSE_TOO_LARGE'
    );
  });
});

test('http-adapter: fetchUrl enforces timeoutMs despite a slow response stream', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const drip = setInterval(() => res.write('a'), 10);
    req.on('close', () => clearInterval(drip));
  }, async (baseUrl) => {
    await assert.rejects(
      () => fetchUrl(`${baseUrl}/`, { allowPrivateAddresses: true, timeoutMs: 60 }),
      (err) => err.code === 'HTTP_TIMEOUT',
    );
  });
});

test('http-adapter: isAllowedByRobots respects Disallow and caches per origin', async () => {
  let robotsRequests = 0;
  await withServer((req, res) => {
    if (req.url === '/robots.txt') {
      robotsRequests += 1;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  }, async (baseUrl) => {
    const robotsCache = new Map();
    const opts = { allowPrivateAddresses: true, robotsCache };

    assert.equal(await isAllowedByRobots(`${baseUrl}/private/page`, opts), false);
    assert.equal(await isAllowedByRobots(`${baseUrl}/public/page`, opts), true);
    assert.equal(await isAllowedByRobots(`${baseUrl}/private/other`, opts), false);
    assert.equal(robotsRequests, 1, 'robots.txt should be fetched once per origin, then cached');
  });
});

test('http-adapter: isAllowedByRobots fails open when robots.txt is unreachable', async () => {
  await withServer((req, res) => {
    res.writeHead(404);
    res.end();
  }, async (baseUrl) => {
    const allowed = await isAllowedByRobots(`${baseUrl}/anything`, {
      allowPrivateAddresses: true,
      robotsCache: new Map(),
    });
    assert.equal(allowed, true);
  });
});

test('http-adapter: ingestUrl rejects a robots-disallowed path before fetching it', async () => {
  let pageRequested = false;
  await withServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /blocked\n');
      return;
    }
    pageRequested = true;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('should not be reached');
  }, async (baseUrl) => {
    await assert.rejects(
      () => ingestUrl(`${baseUrl}/blocked/page`, { allowPrivateAddresses: true, robotsCache: new Map() }),
      (err) => err.code === 'HTTP_ROBOTS_DISALLOWED'
    );
    assert.equal(pageRequested, false);
  });
});

test('http-adapter: ingestUrl parses HTML into sections end to end', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Report</h1><p>Findings here.</p></body></html>');
  }, async (baseUrl) => {
    const result = await ingestUrl(`${baseUrl}/report`, { allowPrivateAddresses: true, robotsCache: new Map() });
    assert.equal(result.statusCode, 200);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].entryKey, 'Report');
    assert.equal(result.entries[0].content, 'Findings here.');
  });
});

test('http-adapter: ingestUrl rejects an unsupported content-type', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(Buffer.from([0x25, 0x50, 0x44, 0x46]));
  }, async (baseUrl) => {
    await assert.rejects(
      () => ingestUrl(`${baseUrl}/file.pdf`, { allowPrivateAddresses: true, robotsCache: new Map() }),
      (err) => err.code === 'HTTP_UNSUPPORTED_CONTENT_TYPE'
    );
  });
});

test('http-adapter: ingestUrl surfaces a 4xx/5xx as a failure, not a silent empty result', async () => {
  await withServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  }, async (baseUrl) => {
    await assert.rejects(
      () => ingestUrl(`${baseUrl}/broken`, { allowPrivateAddresses: true, robotsCache: new Map() }),
      (err) => err.code === 'HTTP_FETCH_FAILED' && err.statusCode === 500
    );
  });
});

test('http-adapter: ingestUrl caches the response and does not re-fetch within the TTL', async () => {
  let requests = 0;
  await withServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('cached body');
  }, async (baseUrl) => {
    const opts = { allowPrivateAddresses: true, robotsCache: new Map(), responseCache: new Map(), cacheTtlMs: 60000 };
    await ingestUrl(`${baseUrl}/page`, opts);
    await ingestUrl(`${baseUrl}/page`, opts);
    assert.equal(requests, 1, 'second call should hit the cache, not the network');
  });
});

test('http-adapter: ingestUrl refreshes the cache after the TTL expires (regression)', async () => {
  let requests = 0;
  await withServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('fresh body');
  }, async (baseUrl) => {
    // TTL of 0 means the entry is already expired on the very next call.
    // Previously the expired entry was never replaced, so every subsequent
    // call re-fetched forever AND never updated the cache.
    const opts = { allowPrivateAddresses: true, robotsCache: new Map(), responseCache: new Map(), cacheTtlMs: 0 };
    await ingestUrl(`${baseUrl}/page`, opts); // first call: fetch + cache set
    assert.equal(requests, 1, 'first call should fetch');
    await ingestUrl(`${baseUrl}/page`, opts); // expired → should fetch AND refresh cache
    assert.equal(requests, 2, 'expired cache should trigger a re-fetch');
    // Confirm the cache entry was refreshed: a subsequent call with a long TTL
    // should NOT re-fetch.
    const freshOpts = { ...opts, cacheTtlMs: 60000 };
    await ingestUrl(`${baseUrl}/page`, freshOpts);
    assert.equal(requests, 2, 'refreshed cache entry should be reused within the new TTL');
  });
});

test('http-adapter: ingestUrls collects per-URL errors without aborting the batch', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    if (req.url === '/good') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('fine');
      return;
    }
    res.writeHead(500);
    res.end();
  }, async (baseUrl) => {
    const opts = { allowPrivateAddresses: true, robotsCache: new Map(), responseCache: new Map() };
    const result = await ingestUrls([`${baseUrl}/good`, `${baseUrl}/bad`], opts);
    assert.equal(result.entries.length, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'HTTP_FETCH_FAILED');
  });
});

test('http-adapter: ingestAndLearn forwards provenance per entry', async () => {
  const calls = [];
  await withServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('A bounded claim');
  }, async (baseUrl) => {
    const result = await ingestAndLearn(`${baseUrl}/claim`, {
      // learnAsync, not learn -- ingestAndLearn goes through the async
      // pre-ingest path so preIngest gates can run on URL-sourced content.
      async learnAsync(text, opts) {
        calls.push({ text, opts });
        return { data: { learned: 1 }, receipt: { receiptId: 'delegated-receipt' } };
      },
    }, {
      allowPrivateAddresses: true,
      robotsCache: new Map(),
      responseCache: new Map(),
      actor: 'http-test',
    });

    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0].ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.sourceType, 'api');
    assert.equal(calls[0].opts.sourceSubType, 'http');
    assert.equal(calls[0].opts.provenance.source, 'http-adapter');
    assert.equal(calls[0].opts.provenance.actor, 'http-test');
    assert.match(calls[0].opts.provenance.provenanceId, /^http-\d+-[a-z0-9]{6}$/);
    assert.equal(calls[0].opts.provenance.sourceRef, calls[0].opts.sourceRef);
  });
});

test('http-adapter: fetchUrl issues a HEAD request when asked, with no body (#348)', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push(req.method);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>a body a HEAD must not receive</h1>');
  }, async (baseUrl) => {
    const res = await fetchUrl(`${baseUrl}/`, { method: 'HEAD', allowPrivateAddresses: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 0, 'HEAD response must carry no body');
  });
  assert.deepEqual(seen, ['HEAD']);
});

test('http-adapter: an unrecognised method falls back to GET rather than being passed through (#348)', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push(req.method);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  }, async (baseUrl) => {
    await fetchUrl(`${baseUrl}/`, { method: 'DELETE', allowPrivateAddresses: true });
  });
  assert.deepEqual(seen, ['GET'], 'the adapter must never be turned into a write client');
});

test('http-adapter: ingestAndLearn goes through learnAsync, so a preIngest rejection is reported per entry (#348)', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('A bounded claim');
  }, async (baseUrl) => {
    const result = await ingestAndLearn(`${baseUrl}/claim`, {
      async learnAsync() {
        throw Object.assign(new Error('source could not be reached'), { code: 'EVIDENCE_URL_UNREACHABLE' });
      },
      // Present but must never be reached: falling back to the sync path
      // would skip the gate silently, which is the #348 failure shape.
      learn() { throw new Error('ingestAndLearn must not fall back to synchronous learn()'); },
    }, {
      allowPrivateAddresses: true,
      robotsCache: new Map(),
      responseCache: new Map(),
    });

    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0].ok, false);
    assert.match(result.learned[0].error, /could not be reached/);
  });
});

test('http-adapter: ingestAndLearn end to end -- a real kernel runs preIngest on URL-sourced content (#348)', async () => {
  const Kernel = require('../kernel');
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  const seen = [];
  k.plugins.register({
    name: 'ingest-probe',
    requires: [],
    optional: [],
    preIngest: async (kernel, data) => { seen.push(data.opts.sourceRef); return data; },
  });

  await withServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Kedi hayvandır');
  }, async (baseUrl) => {
    const result = await ingestAndLearn(`${baseUrl}/claim`, k, {
      allowPrivateAddresses: true,
      robotsCache: new Map(),
      responseCache: new Map(),
    });

    assert.equal(result.learned[0].ok, true, JSON.stringify(result.learned[0]));
    // The point of the wiring: a real kernel's preIngest pass ran, and saw
    // the http sourceRef an evidence gate would need to validate.
    assert.equal(seen.length, 1);
    // The adapter appends the section anchor to the sourceRef.
    assert.equal(seen[0], `${baseUrl}/claim#root`);
  });
});
