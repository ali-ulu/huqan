'use strict';
// HUQAN dashboard graph: mesh, conflict triage, graph load.
// Split out of the former public/js/app.js bundle, which had been collapsed onto
// one statement per line. Load order is fixed by public/index.html and the
// scripts share one top-level scope, exactly as before the split.
async function loadManifest(){try{const{r,d}
=await json('/api/v2/workflows',{headers:{Accept:'application/json'}});
if(!r.ok||!Array.isArray(d.workflows))throw 0;
state.manifest=d;
surface('workflows','ok',{reason:M('runtime.fetched.manifest','Capability manifest fetched.'),nextAction:M('common.refresh','Refresh')});
$('wstate').textContent=T('verify.workflowReady','READY');
$('wstate').className='state ok';
$('wcontract').textContent=`contract ${d.contractVersion||'?'} · ${d.workflows.length} workflow`;
const e=new Set(d.workflows.filter(x=>x.availability?.ui).map(x=>x.workflowId));
[...$('action').options].forEach(o=>o.disabled=!e.has(o.value));
$('vstatus').textContent=T('verify.manifestReady','Capability manifest ready.');
$('vstatus').className='status good'}
catch{state.manifest=null;
surface('workflows','err',{reason:M('runtime.failed.manifest','Capability manifest request failed.'),nextAction:M('common.retry','Retry')});
$('wstate').textContent=T('status.unavailable','UNAVAILABLE');
$('wstate').className='state err';
$('vstatus').textContent=T('verify.manifestUnavailable','Capability manifest unavailable.');
$('vstatus').className='status bad'}
}
function nodeLabel(n){return String(n?.label||n?.name||n?.id||'node')}
function mesh(){const nodes=state.graph.nodes.slice(0,8),pos=[[12,23],[11,47],[14,70],[72,22],[76,46],[73,69],[43,10],[44,80]];
$('sats').innerHTML='';
$('lines').innerHTML='';
nodes.forEach((n,i)=>{const[l,t]=pos[i],x=document.createElement('div');x.className='sat';x.style.left=l+'%';x.style.top=t+'%';x.innerHTML=`<b>${esc(nodeLabel(n))}</b><span>${esc(T('graph.nodeLabel','Graph node'))} · ${esc(n.id||'linked')}</span>`;$('sats').appendChild(x);const z=document.createElementNS('http://www.w3.org/2000/svg','line');z.setAttribute('x1',(l<50?l+12:l)+'%');z.setAttribute('y1',(t+4)+'%');z.setAttribute('x2','50%');z.setAttribute('y2','52%');$('lines').appendChild(z)})}
function renderGraph(){const n=state.graph.nodes||[],l=state.graph.links||[],s=state.surfaces.graph,ready=s.s==='ok',hasData=ready&&(n.length||l.length),label=surfaceLabel(s.s);
$('mnodes').textContent=ready?n.length:'—';
$('medges').textContent=ready?l.length:'—';
$('meshsub').textContent=ready?(hasData?`${n.length} node · ${l.length} relation`:T('graph.emptyInWorkspace','No graph data in this workspace')):Tx(s.reason);
$('meshbadge').textContent=ready?(hasData?`${n.length} nodes active`:T('emptyStates.noGraphData','No graph data')):`${label} · ${Tx(s.reason)}`;
$('meshbadgestate').textContent=`● ${label}`;
$('meshbadgestate').style.color=ready?(hasData?'var(--good)':'var(--muted)'):s.s==='locked'?'var(--warn)':s.s==='err'?'var(--bad)':'var(--muted)';
$('gcount').textContent=ready?`${n.length} / ${l.length}`:label;
mesh();
$('meshstage').hidden=!hasData;
$('lines').hidden=!hasData;
$('sats').hidden=!hasData;
const box=$('meshstate');
box.hidden=Boolean(hasData);
box.innerHTML=ready&&!hasData?`<b>${esc(T('graph.dataEmpty','Graph data is empty.'))}</b><br><span>${esc(Tx(s.reason))}</span><div class="actions">${surfaceCta('graph')}</div>`:`<b>${esc(T('graph.dataState',`Graph data is ${label.toLowerCase()}.`,{state:label.toLowerCase()}))}</b><br><span>${esc(Tx(s.reason))}</span><div class="actions">${surfaceCta('graph')}</div>`;
const nodeEmpty=ready?(hasData?'' : `<div class="empty"><b>${esc(T('graph.isEmpty','Graph is empty.'))}</b><br>${esc(Tx(s.reason))}<div class="actions">${surfaceCta('graph')}</div></div>`):`<div class="empty"><b>${esc(T('graph.isState',`Graph is ${label.toLowerCase()}.`,{state:label.toLowerCase()}))}</b><br>${esc(Tx(s.reason))}<div class="actions">${surfaceCta('graph')}</div></div>`;
$('chips').innerHTML=n.slice(0,6).map(x=>`<div class="chip"><b>${esc(nodeLabel(x))}</b><span>● confidence ${esc(x.confidence??x.weight??'—')}</span></div>`).join('')||nodeEmpty;
$('edges').innerHTML=l.slice(0,100).map(x=>`<div class="item"><b>${esc(endId(x.source))} → ${esc(x.relation||x.type||'related')} → ${esc(endId(x.target))}</b></div>`).join('')||`<div class="empty"><b>${ready?esc(T('graph.noRelations','No relations yet.')):esc(T('graph.relationsState',`Relations are ${label.toLowerCase()}.`,{state:label.toLowerCase()}))}</b><br>${esc(Tx(s.reason))}${ready&&hasData?'':`<div class="actions">${surfaceCta('graph')}</div>`}</div>`;
renderConflicts()}
function rel(v){return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}
const CONFLICT_PAGE=10;
const CONFLICT_TYPES={'multi-type':{label:M('conflicts.signalType.multiType','Conflicting types'),severity:'high'}
,'negation':{label:M('conflicts.signalType.negation','Negation conflict'),severity:'high'}
,'low-confidence':{label:M('conflicts.signalType.lowConfidence','Low confidence'),severity:'medium'}
,'stale':{label:M('conflicts.signalType.stale','Stale evidence'),severity:'low'}
}
;
const CONFLICT_SEVERITY={high:{rank:0,label:M('conflicts.severity.high','High priority')}
,medium:{rank:1,label:M('conflicts.severity.medium','Needs review')}
,low:{rank:2,label:M('conflicts.severity.low','Informational')}
}
;
function triageConflicts(nodes,links,now){const n=nodes||[],l=links||[],out=new Map(n.map(x=>[String(x.id),[]])),f=[];
l.forEach(x=>{const k=endId(x.source);if(!out.has(k))out.set(k,[]);out.get(k).push(x)});
n.forEach(x=>{const a=out.get(String(x.id))||[],types=a.filter(y=>rel(y.relation)==='tur').length,neg=a.filter(y=>rel(y.relation)==='degil').length,c=Number(x.confidence??x.weight??.5),stale=x.last_seen&&Number.isFinite(Date.parse(x.last_seen))&&now-Date.parse(x.last_seen)>2592000000;if(types>1)f.push({type:'multi-type',subject:nodeLabel(x),detail:`${types} distinct-type relations.`});if(neg&&a.some(y=>rel(y.relation)!=='degil'))f.push({type:'negation',subject:nodeLabel(x),detail:T('conflicts.detail.negation','Negation and positive relation coexist.')});if(c<.35)f.push({type:'low-confidence',subject:nodeLabel(x),detail:`Low confidence: ${c.toFixed(2)}`});if(stale)f.push({type:'stale',subject:nodeLabel(x),detail:`last_seen is stale: ${x.last_seen}`})});
f.forEach(x=>{x.severity=CONFLICT_TYPES[x.type].severity;x.typeLabel=CONFLICT_TYPES[x.type].label});
f.sort((a,b)=>CONFLICT_SEVERITY[a.severity].rank-CONFLICT_SEVERITY[b.severity].rank||a.type.localeCompare(b.type)||a.subject.localeCompare(b.subject));
const counts={high:0,medium:0,low:0,total:f.length,byType:{'multi-type':0,'negation':0,'low-confidence':0,'stale':0}
}
;
f.forEach(x=>{counts[x.severity]+=1;counts.byType[x.type]+=1});
return{findings:f,counts}
}
function filterConflicts(findings,filters){const sev=(filters&&filters.severity)||'',type=(filters&&filters.type)||'';
return(findings||[]).filter(x=>(!sev||x.severity===sev)&&(!type||x.type===type))}
function conflictsFiltered(){const f=state.conflicts.filters;
return Boolean(f.severity||f.type)}
function renderConflicts(){const s=state.surfaces.graph,ready=s.s==='ok'||s.s==='empty',blank=s.s==='empty',label=surfaceLabel(s.s),triage=triageConflicts(state.graph.nodes,state.graph.links,Date.now()),counts=triage.counts;
state.conflicts.findings=triage.findings;
state.conflicts.counts=counts;
const shown=ready?filterConflicts(triage.findings,state.conflicts.filters):[],active=conflictsFiltered(),limit=Math.max(0,Math.min(state.conflicts.limit,shown.length)),page=shown.slice(0,limit),remaining=Math.max(0,shown.length-limit);
$('ccount').textContent=ready?counts.total:'\u2014';
$('csummary').textContent=ready?`${counts.total} signal \u00B7 ${counts.high} high priority`:`${label} \u00B7 ${Tx(s.reason)}`;
$('ctriage').innerHTML=['high','medium','low'].map(k=>`<button type="button" class="chip${state.conflicts.filters.severity===k?' active':''}" data-conflict-severity="${k}" aria-pressed="${state.conflicts.filters.severity===k}"><b>${esc(Tx(CONFLICT_SEVERITY[k].label))}</b><span>${ready?counts[k]:'\u2014'} signal</span></button>`).join('');
$('clistmeta').textContent=ready?`showing ${page.length} of ${shown.length}${active?` filtered \u00B7 ${counts.total} total`:''}`:label.toLowerCase();
$('cstatus').textContent=!ready?`Conflict triage is ${label.toLowerCase()}. ${Tx(s.reason)}`:blank?T('conflicts.nothingToTriage','No graph data in this workspace yet, so there is nothing to triage.'):counts.total===0?T('conflicts.noSignals','No conflict signals in current graph data.'):shown.length===0?T('conflicts.noMatch','No signals match the selected filters.'):`Showing ${page.length} of ${shown.length} signal${shown.length===1?'':'s'}, highest severity first.`;
$('cstatus').className='status '+(!ready?'bad':blank?'':counts.high?'bad':counts.total?'':'good');
$('clist').innerHTML=page.map(x=>`<div class="item" data-conflict-row="${esc(x.severity)}" data-conflict-type="${esc(x.type)}"><b>${esc(x.subject)}</b><div class="sub">${esc(x.detail)}</div><span class="tag ${x.severity==='high'?'bad':''}">${esc(Tx(CONFLICT_SEVERITY[x.severity].label))}</span><span class="tag">${esc(x.typeLabel)}</span></div>`).join('')||(!ready?`<div class="empty"><b>${esc(T('conflicts.triageState',`Conflict triage is ${label.toLowerCase()}.`,{state:label.toLowerCase()}))}</b><br>${esc(Tx(s.reason))}<div class="actions">${surfaceCta('graph')}</div></div>`:blank?`<div class="empty"><b>${esc(T('conflicts.blankWorkspace','No graph data in this workspace yet.'))}</b><br>${esc(Tx(s.reason))}<div class="actions">${surfaceCta('graph')}</div></div>`:counts.total===0?`<div class="empty"><b>${esc(T('conflicts.noSignals','No conflict signals in current graph data.'))}</b><br>${esc(T('conflicts.noSignalsHint','Signals appear here when the graph carries conflicting types, negations, low confidence, or stale evidence.'))}</div>`:`<div class="empty"><b>${esc(T('conflicts.noMatch','No signals match the selected filters.'))}</b><br>${counts.total} signal${counts.total===1?' is':'s are'} hidden by the current severity and type selection.<div class="actions"><button type="button" class="btn" data-action="conflicts-clear">${esc(T('conflicts.clearFilters','Clear filters'))}</button></div></div>`);
const more=$('cmore');
more.hidden=remaining<=0;
more.textContent=`Show ${Math.min(CONFLICT_PAGE,remaining)} more (${remaining} remaining)`;
$('cless').hidden=state.conflicts.limit<=CONFLICT_PAGE||shown.length<=CONFLICT_PAGE;
$('cseverity').value=state.conflicts.filters.severity;
$('ctype').value=state.conflicts.filters.type;
$('cclear').disabled=!active}
function setConflictFilter(key,value){state.conflicts.filters[key]=value||'';
state.conflicts.limit=CONFLICT_PAGE;
renderConflicts()}
function clearConflictFilters(){state.conflicts.filters={severity:'',type:''}
;
state.conflicts.limit=CONFLICT_PAGE;
renderConflicts()}
