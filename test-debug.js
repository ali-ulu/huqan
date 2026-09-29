const {readGraphSurfaceSource} = require('./test/helpers/graph-surface-source');
const s = readGraphSurfaceSource();
function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  const bodyStart = source.indexOf(') {', start) + 2;
  const end = source.indexOf('\n  }', bodyStart);
  return source.slice(bodyStart + 1, end).trim();
}
console.log('getNodes:', methodBody(s, 'getNodes'));
console.log('getNode:', methodBody(s, 'getNode'));
console.log('query:', methodBody(s, 'query'));