const {evaluateCommandExec}=require('./lib/command-exec-gate');
const cases=[
  'eval "rm -rf /"',
  'env -i sh -c "rm -rf /"',
  'sh -c "rm -rf \\"/\\""',
  "node -e \"require('fs').rmSync('/etc',{recursive:true})\"",
  "python3 -c \"import shutil; shutil.rmtree('/etc')\""
];
for(const cmd of cases){
  const r=evaluateCommandExec(cmd);
  console.log(cmd);
  console.log(' decision:', r.decision, 'match:', r.denylistMatch);
  console.log('---');
}
