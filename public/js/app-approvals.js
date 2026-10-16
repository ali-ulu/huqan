'use strict';
// HUQAN dashboard approvals: queue render and load.
// Split out of the former public/js/app.js bundle, which had been collapsed onto
// one statement per line. Load order is fixed by public/index.html and the
// scripts share one top-level scope, exactly as before the split.
async function loadGraph(){const isDefaultWorkspace=!state.ws||state.ws==='default';
if(state.authRequired&&!state.key&&!isDefaultWorkspace){state.graph={nodes:[],links:[]}
;
surface('graph','locked',{reason:M('runtime.locked.graph','API key required to read graph data.'),nextAction:M('onboarding.steps.session.cta','Open Settings')});
renderGraph();
return}
try{const{r,d}
=await json(`/graph-data?workspaceId=${encodeURIComponent(state.ws)}`,{headers:headers()});
if(!r.ok||!Array.isArray(d.nodes)||!Array.isArray(d.links)){state.graph={nodes:[],links:[]}
;
const locked=r.status===401||r.status===403;
surface('graph',locked?'locked':'err',{reason:locked?M('runtime.locked.graph','API key required to read graph data.'):{k:'runtime.failed.graphHttp',f:`Graph request failed with HTTP ${r.status}.`,p:{status:r.status}},nextAction:locked?M('onboarding.steps.session.cta','Open Settings'):M('common.retry','Retry')});
renderGraph();
return}
state.graph=d;
const empty=!d.nodes.length&&!d.links.length;
surface('graph',empty?'empty':'ok',{reason:empty?M('runtime.reason.graphEmpty','The graph endpoint returned no nodes or relations.'):M('runtime.fetched.graph','Graph data fetched for this workspace.'),nextAction:empty?M('home.verify','Verify a claim'):M('common.refresh','Refresh')});
renderGraph()}
catch{state.graph={nodes:[],links:[]}
;
surface('graph','err',{reason:M('runtime.failed.graphNoResponse','Graph request failed before a response was received.'),nextAction:M('common.retry','Retry')});
renderGraph()}
}
function renderApproval(){const s=state.surfaces.approvals,ready=s.s==='ok',empty=ready&&!state.approvals.length,label=surfaceLabel(s.s),count=ready?state.approvals.length:'—';
$('mapprovals').textContent=count;
$('acount').textContent=ready?state.approvals.length:0;
const emptyBox=empty?`<div class="empty"><b>${esc(T('approvals.none','No pending approvals.'))}</b><br>${esc(Tx(s.reason))}<div class="actions">${surfaceCta('approvals')}</div></div>`:`<div class="empty"><b>${esc(T('approvals.queueState',`Approval queue is ${label.toLowerCase()}.`,{state:label.toLowerCase()}))}</b><br>${esc(Tx(s.reason))}<div class="actions">${surfaceCta('approvals')}</div></div>`;
$('afeed').innerHTML=ready?(state.approvals.slice(0,5).map(x=>`<div class="feedrow"><i class="feedico">⇄</i><div><b>${esc(x.sourceRef||x.id)}</b><span>${esc(x.reason||x.sourceType||x.status||'review')}</span></div><em>${esc(x.status||'pending')}</em></div>`).join('')||emptyBox):emptyBox;
$('alist').innerHTML=ready?(state.approvals.map(x=>`<div class="item"><b>${esc(x.sourceRef||x.id)}</b><div class="sub">${esc(x.sourceType||'source')} · ${esc(x.reason||x.status||'review_required')}<br>snapshot ${esc(x.snapshotHash||'—')}</div><div class="actions"><button class="btn good" data-dec="approved" data-id="${esc(x.id)}">${esc(T('approvals.actions.approve','Approve'))}</button><button class="btn bad" data-dec="rejected" data-id="${esc(x.id)}">${esc(T('approvals.actions.reject','Reject'))}</button><button class="btn" data-detail="${esc(x.id)}">${esc(T('approvals.actions.inspect','Inspect'))}</button></div><div class="sub" data-detail-for="${esc(x.id)}"></div></div>`).join('')||emptyBox):emptyBox;
$('ahead').textContent=ready?`${state.approvals.length} pending`:label}
function approvalView(x){if(!x||typeof x!=='object')return null;
const ctx=x.context&&typeof x.context==='object'?x.context:{}
,snap=ctx.snapshot&&typeof ctx.snapshot==='object'?ctx.snapshot:{}
;
return{id:x.id||'',status:x.status||'pending',decision:x.decision||'',reason:x.reason||'',createdAt:Number(x.createdAt||0),updatedAt:Number(x.updatedAt||0),snapshotHash:x.snapshotHash||snap.snapshotHash||'',sourceType:x.sourceType||snap.sourceType||'',sourceRef:x.sourceRef||snap.sourceRef||'',idempotencyKey:x.idempotencyKey||snap.idempotencyKey||''}
}
function readApprovals(d){const list=Array.isArray(d&&d.data&&d.data.approvals)?d.data.approvals:(Array.isArray(d&&d.approvals)?d.approvals:[]);
return list.map(approvalView).filter(Boolean)}
let approvalRequestGeneration=0;
async function loadApprovals(){const generation=++approvalRequestGeneration;
if(state.authRequired&&!state.key){state.approvals=[];
surface('approvals','locked',{reason:M('runtime.locked.approvals','API key required to read pending approvals.'),nextAction:M('onboarding.steps.session.cta','Open Settings')});
$('astate').textContent='LOCKED';
$('astate').className='state locked';
renderApproval();
return}
try{const{r,d}
=await json('/api/v2/approvals?limit=50&workspaceId='+encodeURIComponent(state.ws||'default'),{headers:headers()});
if(generation!==approvalRequestGeneration)return;
if(!r.ok||d.ok===false){state.approvals=[];
const locked=r.status===401||r.status===403;
surface('approvals',locked?'locked':'err',{reason:locked?M('runtime.locked.approvals','API key required to read pending approvals.'):{k:'runtime.failed.approvalsHttp',f:`Approval request failed with HTTP ${r.status}.`,p:{status:r.status}},nextAction:locked?M('onboarding.steps.session.cta','Open Settings'):M('common.retry','Retry')});
$('astate').textContent=locked?'LOCKED':'ERROR';
$('astate').className='state '+(locked?'locked':'err');
renderApproval();
return}
state.approvals=readApprovals(d);
const empty=!state.approvals.length;
surface('approvals',empty?'empty':'ok',{reason:empty?M('runtime.empty.approvals','No pending approvals exist in this workspace.'):M('runtime.fetched.approvals','Approval queue fetched for this workspace.'),nextAction:empty?M('verify.form.actions.review','Send for review'):M('common.refresh','Refresh')});
$('astate').textContent=empty?'EMPTY':'LIVE';
$('astate').className='state '+(empty?'':'ok');
renderApproval()}
catch{if(generation!==approvalRequestGeneration)return;
state.approvals=[];
surface('approvals','err',{reason:M('runtime.failed.approvalsNoResponse','Approval request failed before a response was received.'),nextAction:M('common.retry','Retry')});
$('astate').textContent='ERROR';
$('astate').className='state err';
renderApproval()}
}
$('alist').onclick=e=>{const b=e.target.closest('[data-dec]');
if(b){decide(b.dataset.id,b.dataset.dec);
return}
const i=e.target.closest('[data-detail]');
if(i)inspect(i.dataset.detail)}
;
