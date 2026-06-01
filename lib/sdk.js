const { evaluateLlmSor } = require('./shield');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

    toLangChainTool(toolOptions = {}) {
      return toLangChainTool(kernel, { ...options, ...toolOptions });
    },

    toVercelAiMiddleware(middlewareOptions = {}) {
      return toVercelAiMiddleware(kernel, { ...options, ...middlewareOptions });
    },
  };
}

module.exports = {
  createAxiomClient,
  evaluateShieldLikeResponse,
  invokeCapability,
  normalizeCommandName,
  normalizeText,
  resolveCapabilityName,
  runAxiomSdkCommand,
  toLangChainTool,
  toVercelAiMiddleware,
};
