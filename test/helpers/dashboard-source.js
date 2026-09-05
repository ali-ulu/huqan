'use strict';

/**
 * Reads the dashboard the way a browser assembles it, not the way it is stored.
 *
 * `public/index.html` was one self-contained file until #1894 moved its CSS to
 * `public/css/app.css`. Contract tests that matched CSS against the HTML string
 * went red even though the page was unchanged for a browser, and each one got
 * patched separately to follow the `<link>`. This helper exists so the next
 * extraction is one edit here instead of a sweep across every contract test --
 * and so nobody re-derives the "which file are the bytes in" question again.
 *
 * Whether those linked assets are actually *served* is a different question,
 * and reading them off disk cannot answer it; that is what
 * test/dashboard-static-assets.test.js is for.
 */

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');
const DASHBOARD_HTML = path.join(PUBLIC_ROOT, 'index.html');

function readHtml() {
  return fs.readFileSync(DASHBOARD_HTML, 'utf8');
}

function readLocalAsset(reference) {
  return fs.readFileSync(path.join(PUBLIC_ROOT, reference.replace(/^\//, '')), 'utf8');
}

/** Every CSS rule the page applies: inline `<style>` blocks plus linked same-origin stylesheets. */
function dashboardStyles(html = readHtml()) {
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]);
  const linked = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
    .map(match => match[1])
    .filter(href => href.startsWith('/'))
    .map(readLocalAsset);
  return [...inline, ...linked].join('\n');
}

/** Every script the page runs: inline `<script>` bodies plus linked same-origin scripts. */
function dashboardScript(html = readHtml()) {
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const linked = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(match => match[1])
    .filter(src => src.startsWith('/'))
    .map(readLocalAsset);
  return [...inline, ...linked].join('\n');
}

/** HTML plus everything it links, for assertions that do not care which is which. */
function dashboardSource(html = readHtml()) {
  return [html, dashboardStyles(html), dashboardScript(html)].join('\n');
}

module.exports = { DASHBOARD_HTML, readHtml, dashboardStyles, dashboardScript, dashboardSource };
