'use strict';

const { evaluateLlmSor } = require('./shield');
const {
  EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS,
} = require('./external-client-package-gate');
const {
  enforceExternalClientAuthority,
  snapshotExternalClientAuthority,
} = require('./external-client-authority');
const { stableStringify } = require('./receipt/canonical-receipt');

const EXTERNAL_CLIENT_PACKAGE_SDK_ERRORS = Object.freeze({
  HANDLER_REQUIRED: 'EXTERNAL_CLIENT_PACKAGE_HANDLER_REQUIRED',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function failSdk(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = { ...details };
  throw error;
}

function deepFreezeJson(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

function snapshotExternalPackage(pkg) {
  try {
    const serialized = stableStringify(pkg);
    if (typeof serialized !== 'string') throw new TypeError('package is not serializable');
    return deepFreezeJson(JSON.parse(serialized));
  } catch (_) {
    failSdk(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.INVALID_PACKAGE,
      'external client package must be deterministic JSON',
      { stage: 'snapshot' },
    );
  }
}

const EXTERNAL_PACKAGE_AUTHORITY_OPTION_KEYS = Object.freeze([
  'expectedIdentitySubject',
  'expectedIdentityKind',
  'expectedWorkspaceId',
  'expectedPackageId',
  'permissions',
  'trustedKeys',
  'clock',
  'replayStore',
  'packageAdmissionHandler',
]);

function hasExternalPackageAuthorityConfiguration(kernel, options) {
  if (kernel && typeof kernel.admitExternalPackage === 'function') return true;
  if (!options || typeof options !== 'object') return false;
  return EXTERNAL_PACKAGE_AUTHORITY_OPTION_KEYS.some((key) => (
    Object.prototype.hasOwnProperty.call(options, key)
  ));
}

function snapshotPackageAdmissionAuthority(kernel, options = {}) {
  const handlerDescriptor = options && typeof options === 'object'
    ? Object.getOwnPropertyDescriptor(options, 'packageAdmissionHandler')
    : null;
  const explicitHandler = handlerDescriptor
    && Object.prototype.hasOwnProperty.call(handlerDescriptor, 'value')
    && typeof handlerDescriptor.value === 'function'
    ? handlerDescriptor.value
    : null;
  const kernelHandler = !explicitHandler && kernel && typeof kernel.admitExternalPackage === 'function'
    ? kernel.admitExternalPackage.bind(kernel)
    : null;

  if (!hasExternalPackageAuthorityConfiguration(kernel, options)) {
    return Object.freeze({ configured: false, handler: null, snapshot: null });
  }

  const authority = snapshotExternalClientAuthority(options);
  return Object.freeze({
    ...authority,
    configured: true,
    handler: explicitHandler || kernelHandler,
    snapshot: authority,
  });
}

async function admitExternalClientPackage(input = {}, authority = {}) {
  const packageSnapshot = snapshotExternalPackage(input.package);
  const authorityResult = await enforceExternalClientAuthority({
    identity: input.identity,
    workspaceId: input.workspaceId,
    package: packageSnapshot,
    signature: input.signature,
  }, authority.snapshot || authority);

  if (typeof authority.handler !== 'function') {
    failSdk(
      EXTERNAL_CLIENT_PACKAGE_SDK_ERRORS.HANDLER_REQUIRED,
      'external client package admission handler is required',
      {
        workspaceId: authorityResult.workspaceId,
        packageId: authorityResult.packageId,
      },
    );
  }

  const context = Object.freeze({
    identity: authorityResult.identity,
    workspaceId: authorityResult.workspaceId,
    packageId: authorityResult.packageId,
    packageHash: authorityResult.packageHash,
    signature: authorityResult.gate.signature,
    gateVersion: authorityResult.gate.gateVersion,
    gateReceipt: authorityResult.gate.receipt,
    authorityVersion: authorityResult.authorityVersion,
    permission: authorityResult.permission,
    replayKey: authorityResult.replayKey,
    authorityReceipt: authorityResult.authorityReceipt,
    authority: authorityResult,
  });
  const admission = await authority.handler(packageSnapshot, context);

  return Object.freeze({
    ok: true,
    gate: authorityResult.gate,
    authority: authorityResult,
    admission,
  });
}

function normalizeText(value) {
  if (typeof value === 'string') return value.trim();
  if (!isObject(value)) return '';
  for (const key of ['input', 'text', 'statement', 'question', 'prompt', 'idea', 'subject', 'answer']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return value[key].trim();
    }
  }
  return '';
}

function normalizeCommandName(command) {
  return String(command || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function resolveCommand(payload, options = {}) {
  if (typeof payload === 'string') {
    return {
      command: options.command || 'verify',
      input: payload.trim(),
    };
  }

  if (isObject(payload)) {
    const command = payload.command || payload.action || options.command || 'verify';
    const input = normalizeText(payload) || '';
    return { command, input, payload };
  }

  return {
    command: options.command || 'verify',
    input: '',
    payload,
  };
}

function pickStatement(payload, fallback = '') {
  if (typeof payload === 'string') return payload.trim();
  if (!isObject(payload)) return String(fallback || '').trim();
  return (
    (typeof payload.statement === 'string' && payload.statement.trim()) ||
    (typeof payload.text === 'string' && payload.text.trim()) ||
    (typeof payload.input === 'string' && payload.input.trim()) ||
    (typeof payload.question === 'string' && payload.question.trim()) ||
    String(fallback || '').trim()
  );
}

function pickSubject(payload, fallback = '') {
  if (typeof payload === 'string') return payload.trim();
  if (!isObject(payload)) return String(fallback || '').trim();
  return (
    (typeof payload.subject === 'string' && payload.subject.trim()) ||
    (typeof payload.input === 'string' && payload.input.trim()) ||
    (typeof payload.text === 'string' && payload.text.trim()) ||
    (typeof payload.statement === 'string' && payload.statement.trim()) ||
    String(fallback || '').trim()
  );
}

async function invokeCapability(kernel, capabilityName, input, opts = {}) {
  if (kernel && typeof kernel.runCapability === 'function') {
    return kernel.runCapability(capabilityName, input, opts);
  }
  if (kernel && kernel.plugins && typeof kernel.plugins.runCapability === 'function') {
    return kernel.plugins.runCapability(capabilityName, input, opts);
  }
  throw new Error(`Capability runner unavailable for: ${capabilityName}`);
}

function resolveCapabilityName(command) {
  const normalized = normalizeCommandName(command);
  switch (normalized) {
    case 'mri':
    case 'ideamri':
      return 'ideaMri';
    case 'devil':
    case 'deviladvocate':
      return 'devilAdvocate';
    case 'contradictions':
    case 'contradiction':
    case 'contradictionalert':
      return 'contradictionAlert';
    case 'shield':
      return 'shield';
    case 'verify':
    case 'reason':
      return normalized;
    default:
      return null;
  }
}

async function runAxiomSdkCommand(kernel, payload, options = {}) {
  const resolved = resolveCommand(payload, options);
  const normalizedCommand = normalizeCommandName(resolved.command);

  if (normalizedCommand === 'verify') {
    const statement = pickStatement(payload, resolved.input);
    if (!kernel || typeof kernel.verify !== 'function') {
      throw new Error('kernel.verify gerekli');
    }
    return kernel.verify(statement, options.verifyOptions || {});
  }

  if (normalizedCommand === 'reason') {
    const subject = pickSubject(payload, resolved.input);
    if (!kernel || typeof kernel.reason !== 'function') {
      throw new Error('kernel.reason gerekli');
    }
    return kernel.reason(subject, options.reasonOptions || {});
  }

  if (normalizedCommand === 'shield') {
    const question = isObject(payload)
      ? (payload.question || payload.prompt || payload.statement || resolved.input)
      : resolved.input;
    const answer = isObject(payload)
      ? (payload.answer || payload.text || payload.llmText || '')
      : '';
    return evaluateShieldLikeResponse(kernel, {
      question,
      answer,
      autoLearn: options.autoLearn === true,
      axiomCheck: options.axiomCheck,
      llmCheck: options.llmCheck,
      maxSentences: options.maxSentences,
    });
  }

  const capabilityName = resolveCapabilityName(resolved.command);
  if (!capabilityName) {
    throw new Error(`Unknown Axiom SDK command: ${resolved.command || normalizedCommand}`);
  }

  if (capabilityName === 'verify' || capabilityName === 'reason') {
    throw new Error(`Unknown Axiom SDK command: ${resolved.command || normalizedCommand}`);
  }

  const input = isObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'input')
    ? payload.input
    : resolved.input;
  return invokeCapability(kernel, capabilityName, input, options);
}

function evaluateShieldLikeResponse(kernel, payload = {}) {
  const question = typeof payload.question === 'string' ? payload.question : '';
  const answer = typeof payload.answer === 'string' ? payload.answer : '';
  return evaluateLlmSor({
    kernel,
    question,
    llmText: answer,
    axiomCheck: payload.axiomCheck,
    llmCheck: payload.llmCheck,
    autoLearn: payload.autoLearn === true,
    maxSentences: Number.isFinite(payload.maxSentences) ? payload.maxSentences : 15,
  });
}

function toLangChainTool(kernel, options = {}) {
  return {
    name: options.name || 'axiom',
    description: options.description || 'Use AXIOM to verify claims, find contradictions, and run reasoning capabilities.',
    async call(input) {
      return runAxiomSdkCommand(kernel, input, options);
    },
  };
}

function toVercelAiMiddleware(kernel, options = {}) {
  return async function axiomMiddleware(payload) {
    const question = typeof payload?.prompt === 'string'
      ? payload.prompt
      : typeof payload?.question === 'string'
        ? payload.question
        : typeof payload?.statement === 'string'
          ? payload.statement
          : '';
    const answer = typeof payload?.answer === 'string'
      ? payload.answer
      : typeof payload?.text === 'string'
        ? payload.text
        : typeof payload?.llmText === 'string'
          ? payload.llmText
          : '';

    return evaluateShieldLikeResponse(kernel, {
      question,
      answer,
      autoLearn: options.autoLearn === true,
      axiomCheck: payload?.axiomCheck,
      llmCheck: payload?.llmCheck,
      maxSentences: options.maxSentences,
    });
  };
}

function createAxiomClient(kernel, options = {}) {
  const packageAdmissionAuthority = snapshotPackageAdmissionAuthority(kernel, options);

  return {
    verify(input, verifyOptions = {}) {
      const statement = pickStatement(input);
      if (!kernel || typeof kernel.verify !== 'function') {
        throw new Error('kernel.verify gerekli');
      }
      return kernel.verify(statement, verifyOptions);
    },

    reason(input, reasonOptions = {}) {
      const subject = pickSubject(input);
      if (!kernel || typeof kernel.reason !== 'function') {
        throw new Error('kernel.reason gerekli');
      }
      return kernel.reason(subject, reasonOptions);
    },

    runCapability(name, input, opts = {}) {
      return invokeCapability(kernel, name, input, opts);
    },

    shield(payload) {
      return evaluateShieldLikeResponse(kernel, payload);
    },

    admitExternalPackage(input) {
      return admitExternalClientPackage(input, packageAdmissionAuthority);
    },

    toLangChainTool(toolOptions = {}) {
      return toLangChainTool(kernel, { ...options, ...toolOptions });
    },

    toVercelAiMiddleware(middlewareOptions = {}) {
      return toVercelAiMiddleware(kernel, { ...options, ...middlewareOptions });
    },
  };
}

module.exports = {
  EXTERNAL_CLIENT_PACKAGE_SDK_ERRORS,
  admitExternalClientPackage,
  createAxiomClient,
  evaluateShieldLikeResponse,
  invokeCapability,
  normalizeCommandName,
  normalizeText,
  resolveCapabilityName,
  runAxiomSdkCommand,
  snapshotPackageAdmissionAuthority,
  toLangChainTool,
  toVercelAiMiddleware,
};
