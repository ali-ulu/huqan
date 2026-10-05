'use strict';

// Builds benchmarks/fixtures/retrieval-github-corpus.json for the #3462
// retrieval experiment from huqan's own merge history, so the relevance
// judgements are not written by whoever runs the experiment:
//
//   record   - a merged PR: title + the start of its description
//   query    - the title of an issue that a PR in the window closed
//   relevant - the PRs GitHub links to that issue (closingIssuesReferences)
//
// The input is an offline export, one PR object per line:
//   gh api graphql --paginate -f query='query($endCursor:String){repository(
//     owner:"ali-ulu",name:"huqan"){pullRequests(states:MERGED,first:100,
//     after:$endCursor,orderBy:{field:CREATED_AT,direction:ASC}){pageInfo{
//     hasNextPage endCursor} nodes{number title body mergedAt
//     closingIssuesReferences(first:10){nodes{number title}}}}}}'
//     --jq '.data.repository.pullRequests.nodes[]' > prs.jsonl
//
// Run: node benchmarks/build-retrieval-github-corpus.js prs.jsonl
const fs = require('node:fs');
const path = require('node:path');
const { corpusHash } = require('./retrieval-experiment');

const OUTPUT_PATH = path.join(__dirname, 'fixtures', 'retrieval-github-corpus.json');
const WINDOW = 1000;
const BODY_CHARS = 200;

// Issue/PR numbers would let a query match its answer by number rather than
// by content; links, emails, code and process boilerplate are not content.
function cleanText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Only a closing keyword directly followed by a reference is boilerplate;
    // a title such as "Fixes flaky gate test" is content.
    .replace(/^[ \t]*(?:[-*][ \t]*)?(?:(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?):?[ \t]+(?:[\w.-]+\/[\w.-]+)?#\d+.*|co-authored-by:.*|\W*generated with\b.*)$/gim, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/#\d+/g, ' ')
    .replace(/[`*_>|#[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCorpus(prs, { window: size = WINDOW } = {}) {
  const window = [...prs].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number).slice(-size);
  const records = window.map((pr) => {
    const body = cleanText(pr.body).slice(0, BODY_CHARS).trim();
    return { memoryId: `pr-${pr.number}`, createdAt: pr.mergedAt, content: [cleanText(pr.title), body].filter(Boolean).join('. ') };
  });
  const issues = new Map();
  for (const pr of window) {
    for (const issue of pr.closingIssuesReferences.nodes) {
      const entry = issues.get(issue.number) || { text: cleanText(issue.title), relevant: [] };
      entry.relevant.push(`pr-${pr.number}`);
      issues.set(issue.number, entry);
    }
  }
  const queries = [...issues.entries()]
    .filter(([, entry]) => entry.text)
    .sort(([a], [b]) => a - b)
    .map(([number, entry]) => ({ id: `issue-${number}`, text: entry.text, relevant: entry.relevant.sort() }));
  const corpus = {
    description: `Last ${size} merged huqan PRs; queries are titles of issues those PRs close, relevance from GitHub closingIssuesReferences. Regenerate with benchmarks/build-retrieval-github-corpus.js.`,
    workspaceId: 'lab',
    records,
    queries,
  };
  return { ...corpus, frozen: { sha256: corpusHash(corpus) } };
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write('usage: node benchmarks/build-retrieval-github-corpus.js <prs.jsonl>\n');
    process.exitCode = 1;
  } else {
    const prs = fs.readFileSync(input, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    const corpus = buildCorpus(prs);
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(corpus)}\n`);
    process.stdout.write(`${corpus.records.length} records, ${corpus.queries.length} queries, sha256 ${corpus.frozen.sha256}\n`);
  }
}

module.exports = { buildCorpus, cleanText };
