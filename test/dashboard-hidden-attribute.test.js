'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD = path.join(__dirname, '..', 'public', 'index.html');

// The dashboard hides elements by setting el.hidden. The HTML `hidden`
// attribute only carries `display:none` from the user-agent stylesheet, which
// any authored `display` rule outranks. `.field{display:grid}` did exactly
// that, so `$('keyfield').hidden = true` set the property and changed nothing
// on screen. A page that uses el.hidden must state the rule itself.
// #1894 moved the dashboard's CSS out of the page into public/css/app.css. The
// rule is a property of what the browser loads, not of where the bytes are
// stored, so this reads the linked stylesheets too -- otherwise extracting CSS
// turns the contract red while the page is still correct, which is what
// happened.
function stylesheet(html) {
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const linked = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((href) => href.startsWith('/'))
    .map((href) => fs.readFileSync(path.join(__dirname, '..', 'public', href.slice(1)), 'utf8'));

  assert.ok(inline.length + linked.length > 0, 'the dashboard must carry a stylesheet somewhere');
  return [...inline, ...linked].join('\n');
}

test('the dashboard declares a [hidden] rule that outranks authored display rules', () => {
  const css = stylesheet(fs.readFileSync(DASHBOARD, 'utf8'));
  const rule = css.match(/\[hidden\][^{]*\{([^}]*)\}/);

  assert.ok(rule, 'no [hidden] rule found; el.hidden would be inert wherever a display rule applies');
  const body = rule[1].replace(/\s+/g, '').toLowerCase();
  assert.ok(body.includes('display:none'), `[hidden] rule must set display:none, found: ${rule[1].trim()}`);
  assert.ok(body.includes('!important'), '[hidden] must win against authored display rules such as .field{display:grid}');
});

test('elements the dashboard hides are hidden via the hidden property', () => {
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  assert.ok(
    html.includes("$('keyfield').hidden=open"),
    'the key field is expected to be hidden through el.hidden; update this contract if that changes',
  );
});
