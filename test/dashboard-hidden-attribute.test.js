'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readHtml, dashboardStyles } = require('./helpers/dashboard-source');

// The dashboard hides elements by setting el.hidden. The HTML `hidden`
// attribute only carries `display:none` from the user-agent stylesheet, which
// any authored `display` rule outranks. `.field{display:grid}` did exactly
// that, so `$('keyfield').hidden = true` set the property and changed nothing
// on screen. A page that uses el.hidden must state the rule itself.
// #1894 moved the dashboard's CSS out of the page into public/css/app.css. The
// rule is a property of what the browser loads, not of where the bytes are
// stored, so the styles come from the shared helper, which follows the link.

test('the dashboard declares a [hidden] rule that outranks authored display rules', () => {
  const css = dashboardStyles();
  assert.ok(css.trim(), 'the dashboard must carry a stylesheet somewhere');
  const rule = css.match(/\[hidden\][^{]*\{([^}]*)\}/);

  assert.ok(rule, 'no [hidden] rule found; el.hidden would be inert wherever a display rule applies');
  const body = rule[1].replace(/\s+/g, '').toLowerCase();
  assert.ok(body.includes('display:none'), `[hidden] rule must set display:none, found: ${rule[1].trim()}`);
  assert.ok(body.includes('!important'), '[hidden] must win against authored display rules such as .field{display:grid}');
});

test('elements the dashboard hides are hidden via the hidden property', () => {
  const html = readHtml();
  assert.ok(
    html.includes("$('keyfield').hidden=open"),
    'the key field is expected to be hidden through el.hidden; update this contract if that changes',
  );
});
