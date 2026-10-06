'use strict';

// The CLI `memory-query` command: search memory records by text. It drives the
// `huqan.memory_query` MCP tool through the CLI's existing callMcpTool
// collaborator, like `sor` drives huqan.ask, so the command passes the same
// gate and returns the same projection (lib/memory-query-read.js) as MCP and
// GET /api/memory/query. Calling the projection directly is not an option
// here: this file is Core, the projection sits in an outer ring, and cli.js --
// the one place allowed to supply it -- is at its fan-out ceiling.

const CONTENT_PREVIEW_CHARS = 160;

function preview(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > CONTENT_PREVIEW_CHARS ? `${flat.slice(0, CONTENT_PREVIEW_CHARS - 1)}…` : flat;
}

function formatMemoryQueryText(result) {
  if (!result || result.ok !== true) {
    return `memory-query: ${(result && result.code) || 'unavailable'}${result && result.message ? ` (${result.message})` : ''}`;
  }
  const shown = result.items.length;
  const lines = [`memory-query [${result.workspaceId}] ${result.retrievalMode}: ${shown} of ${result.total} for "${result.text}"`];
  result.items.forEach((item, index) => {
    const score = item.score === undefined ? '' : ` score ${item.score}`;
    const recency = item.recency === undefined ? '' : ` recency ${item.recency === null ? 'unknown' : item.recency}`;
    const recall = item.recall.decision === 'admit' ? '' : ` [${item.recall.decision}: ${item.recall.reason}]`;
    lines.push(`  ${result.offset + index + 1}. ${item.memoryId}${score}${recency}${recall}  ${preview(item.content)}`);
    for (const term of item.terms || []) {
      lines.push(`       ${term.term}: tf ${term.tf} idf ${term.idf} +${term.contribution}`);
    }
  });
  if (result.recall && result.recall.withheld > 0) {
    lines.push(`  (${result.recall.withheld} record(s) withheld by the recall gate)`);
  }
  return lines.join('\n');
}

// argv values are strings; the tool's input schema wants integers and a
// boolean. A value that is not a whole number is passed on unchanged so the
// projection refuses it with its own message.
function toolArguments(parsed) {
  const integer = (value) => (/^\d+$/.test(value) ? Number(value) : value);
  return {
    text: parsed.text,
    workspaceId: parsed.workspaceId,
    ...(parsed.retrievalMode ? { retrievalMode: parsed.retrievalMode } : {}),
    ...(parsed.halfLifeDays ? { halfLifeDays: Number(parsed.halfLifeDays) } : {}),
    ...(parsed.asOf ? { asOf: parsed.asOf } : {}),
    ...(parsed.limit ? { limit: integer(parsed.limit) } : {}),
    ...(parsed.offset ? { offset: integer(parsed.offset) } : {}),
    ...(parsed.explain ? { explain: true } : {}),
  };
}

// The tool reports a refusal as `MEMORY_QUERY_FAILED` with "<code>: <message>";
// unfold it back into the projection's own failure shape.
function fromToolResult(result) {
  if (result && result.ok === true && result.data) return result.data;
  const message = String(result?.error?.message || 'unavailable');
  const match = message.match(/^([a-z_]+): (.*)$/s);
  return match ? { ok: false, code: match[1], message: match[2] } : { ok: false, code: result?.error?.code || 'unavailable', message };
}

function runMemoryQueryCommand(cli, args, callMcpTool) {
  const parsed = args || {};
  if (parsed.error) return `memory-query: ${parsed.error}`;
  const result = fromToolResult(callMcpTool(cli.kernel, { name: 'huqan.memory_query', arguments: toolArguments(parsed) }));
  return parsed.json ? JSON.stringify(result, null, 2) : formatMemoryQueryText(result);
}

module.exports = { formatMemoryQueryText, runMemoryQueryCommand };
