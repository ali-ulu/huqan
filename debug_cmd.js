const {tokenizeSegment, stripCommandWrappers, findDestructiveRm}=require('./lib/command-exec-gate-structure');
const seg='sh -c "rm -rf \\"/\\""';
console.log('seg:', seg);
const tokens = tokenizeSegment(seg);
console.log('tokens:', tokens);
const stripped = stripCommandWrappers(tokens);
console.log('stripped:', stripped);
console.log('destructive:', findDestructiveRm(seg));
