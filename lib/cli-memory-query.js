'use strict';

// The CLI `memory-query` command: search memory records by text. It drives the
// `huqan.memory_query` MCP tool through the CLI's existing callMcpTool
// collaborator, like `sor` drives huqan.ask, so the command passes the same
// gate and returns the same projection (lib/memory-query-read.js) as MCP and
// GET /api/memory/query. Calling the projection directly is not an option
// here: this file is Core, the projection sits in an outer ring, and cli.js --
// the one place allowed to supply it -- is at its fan-out ceiling.

const CONTENT_PREVIEW_CHARS = 160;

// An empty page over a genuinely empty record store is the one result that
// reads as a broken command, so it carries the explanation: `learn`/`save`
// write the graph, not this store. Only the text surface prints it -- the
// `--json` projection stays pure data.
//
// `total` counts records that survived filtering, so it is 0 both for an empty
// store and for a populated one whose text matched nothing. Claiming the store
// is empty in the second case would be false, so the hint waits for the store's
// own unfiltered answer. That answer now rides on the query itself: the command
// asks the tool for `storeTotal` (#3640), and the projection returns it with
// the derived `storeEmpty`, so the CLI no longer makes a second read that could
// fail on its own. A page the recall gate emptied out is the same case: the
// store holds records, so the hint stays silent and the withheld line speaks.
//
// `sor <soru>` is the CLI command that reads the graph (kernel.ask);
// `huqan.search` is the MCP tool name for the same surface, not a CLI command.
const EMPTY_STORE_HINT = '  (no records in this store for this workspace; `learn`/`save` write the graph, not this store -- ask it with `sor <soru>` (`huqan.search` over MCP). See docs/memory-core-v0.9.1.md)';

function preview(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > CONTENT_PREVIEW_CHARS ? `${flat.slice(0, CONTENT_PREVIEW_CHARS - 1)}…` : flat;
}

function formatMemoryQueryText(result, { storeEmpty = false } = {}) {
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
  if (result.total === 0 && storeEmpty) lines.push(EMPTY_STORE_HINT);
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
    // Always on: the text surface needs the store's own emptiness to decide the
    // hint, and the projection carries it on the same read (#3640).
    storeTotal: true,
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
  if (parsed.json) return JSON.stringify(result, null, 2);
  // `storeEmpty` comes from the projection, which read it in the same query.
  // A refusal, or a store that could not be counted, leaves it undefined and
  // the hint stays silent -- the answer itself is never at risk.
  return formatMemoryQueryText(result, { storeEmpty: result.ok === true && result.storeEmpty === true });
}

module.exports = { formatMemoryQueryText, runMemoryQueryCommand };
