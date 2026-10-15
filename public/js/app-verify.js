'use strict';
// HUQAN dashboard verify: capability gates and the run action.
// Split out of the former public/js/app.js bundle, which had been collapsed onto
// one statement per line. Load order is fixed by public/index.html and the
// scripts share one top-level scope, exactly as before the split.
async function inspect(id){const box=$('alist').querySelector(`[data-detail-for="${CSS.escape(id)}"]`);
const say=t=>{if(box)box.textContent=t}
;
const c=capability('approval-detail');
if(!c?.availability?.ui){say('failed: approval-detail: capability_not_available');
return}
const path=routeFor(c,{id});
if(!path){say('failed: approval-detail: route_template_unsupported');
return}
say('loading…');
try{const{r,d}
=await json(`${path}?workspaceId=${encodeURIComponent(state.ws||'default')}`,{headers:headers()});
if(!r.ok||d.ok===false)throw Error(d?.error?.message||d?.status||`HTTP ${r.status}`);
const approval=d.data?.approval;
if(!approval)throw Error('approval_projection_missing');
const policy=Object.keys(approval.policy||{}).length;
const input=String(approval.input||'').slice(0,200);
say(`tool ${approval.tool||'—'} · policy ${policy} rule(s) · status ${approval.status||'—'} · input ${input||'—'}`)}
catch(e){say(`failed: ${e.message}`)}
}
async function decide(id,decision){const c=capability('approval-decision');
if(!c?.availability?.ui){$('ahead').textContent='failed: approval-decision: capability_not_available';
return}
const path=routeFor(c,{id});
if(!path){$('ahead').textContent='failed: approval-decision: route_template_unsupported';
return}
try{const{r,d}
=await json(`${path}?workspaceId=${encodeURIComponent(state.ws||'default')}`,{method:c.method,headers:headers(true),body:JSON.stringify({decision})});
if(!r.ok||d.ok===false)throw Error(d?.error?.message||d?.status||`HTTP ${r.status}`);
const approval=d.data?.approval;
if(!approval)throw Error('approval_projection_missing');
const rid=d.receiptId||approval.receipt?.receiptId||approval.receipt?.id;
if(rid)receipt(rid,approval.sourceRef||id,approval.status||d.status);
loadApprovals()}
catch(e){$('ahead').textContent=`failed: ${e.message}`}
}
function capability(id){return state.manifest?.workflows?.find(x=>x.workflowId===id)}
function routeFor(c,params){const route=c?.route;
if(!route)return null;
let missing=false;
const filled=route.replace(/\{([^}]+)\}/g,(_,name)=>{const value=params?.[name];if(!value){missing=true;return''}return encodeURIComponent(String(value))});
return missing?null:filled}
const AGENT_ACTIONS=new Set(['agent-plan','agent-run']);
const AGENT_SOFT_STATUS=new Set(['paused','blocked','partial']);
const INGEST_ACTIONS=new Set(['ingest-preview','ingest-execute']);
const INGEST_SOFT_STATUS=new Set(['review_required']);
function agentFields(){const agent=AGENT_ACTIONS.has($('action').value);
$('stepsfield').hidden=!agent;
$('promptlabel').textContent=agent?T('obs.goal','Goal'):T('verify.form.promptLabel','Claim / Query');
$('prompt').placeholder=agent?T('verify.form.goalPlaceholder','Describe the goal the agent should pursue…'):T('verify.form.promptPlaceholder','Enter a claim or question to verify…')}
function ingestFields(){const ingest=INGEST_ACTIONS.has($('action').value),decision=ingest&&$('ingestsource').value==='decision';
$('ingestsourcefield').hidden=!ingest;
$('ingestauthorfield').hidden=!ingest;
$('ingesttitlefield').hidden=!decision;
if(ingest){$('promptlabel').textContent=decision?T('verify.form.rationaleLabel','Rationale'):T('verify.form.noteLabel','Note text');
$('prompt').placeholder=decision?T('verify.form.rationalePlaceholder','Why this was decided…'):T('verify.form.notePlaceholder','The note to queue for review…')}
}
function agentSteps(d){const steps=Array.isArray(d&&d.data&&d.data.steps)?d.data.steps:[];
if(!steps.length)return'';
return`<div class="list">${steps.map((s,i)=>`<div class="item"><b>${i+1}. ${esc((s&&(s.tool||s.action||s.id))||'step')}</b><div class="sub">${esc((s&&(s.status||s.action))||'planned')}${s&&s.id?` · ${esc(s.id)}`:''}</div></div>`).join('')}</div>`}
function agentHandoff(d){const data=d&&d.data||{}
,bits=[];
if(data.runId)bits.push(`<span class="tag">run ${esc(data.runId)}</span>`);
if(data.nextAction)bits.push(`<span class="tag">next ${esc(data.nextAction)}</span>`);
if(data.pauseReason)bits.push(`<span class="tag bad">paused: ${esc(data.pauseReason)}</span>`);
return bits.join('')}
function ingestHandoff(d){const data=d&&d.data||{}
,manifest=data.sourceManifest||{}
,review=data.review||{}
,bits=[];
if(manifest.sourceDigest)bits.push(`<span class="tag">digest ${esc(String(manifest.sourceDigest).slice(0,12))}</span>`);
if(manifest.idempotencyKey)bits.push(`<span class="tag">key ${esc(manifest.idempotencyKey)}</span>`);
if(data.runId)bits.push(`<span class="tag">run ${esc(data.runId)}</span>`);
const next=review.nextAction||data.nextAction;
if(next)bits.push(`<span class="tag">next ${esc(next)}</span>`);
if(data.statusRoute)bits.push(`<span class="tag good">status ${esc(data.statusRoute)}</span>`);
return bits.join('')}
async function run(){const text=$('prompt').value.trim(),a=$('action').value,c=capability(a);
if(!text)return status(AGENT_ACTIONS.has(a)?T('verify.errors.goalRequired','Enter a goal first.'):INGEST_ACTIONS.has(a)?T('verify.errors.ingestRequired','Enter the text to ingest first.'):T('verify.errors.claimRequired','Enter a claim or query first.'),1);
if(!c?.availability?.ui)return status(`${a}: capability_not_available`,1);
state.lastPrompt=text;
$('run').disabled=true;
status(`${a} running…`);
const p={workspaceId:state.ws}
;
if(a==='ask')p.question=text;
else if(a==='memory-search')p.query=text;
else if(AGENT_ACTIONS.has(a)){p.goal=text;
p.maxSteps=Number($('maxsteps').value)||4}
else if(INGEST_ACTIONS.has(a)){const kind=$('ingestsource').value,by=$('ingestauthor').value.trim();
p.sourceType=kind;
if(kind==='decision'){p.title=$('ingesttitle').value.trim();
p.rationale=text;
if(by)p.decidedBy=by}
else{p.text=text;
if(by)p.author=by}
}
else p.claim=text;
try{const{r,d}
=await json(c.route,{method:c.method,headers:headers(true),body:JSON.stringify(p)});
const st=String(d?.status||'');
const soft=r.ok&&((AGENT_ACTIONS.has(a)&&AGENT_SOFT_STATUS.has(st))||(INGEST_ACTIONS.has(a)&&INGEST_SOFT_STATUS.has(st)));
if(!soft&&(!r.ok||d.ok===false))throw Error(d?.error?.message||d?.status||`HTTP ${r.status}`);
$('result').innerHTML=`<div class="item"><b>${esc(d.status||d.data?.status||'completed')}</b>${d.traceId?`<span class="tag">trace ${esc(d.traceId)}</span>`:''}${d.receiptId?`<span class="tag good">receipt ${esc(d.receiptId)}</span>`:''}${AGENT_ACTIONS.has(a)?agentHandoff(d):''}${INGEST_ACTIONS.has(a)?ingestHandoff(d):''}</div>${AGENT_ACTIONS.has(a)?agentSteps(d):''}<pre class="json">${esc(JSON.stringify(d,null,2))}</pre>`;
status(`${a}: ${d.status||'completed'}`,0,!soft);
$('review').disabled=false;
if(d.receiptId)receipt(d.receiptId,text.slice(0,64),d.status);
const src=d.evidence?.find(x=>x?.sourceRef)?.sourceRef;
if(d.receiptId||src){$('einput').value=d.receiptId||src;
$('emode').value=d.receiptId?'receiptId':'sourceRef'}
}
catch(e){$('result').innerHTML=`<div class="empty">${esc(e.message)}</div>`;
status(`failed: ${e.message}`,1)}
finally{$('run').disabled=false}
}
function status(t,bad=false,good=false){$('vstatus').textContent=t;
$('vstatus').className='status '+(bad?'bad':good?'good':'')}
async function hash(t){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t));
return[...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function review(){if(!state.lastPrompt)return;
try{const h=await hash(state.lastPrompt),{r,d}
=await json('/api/ingest',{method:'POST',headers:headers(true),body:JSON.stringify({sourceType:'manual',text:state.lastPrompt,author:'huqan-command-center',date:new Date().toISOString().slice(0,10),workspaceId:state.ws,idempotencyKey:`command-center:${h}`})});
if(!r.ok||d.ok===false)throw Error(d?.error?.message||`HTTP ${r.status}`);
status(`${d.status||'submitted'} · ${d.approval?.id||''}`,0,true);
loadApprovals()}
catch(e){status(`review failed: ${e.message}`,1)}
}
