const {evaluateCommandExec}=require('./lib/command-exec-gate');
const cmd='sh -c "rm -rf \\"/\\""';
console.log('cmd:', cmd);
const r=evaluateCommandExec(cmd);
console.log(JSON.stringify(r,null,2));
