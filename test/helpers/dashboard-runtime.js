'use strict';
// Run the dashboard the way a browser assembles it: read public/index.html,
// follow every same-origin <script src> in order, and execute them in one vm
// context. Returns a DOM snapshot so two assemblies (e.g. the former single
// bundle vs the split modules) can be compared for behavioural parity.
//
// The repository carries no browser dependency. The document below implements
// exactly the surface the dashboard touches; every snapshot value therefore
// comes from the real scripts, not from the stub.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

function fakeNode(id) {
  const node = {
    id, dataset: {}, style: { setProperty() {}, removeProperty() {} },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    children: [], innerHTML: '', textContent: '', hidden: false, value: '',
    onclick: null, onchange: null, onkeydown: null, oninput: null, onload: null,
    options: [], files: [], type: '',
    appendChild(c) { this.children.push(c); return c; }, append() {}, after() {}, before() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    // A stable sub-node per selector: the dashboard writes inspect output into a
    // per-row node it looks up by attribute, and a fresh node each call would
    // make that write unreadable to a test.
    _sub: new Map(),
    querySelectorAll() { return []; },
    querySelector(sel) {
      if (!this._sub.has(sel)) this._sub.set(sel, fakeNode(`${this.id}${sel}`));
      return this._sub.get(sel);
    },
    closest() { return null; }, click() {}, focus() {}, remove() {},
  };
  node.parentElement = { setAttribute() {}, style: {}, querySelectorAll() { return []; } };
  return node;
}

function scriptRefs(html) {
  return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((m) => m[1]).filter((s) => s.startsWith('/'));
}

/** Execute the given same-origin src refs (defaults to index.html's order). */
async function run({ scripts = null, files = null, ticks = 5, fetch: fetchImpl = null } = {}) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const refs = scripts || scriptRefs(html);
  const nodes = new Map();
  const getNode = (id) => { if (!nodes.has(id)) nodes.set(id, fakeNode(id)); return nodes.get(id); };
  const document = {
    getElementById: getNode,
    querySelectorAll() { return []; }, querySelector() { return fakeNode(''); },
    createElement() { return fakeNode('el'); }, createElementNS() { return fakeNode('svg'); },
    addEventListener() {}, removeEventListener() {},
    get body() { return fakeNode('body'); },
    get documentElement() { return fakeNode('html'); },
    readyState: 'complete',
  };
  const store = { getItem() { return null; }, setItem() {}, clear() {}, removeItem() {} };
  const navigator = { serviceWorker: null };
  const window = {
    addEventListener() {}, removeEventListener() {}, HUQAN_I18N: null,
    location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '' },
    sessionStorage: store, localStorage: store, document, navigator,
    setInterval: () => 0, setTimeout: () => 0, clearInterval() {}, clearTimeout() {},
    dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const ctx = {
    window, document, sessionStorage: store, localStorage: store, navigator,
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    CSS: { escape: (value) => String(value).replace(/["\\]/g, '\\$&') },
    // A pinned clock: the dashboard renders `new Date()` into the footer, and a
    // harness that leaks wall time cannot compare two assemblies.
    Date: class extends Date {
      constructor(...args) { if (args.length === 0) super(0); else super(...args); }
      static now() { return 0; }
    },
    Intl, Math, JSON, console, setInterval: () => 0, setTimeout: () => 0,
    clearInterval() {}, clearTimeout() {},
    URLSearchParams, Set, Map, Promise, URL, encodeURIComponent, decodeURIComponent,
    Number, String, Object, Array, Boolean, Error, RegExp, Symbol, isNaN, parseInt, parseFloat,
    CustomEvent: function CustomEvent(t, o) { return { type: t, detail: o && o.detail }; },
    Event: function Event(t) { return { type: t }; },
    MutationObserver: function MutationObserver() { this.observe = () => {}; this.disconnect = () => {}; },
    FileReader: function FileReader() { this.readAsText = () => {}; },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  const errors = [];
  for (const ref of refs) {
    const source = files && files[ref] ? files[ref] : fs.readFileSync(path.join(PUBLIC, ref.replace(/^\//, '')), 'utf8');
    try {
      vm.runInContext(source, ctx, { filename: ref });
    } catch (e) {
      errors.push(`${ref}: ${e.message}`);
    }
  }

  // Drain the asynchronous bootstrap (probeAuthMode().finally(refresh())) so the
  // snapshot covers the rendered panels, not just the synchronous first paint.
  for (let i = 0; i < ticks; i++) await Promise.resolve();

  const snapshot = {};
  for (const [id, node] of nodes) {
    snapshot[id] = {
      textContent: node.textContent,
      innerHTML: node.innerHTML,
      hidden: node.hidden,
      onclick: node.onclick ? typeof node.onclick : null,
      onchange: node.onchange ? typeof node.onchange : null,
      onkeydown: node.onkeydown ? typeof node.onkeydown : null,
    };
  }
  // `nodes` exposes the fake DOM for behavioural tests (read a node after a
  // click, call a handler directly); `evaluate` runs a snippet in the shared
  // dashboard scope so a test can drive the page the way a user would.
  const evaluate = (expression) => vm.runInContext(expression, ctx);
  return { errors, refs, snapshot, nodes, evaluate };
}

module.exports = { run, scriptRefs, fakeNode, PUBLIC };
