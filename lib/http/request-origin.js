'use strict';

/**
 * The base a request's URL is resolved against.
 *
 * `req.url` on a server is a path, not an absolute URL, so building a `URL`
 * from it needs a base -- and the only base the request carries is its own
 * `Host` header, a value the client controls completely. Passing that value
 * straight to `new URL()` lets a malformed one (`Host: [bad`) throw
 * `ERR_INVALID_URL` out of the request handler, where the generic catch reports
 * it as an internal server fault (#1729).
 *
 * The status code is the smaller half of that bug. A 500 asserts the server
 * broke, which puts a client's mistake into the server's error budget and into
 * every alert that reads it; a malformed request line is the client's mistake
 * and must be answered as one, before any route runs.
 *
 * ## What this module decides, and what it does not
 *
 * It answers exactly one question: can this `Host` be used as an origin. It is
 * **not** a host allow-list and **not** an anti-spoofing control -- deciding
 * *which* hosts a deployment will serve is a deployment concern, and pretending
 * otherwise here would put a security claim behind a syntax check.
 */

// An absent Host is not malformed. HTTP/1.0 clients may omit it and Node's own
// parser already answers 400 for an HTTP/1.1 request that does, so the fallback
// only covers the requests that are legitimately allowed to arrive without one.
const FALLBACK_HOST = 'localhost';

/**
 * The characters RFC 3986 allows in a `reg-name`, an IP-literal, or a port --
 * and nothing else.
 *
 * The check is on the characters rather than on what `new URL()` makes of them,
 * because the parser accepts a good deal more than an origin and quietly
 * rewrites the rest: `http://a/b` parses with a path and yields origin
 * `http://a`, `http://user@evil.com` parses with credentials and yields
 * `http://evil.com`, and a tab inside the value is simply deleted. Each of
 * those relocates the origin to somewhere the client chose. Excluding `@`, `/`,
 * `?`, `#` and whitespace rules all of them out at the door.
 *
 * Comparing the parsed host back to the header instead would be wrong in the
 * ordinary case: `Host: example.com:80` is legal and normalizes to
 * `example.com`, so a round-trip test would reject a perfectly good request.
 *
 * Today only `pathname` and `searchParams` are read downstream, so a relocated
 * origin changes no routing decision here. The rule is in place so that stops
 * being true loudly rather than silently the first time something reads
 * `origin`.
 */
const HOST_CHARACTERS = /^[A-Za-z0-9\-._~%!$&'()*+,;=:[\]]+$/;

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {URL|null} the resolved request URL, or `null` when the `Host`
 *   header cannot serve as a base. `null` means "answer the client", never
 *   "the server failed".
 */
function resolveRequestUrl(req) {
  const rawHost = req?.headers?.host;
  const host = typeof rawHost === 'string' && rawHost !== '' ? rawHost : FALLBACK_HOST;

  if (!HOST_CHARACTERS.test(host)) return null;

  let base;
  try {
    base = new URL(`http://${host}`);
  } catch {
    return null;
  }

  // The path can be malformed on its own -- an absolute-form request target
  // (`GET http://… HTTP/1.1`, which proxies send) is parsed here too, and a
  // broken one throws for the same reason and deserves the same answer.
  try {
    return new URL(req.url, base);
  } catch {
    return null;
  }
}

module.exports = { resolveRequestUrl, FALLBACK_HOST };
