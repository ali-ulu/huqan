'use strict';

/**
 * Robots policy is enforced on every hop a redirect chain takes (#762).
 *
 * ingestUrl checked isAllowedByRobots for the URL the caller handed it and
 * then let fetchUrl follow up to five redirects. Each hop was re-validated for
 * SSRF but never for robots, so an allowed URL could redirect to a path -- or
 * to a whole other origin -- whose robots.txt forbids ingestion, and HUQAN
 * would ingest it with respectRobots enabled. Source admission then depended
 * on redirect indirection rather than on the policy of the source actually
 * read.
 *
 * 127.0.0.1 is a private address, so every call passes allowPrivateAddresses
 * -- the test-only bypass in lib/ssrf-guard -- to exercise the real fetch path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { ingestUrl, fetchUrl } = require('../adapters/http-adapter');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function freshOptions(extra = {}) {
  return {
    allowPrivateAddresses: true,
    robotsCache: new Map(),
    responseCache: new Map(),
    ...extra,
  };
}

function robotsTxt(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(body);
}

test('a redirect to a disallowed path on the same origin is refused', async () => {
  const fetched = [];
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return robotsTxt(res, 'User-agent: *\nDisallow: /private\n');
    fetched.push(req.url);
    if (req.url === '/open') {
      res.writeHead(302, { Location: '/private/secret' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('secret content');
  }, async (baseUrl) => {
    await assert.rejects(
      () => ingestUrl(`${baseUrl}/open`, freshOptions()),
      (err) => err.code === 'HTTP_ROBOTS_DISALLOWED' && err.url.endsWith('/private/secret')
    );
    assert.deepEqual(fetched, ['/open'], 'the disallowed target was fetched anyway');
  });
});

test('a redirect to a second origin is checked against that origin\'s robots', async () => {
  const secondOriginPaths = [];
  // The destination origin comes up first, so the redirecting origin can name
  // it in a Location header.
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return robotsTxt(res, 'User-agent: *\nDisallow: /blocked\n');
    secondOriginPaths.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('other-origin content');
  }, (secondBase) => withServer((req, res) => {
    // This origin's own robots.txt allows everything -- the point being that
    // its permission says nothing about where it sends the client.
    if (req.url === '/robots.txt') return robotsTxt(res, 'User-agent: *\n');
    res.writeHead(302, { Location: `${secondBase}/blocked/doc` });
    res.end();
  }, async (firstBase) => {
    await assert.rejects(
      () => ingestUrl(`${firstBase}/start`, freshOptions()),
      (err) => err.code === 'HTTP_ROBOTS_DISALLOWED' && err.url === `${secondBase}/blocked/doc`
    );
    assert.deepEqual(secondOriginPaths, [], 'the second origin served content it forbids');
  }));
});

test('an allowed redirect chain still works', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return robotsTxt(res, 'User-agent: *\nDisallow: /private\n');
    if (req.url === '/one') { res.writeHead(302, { Location: '/two' }); res.end(); return; }
    if (req.url === '/two') { res.writeHead(302, { Location: '/three' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('arrived');
  }, async (baseUrl) => {
    const result = await ingestUrl(`${baseUrl}/one`, freshOptions());
    assert.equal(result.statusCode, 200);
    assert.ok(result.finalUrl.endsWith('/three'));
    assert.equal(result.entries[0].content, 'arrived');
  });
});

test('respectRobots:false still follows a redirect into a disallowed path', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return robotsTxt(res, 'User-agent: *\nDisallow: /private\n');
    if (req.url === '/open') { res.writeHead(302, { Location: '/private/secret' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('secret content');
  }, async (baseUrl) => {
    const result = await ingestUrl(`${baseUrl}/open`, freshOptions({ respectRobots: false }));
    assert.equal(result.entries[0].content, 'secret content');
  });
});

test('the SSRF guard still runs on every hop, robots or not', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') return robotsTxt(res, 'User-agent: *\n');
    res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  }, async (baseUrl) => {
    // The link-local metadata address must be refused by the SSRF guard, not
    // reached and then judged by its robots.txt.
    await assert.rejects(
      () => ingestUrl(`${baseUrl}/start`, freshOptions()),
      (err) => err.code !== 'HTTP_ROBOTS_DISALLOWED'
    );
  });
});

test('fetching robots.txt does not recurse through the redirect hook', async () => {
  // robots.txt is itself fetched over fetchUrl. If the hook were carried into
  // that fetch, answering "is this hop allowed?" would require answering it
  // again for the robots fetch, without end.
  let robotsHits = 0;
  await withServer((req, res) => {
    if (req.url === '/robots.txt') {
      robotsHits += 1;
      res.writeHead(302, { Location: '/robots-real.txt' });
      res.end();
      return;
    }
    if (req.url === '/robots-real.txt') return robotsTxt(res, 'User-agent: *\nDisallow: /private\n');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('page');
  }, async (baseUrl) => {
    const result = await ingestUrl(`${baseUrl}/open`, freshOptions());
    assert.equal(result.entries[0].content, 'page');
    assert.equal(robotsHits, 1, 'robots.txt was refetched, so the hook recursed');
  });
});

test('fetchUrl refuses a hop when its onRedirect hook throws, before fetching it', async () => {
  const fetched = [];
  await withServer((req, res) => {
    fetched.push(req.url);
    if (req.url === '/start') { res.writeHead(302, { Location: '/next' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('next page');
  }, async (baseUrl) => {
    await assert.rejects(
      () => fetchUrl(`${baseUrl}/start`, {
        allowPrivateAddresses: true,
        onRedirect: (url) => { throw Object.assign(new Error(`refused ${url}`), { code: 'TEST_REFUSED' }); },
      }),
      (err) => err.code === 'TEST_REFUSED'
    );
    assert.deepEqual(fetched, ['/start']);
  });
});
