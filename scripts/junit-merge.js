'use strict';

// JUnit part merging for the sharded test runner (#2212).
//
// Single responsibility: assemble per-file JUnit XML parts into one merged
// report. Pure XML handling plus best-effort filesystem IO; no process
// orchestration, no shard selection, no exit codes. Those stay in
// scripts/run-test-shard.js, which re-exports mergeJunitParts so existing
// importers keep working. This module is never a second authority for
// orchestration decisions.

const fs = require('node:fs');

function escapeXmlAttr(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

/**
 * End of the tag that starts at `start`, ignoring any '>' inside an attribute
 * value. Test names carry them: "learn -> review -> approve" is one.
 * Returns -1 if the tag never closes.
 */
function endOfTag(xml, start) {
  let cursor = start;
  let quote = '';
  while (cursor < xml.length) {
    const character = xml[cursor];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

/**
 * Every top-level `<name>` element in `xml`, whole, nesting included.
 *
 * Both callers used to be lazy regexes, and both were wrong in the same way —
 * a lazy match stops at the first candidate end, which is not this element's:
 *
 *   /<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/  — a nested describe emits a
 *     nested <testsuite>, so the match ended at the *inner* close and left the
 *     outer </testsuite> orphaned.
 *   /<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/  — the alternation accepts '/>',
 *     so a case with a self-closing child (skipped cases are written exactly
 *     that way) ended at the *child's* '/>' and lost its own </testcase>.
 *
 * Either one leaves the merged report with more open elements than closes, and
 * a single unclosed element makes the whole document unparseable rather than
 * merely inaccurate — 35 open <testcase> against 6 closes in the shard 5
 * nightly artifact, plus two unclosed <testsuite> from nested describes
 * (#2038). <failure> hid the testcase half because it is not self-closing.
 *
 * Counting depth is what both cases actually need.
 */
function extractElements(xml, name) {
  const blocks = [];
  const open = new RegExp(`<${name}\\b`, 'g');
  let match;
  while ((match = open.exec(xml)) !== null) {
    const start = match.index;
    let cursor = start;
    let depth = 0;

    while (cursor < xml.length && cursor !== -1) {
      const tagEnd = endOfTag(xml, cursor);
      if (tagEnd === -1) { cursor = -1; break; }
      const tag = xml.slice(cursor + 1, tagEnd);

      if (tag.startsWith(`/${name}`)) {
        depth -= 1;
        if (depth === 0) break;
      } else if (new RegExp(`^${name}\\b`).test(tag)) {
        // A self-closing element is complete on its own.
        if (tag.endsWith('/')) {
          if (depth === 0) { cursor = tagEnd; break; }
        } else {
          depth += 1;
        }
      }

      const next = xml.indexOf('<', tagEnd + 1);
      if (next === -1) { cursor = -1; break; }
      cursor = next;
    }

    if (cursor === -1 || cursor >= xml.length) {
      // Truncated part file: keep what is there rather than drop it, but close
      // it, so one damaged part cannot make the whole report unreadable.
      const firstTagEnd = endOfTag(xml, start);
      const head = firstTagEnd === -1 ? `<${name}>` : xml.slice(start, firstTagEnd + 1);
      blocks.push(head.endsWith('/>') ? head : `${head}</${name}>`);
      break;
    }

    const end = endOfTag(xml, cursor);
    const stop = end === -1 ? xml.length : end + 1;
    blocks.push(xml.slice(start, stop));
    open.lastIndex = stop;
  }
  return blocks;
}

function mergeJunitParts(partPaths, files, reportPath) {
  // Best-effort: a missing/corrupt part must not hide the exit code.
  // NOTE (#1973): Node's JUnit reporter only emits <testsuite> for tests
  // nested in describe/suite. A suite-less file emits its <testcase>
  // elements directly under <testsuites>, so collecting only <testsuite>
  // blocks silently drops every result in that file. Wrap orphan
  // <testcase> elements in a synthetic suite named after the file, and
  // derive totals from testcases (not suite attributes).
  try {
    let totalTime = 0;
    const suites = [];
    for (let partIndex = 0; partIndex < partPaths.length; partIndex += 1) {
      const partPath = partPaths[partIndex];
      if (!fs.existsSync(partPath)) continue;
      const xml = fs.readFileSync(partPath, 'utf8');
      const suiteBlocks = extractElements(xml, 'testsuite');
      for (const block of suiteBlocks) suites.push(block);
      // Sum time from the top-level <testsuite> elements only. A nested
      // describe's time is already included in its parent's, so summing every
      // open tag counted it twice (#2038).
      for (const block of suiteBlocks) {
        const tagEnd = endOfTag(block, 0);
        const t = (tagEnd === -1 ? block : block.slice(0, tagEnd + 1)).match(/time="([^"]+)"/);
        if (t) totalTime += Number(t[1]) || 0;
      }
      // Suite-less files: orphan <testcase> elements outside any <testsuite>.
      let withoutSuites = xml;
      for (const block of suiteBlocks) withoutSuites = withoutSuites.replace(block, '');
      const orphanCases = extractElements(withoutSuites, 'testcase');
      if (orphanCases.length > 0) {
        const file = (files && files[partIndex]) || partPath;
        const orphanBody = orphanCases.join('\n');
        const orphanFailures = (orphanBody.match(/<failure\b/g) || []).length;
        const orphanErrors = (orphanBody.match(/<error\b/g) || []).length;
        const orphanSkipped = (orphanBody.match(/<skipped\b/g) || []).length;
        suites.push(`<testsuite name="${escapeXmlAttr(file)}" tests="${orphanCases.length}" failures="${orphanFailures}" errors="${orphanErrors}" skipped="${orphanSkipped}" time="0">\n${orphanBody}\n</testsuite>`);
      }
      try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
    }
    if (suites.length === 0) {
      // No part produced a suite (e.g. early signal) — preserve prior
      // behaviour: emit an empty but valid report.
      if (!fs.existsSync(reportPath)) {
        fs.writeFileSync(reportPath, '<?xml version="1.0" encoding="utf-8"?>\n<testsuites tests="0" failures="0" skipped="0" time="0" />\n');
      }
      return { suites: [], totalTests: 0, totalFailures: 0, totalErrors: 0, totalSkipped: 0, totalTime };
    }
    const mergedBody = suites.join('\n');
    const totalTests = (mergedBody.match(/<testcase\b/g) || []).length;
    const totalFailures = (mergedBody.match(/<failure\b/g) || []).length;
    const totalErrors = (mergedBody.match(/<error\b/g) || []).length;
    const totalSkipped = (mergedBody.match(/<skipped\b/g) || []).length;
    const merged = `<?xml version="1.0" encoding="utf-8"?>\n<testsuites tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}" skipped="${totalSkipped}" time="${totalTime.toFixed(3)}">\n${mergedBody}\n</testsuites>\n`;
    fs.writeFileSync(reportPath, merged);
    return { suites, totalTests, totalFailures, totalErrors, totalSkipped, totalTime };
  } catch (error) {
    console.error(`warning: failed to merge JUnit parts into ${reportPath}: ${error.message}`);
    return null;
  }
}

module.exports = { escapeXmlAttr, endOfTag, extractElements, mergeJunitParts };
