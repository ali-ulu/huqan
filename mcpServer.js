const fs = require('fs');
const readline = require('readline');
const Kernel = require('./kernel');
const pkg = require('./package.json');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'axiom';
const SERVER_VERSION = pkg.version;
const VERIFY_STATUS = ['dogrulandi', 'celiski', 'bilinmiyor'];

const ENVELOPE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    type: { type: 'string' },
    data: { type: ['object', 'null'] },
    evidence: { type: 'array' },
    error: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['code', 'message'],
          additionalProperties: false,
        },
      ],
    },
    meta: { type: 'object' },
  },
  required: ['ok', 'type', 'data', 'evidence', 'error', 'meta'],
  additionalProperties: true,
};

const VERIFY_ENVELOPE_OUTPUT_SCHEMA = {
  ...ENVELOPE_OUTPUT_SCHEMA,
  properties: {
    ...ENVELOPE_OUTPUT_SCHEMA.properties,
    data: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            status: { type: 'string', enum: VERIFY_STATUS },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['status'],
          additionalProperties: true,
        },
      ],
    },
  },
};

function buildKernelOptsFromEnv() {
  const kernelOpts = {};
  if (process.env.AXIOM_MEMORY_PATH) kernelOpts.memoryPath = process.env.AXIOM_MEMORY_PATH;
  if (process.env.AXIOM_DB_PATH) kernelOpts.dbPath = process.env.AXIOM_DB_PATH;
  if (process.env.AXIOM_USE_SQLITE === 'false') kernelOpts.useSQLite = false;
  if (process.env.AXIOM_PARANOID === '1') kernelOpts.paranoidMode = true;
  return kernelOpts;
}

const TOOL_SCHEMAS = [
  {
    name: 'axiom.learn',
    title: 'Axiom Learn',
    description: 'Learn a natural-language fact into the local symbolic knowledge graph. Returns a stable AXIOM envelope with learn counts and evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Natural-language statement to learn, for example: "kedi hayvandir".' },
        skipConflicts: { type: 'boolean', description: 'Skip conflicting statements when true. Defaults to true.' },
        maxSentences: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of sentences to ingest from the input text.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    outputSchema: ENVELOPE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'axiom.ask',
    title: 'Axiom Ask',
    description: 'Ask a grounded question against the local knowledge graph and return a stable AXIOM envelope.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to answer from local knowledge, for example: "kedi nedir".' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    outputSchema: ENVELOPE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.verify',
    title: 'Axiom Verify',
    description: 'Verify whether a statement is supported, contradictory, or unknown and return evidence references.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'Statement to verify, for example: "kedi hayvandir".' },
      },
      required: ['statement'],
      additionalProperties: false,
    },
    outputSchema: VERIFY_ENVELOPE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.reason',
    title: 'Axiom Reason',
    description: 'Return forward and backward reasoning traces for a subject with stable evidence references.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Subject to reason about, for example: "kedi".' },
      },
      required: ['subject'],
      additionalProperties: false,
    },
    outputSchema: ENVELOPE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.compare',
    title: 'Axiom Compare',
    description: 'Compare two concepts using the knowledge graph and return similarities, differences, and path evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'string', description: 'First concept, for example: "kedi".' },
        right: { type: 'string', description: 'Second concept, for example: "kopek".' },
      },
      required: ['left', 'right'],
      additionalProperties: false,
    },
    outputSchema: ENVELOPE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.dream',
    title: 'Axiom Dream',
    description: 'Generate hypotheses from the current graph and return ranked speculative links.',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Optional exploration depth. Defaults to 2.' },
      },
      additionalProperties: false,
    },
    outputSchema: ENVELOPE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function prettyEnvelope(result) {
  if (!result) return 'No result.';
  if (result.ok === false && result.error) {
    return `${result.error.code}: ${result.error.message}`;
  }
  return JSON.stringify(result, null, 2);
}

function toToolResult(result) {
  return {
    content: [{ type: 'text', text: prettyEnvelope(result) }],
    structuredContent: result,
    isError: Boolean(result && result.ok === false),
  };
}

function createServer() {
  const kernel = new Kernel({ ...buildKernelOptsFromEnv(), loadPlugins: false });
  return {
    kernel,
    handleRequest(message) {
      if (!message || typeof message !== 'object') {
        return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } };
      }

      const { id, method, params } = message;

      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      }

      if (method === 'notifications/initialized') {
        return null;
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: TOOL_SCHEMAS } };
      }

      if (method === 'tools/call') {
        try {
          const result = callTool(kernel, params);
          return { jsonrpc: '2.0', id, result: toToolResult(result) };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `INTERNAL: ${err.message}` }],
              isError: true,
            },
          };
        }
      }

      if (method === 'shutdown') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    },
  };
}

function callTool(kernel, params = {}) {
  const name = params.name;
  const args = params.arguments || {};

  switch (name) {
    case 'axiom.learn':
      return kernel.learn(args.text, {
        skipConflicts: args.skipConflicts !== false,
        maxSentences: args.maxSentences,
      });
    case 'axiom.ask':
      return kernel.ask(args.question);
    case 'axiom.verify':
      return kernel.verify(args.statement);
    case 'axiom.reason':
      return kernel.reason(args.subject);
    case 'axiom.compare':
      return kernel.compare(args.left, args.right);
    case 'axiom.dream':
      return kernel.dream({ depth: args.depth });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function runStdio() {
  const server = createServer();
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  function send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const response = server.handleRequest(message);
    if (response) send(response);

    if (message && message.method === 'shutdown') {
      rl.close();
      setTimeout(() => process.exit(0), 0).unref?.();
    }
  });

  process.stdin.on('end', () => rl.close());
}

if (require.main === module) {
  runStdio();
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_NAME,
  TOOL_SCHEMAS,
  VERIFY_STATUS,
  buildKernelOptsFromEnv,
  callTool,
  createServer,
  runStdio,
};
