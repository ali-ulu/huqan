const vm = require('node:vm');

const { FORBIDDEN_PATTERNS, cloneValue } = require('./sandboxRunner-limits');

function validateSandboxSource(source) {
  const text = String(source || '');
  const violations = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) violations.push(pattern.source);
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * Bootstrap evaluated inside the sandbox realm (#750).
 *
 * Everything the sandbox can reach has to be constructed *by this script*, in
 * the sandbox's own realm. A host-realm object handed in directly carries its
 * realm with it: `console.log.constructor` was the host Function constructor,
 * which `codeGeneration: { strings: false }` does not restrict, so
 * `console.log['con'+'structor']('return pro'+'cess')()` returned the host
 * process object — past the textual denylist, which only rejects the
 * contiguous word. `input` and `context` were the same primitive by way of
 * `x.constructor.constructor`.
 *
 * The bindings arrive as JSON strings; JSON.parse here produces objects whose
 * prototypes belong to this realm, so the same expression now reaches the
 * context's own Function and is blocked by codeGeneration.
 */
const SANDBOX_BOOTSTRAP = `
  globalThis.console = Object.freeze({ log() {}, error() {}, warn() {} });
  globalThis.input = globalThis.__inputJson === undefined
    ? undefined
    : JSON.parse(globalThis.__inputJson);
  globalThis.context = JSON.parse(globalThis.__contextJson);
  delete globalThis.__inputJson;
  delete globalThis.__contextJson;
`;

function jsonBinding(value) {
  const cloned = cloneValue(value);
  if (cloned === undefined) return undefined;
  return JSON.stringify(cloned);
}

function createSandboxContext(bindings = {}) {
  const sandbox = Object.create(null);
  // Strings, not objects: a primitive carries no host prototype into the
  // sandbox, so these are safe to set before the bootstrap consumes them.
  sandbox.__inputJson = jsonBinding(bindings.input);
  sandbox.__contextJson = JSON.stringify(cloneValue(bindings.context || {}));
  // Keep external-memory constructors out of the untrusted realm. Ordinary
  // arrays/objects/strings are constrained by the child V8 heap limit.
  sandbox.ArrayBuffer = undefined;
  sandbox.SharedArrayBuffer = undefined;
  sandbox.Int8Array = undefined;
  sandbox.Uint8Array = undefined;
  sandbox.Uint8ClampedArray = undefined;
  sandbox.Int16Array = undefined;
  sandbox.Uint16Array = undefined;
  sandbox.Int32Array = undefined;
  sandbox.Uint32Array = undefined;
  sandbox.Float32Array = undefined;
  sandbox.Float64Array = undefined;
  sandbox.BigInt64Array = undefined;
  sandbox.BigUint64Array = undefined;
  sandbox.DataView = undefined;
  sandbox.WebAssembly = undefined;
  const context = vm.createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  });
  // Compiled by us, not by the sandbox, so codeGeneration does not apply.
  new vm.Script(SANDBOX_BOOTSTRAP, { filename: 'sandbox.bootstrap.js' }).runInContext(context);
  return context;
}

module.exports = {
  SANDBOX_BOOTSTRAP,
  validateSandboxSource,
  jsonBinding,
  createSandboxContext,
};
