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
function mesh(){
const nodes=state.graph.nodes||[],links=state.graph.links||[],box=$('sats'),lines=$('lines');
box.innerHTML='';
lines.innerHTML='';
const layout=graphLayout(nodes,links),ids=Object.keys(layout);
if(!ids.length)return;
const byId=new Map(nodes.map(n=>[String(n?.id),n]));
// Edges are drawn first so the node cards paint above them. A link is drawn
// only when both endpoints were placed; the layout already refused to invent
// the missing one.
for(const l of links){
const a=layout[String(l?.source??l?.from??'')],b=layout[String(l?.target??l?.to??'')];
if(!a||!b)continue;
const z=document.createElementNS('http://www.w3.org/2000/svg','line');
z.setAttribute('x1',a.x+'%');z.setAttribute('y1',a.y+'%');
z.setAttribute('x2',b.x+'%');z.setAttribute('y2',b.y+'%');
z.setAttribute('data-relation',String(l.relation||l.type||'related'));
lines.appendChild(z)}
for(const id of ids){
const n=byId.get(id)||{id},p=layout[id];
const raw=Number(n.confidence??n.weight??0.5);
const c=Number.isFinite(raw)?Math.max(0,Math.min(1,raw)):0.5;
const x=document.createElement('div');
x.className='sat';
x.style.left=p.x+'%';x.style.top=p.y+'%';
x.style.setProperty('--conf',c.toFixed(2));
x.innerHTML=`<b>${esc(nodeLabel(n))}</b><span>${esc(T('graph.nodeLabel','Graph node'))} · ${esc(n.id||'linked')}</span>`;
box.appendChild(x)}}
// Deterministic force-directed layout for the trust-network mesh (#4292).
//
// Pure: the same nodes and links produce the same coordinates on every call,
// so a rendered position is reproducible and testable without a browser. The
// node list is ordered by id and edges are de-duplicated by unordered pair
// before anything moves, which is what makes the result independent of the
// order the graph-data surface happens to publish.
//
// Bounded, because one force pass is O(n^2): at most LAYOUT_MAX_NODES nodes are
// laid out and LAYOUT_ITERATIONS passes run, so a large workspace cannot stall
// the first paint. No randomness, no new dependency.
const LAYOUT_MAX_NODES=60,LAYOUT_ITERATIONS=60,LAYOUT_PAD=8;
function graphLayout(nodes,links){
const list=(nodes||[]).filter(n=>n&&n.id!=null).map(n=>({id:String(n.id)})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).slice(0,LAYOUT_MAX_NODES);
const n=list.length,out={};
if(n===0)return out;
if(n===1){out[list[0].id]={x:50,y:50};return out}
// Only real endpoints of the supplied links are placed; a link to an unknown
// node or a self-loop is dropped, never invented as a node.
const at=new Map(list.map((node,i)=>[node.id,i])),seen=new Set(),edges=[];
for(const l of (links||[])){if(!l)continue;
const a=at.get(String(l.source??l.from??'')),b=at.get(String(l.target??l.to??''));
if(a===undefined||b===undefined||a===b)continue;
const key=a<b?a+'|'+b:b+'|'+a;if(seen.has(key))continue;seen.add(key);edges.push([a,b])}
// Edges are sorted by endpoint index so the force accumulation below visits
// them in one fixed order; float addition is not associative, so leaving the
// order to the payload would make the coordinates depend on it.
edges.sort((p,q)=>p[0]-q[0]||p[1]-q[1]);
// Deterministic seed: nodes start on a circle in id order, no RNG.
const pos=list.map((node,i)=>{const ang=(2*Math.PI*i)/n-Math.PI/2;return{x:50+34*Math.cos(ang),y:50+34*Math.sin(ang)}});
const span=100-2*LAYOUT_PAD,area=span*span,k=Math.sqrt(area/n);
let temp=span/6;const cool=temp/(LAYOUT_ITERATIONS+1),disp=pos.map(()=>({x:0,y:0}));
for(let it=0;it<LAYOUT_ITERATIONS;it++){
for(const d of disp){d.x=0;d.y=0}
for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
const dx=pos[i].x-pos[j].x,dy=pos[i].y-pos[j].y,dist=Math.sqrt(dx*dx+dy*dy)||0.01,f=(k*k)/dist,ux=dx/dist,uy=dy/dist;
disp[i].x+=ux*f;disp[i].y+=uy*f;disp[j].x-=ux*f;disp[j].y-=uy*f}
for(const[a,b] of edges){
const dx=pos[a].x-pos[b].x,dy=pos[a].y-pos[b].y,dist=Math.sqrt(dx*dx+dy*dy)||0.01,f=(dist*dist)/k,ux=dx/dist,uy=dy/dist;
disp[a].x-=ux*f;disp[a].y-=uy*f;disp[b].x+=ux*f;disp[b].y+=uy*f}
for(let i=0;i<n;i++){
const len=Math.sqrt(disp[i].x*disp[i].x+disp[i].y*disp[i].y)||0.01,lim=Math.min(len,temp);
pos[i].x=Math.max(LAYOUT_PAD,Math.min(100-LAYOUT_PAD,pos[i].x+(disp[i].x/len)*lim));
pos[i].y=Math.max(LAYOUT_PAD,Math.min(100-LAYOUT_PAD,pos[i].y+(disp[i].y/len)*lim))}
temp=Math.max(0,temp-cool)}
list.forEach((node,i)=>{out[node.id]={x:pos[i].x,y:pos[i].y}});
return out}
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
renderGraphView();
renderConflicts()}
function rel(v){return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}
// #4291: relation families come from the canonical registry (lib/type-lattice.js
// TYPE_LATTICE_RELATIONS), not from the Turkish spelling alone. Stored already
// normalised through rel(), so `tür` lands as `tur`. test/ui-conflict-triage-
// contract.test.js asserts this set covers the canonical one, so adding a type
// relation there fails here until it is mirrored.
const TYPE_RELATIONS=new Set(['tur','is_a','is-a','isa']);
const NEGATION_RELATIONS=new Set(['degil','degildir','yok','yoktur','olmaz','asla','hicbir','not','isnt','arent','wasnt','cannot','cant','no','never','contradicts','negates']);
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
n.forEach(x=>{const a=out.get(String(x.id))||[],typeTargets=new Set(a.filter(y=>TYPE_RELATIONS.has(rel(y.relation))).map(y=>endId(y.target))),types=typeTargets.size,negations=a.filter(y=>NEGATION_RELATIONS.has(rel(y.relation))),c=Number(x.confidence??x.weight??.5),stale=x.last_seen&&Number.isFinite(Date.parse(x.last_seen))&&now-Date.parse(x.last_seen)>2592000000;if(types>1)f.push({type:'multi-type',subject:nodeLabel(x),detail:`${types} distinct-type relations.`});if(negations.length>0&&a.some(y=>!NEGATION_RELATIONS.has(rel(y.relation))))f.push({type:'negation',subject:nodeLabel(x),detail:T('conflicts.detail.negation','Negation and positive relation coexist.')});if(c<.35)f.push({type:'low-confidence',subject:nodeLabel(x),detail:`Low confidence: ${c.toFixed(2)}`});if(stale)f.push({type:'stale',subject:nodeLabel(x),detail:`last_seen is stale: ${x.last_seen}`})});
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

// --- Interactive Trust Network view (#4292) --------------------------------
//
// The mesh above is the overview thumbnail. This is the full #v-graph view: it
// draws the same real graph-data payload at a readable size, lets the reader
// zoom, pan and pick a node, and shows that node's relations in a detail panel.
//
// Accessibility: the stage is a labelled role="group" the reader can focus and
// drive from the keyboard, each node is a real <button> (so Tab reaches it and
// Enter/Space selects it), and the edge layer is aria-hidden because the same
// relations are already readable as text in the detail panel and the RELATIONS
// list. Nothing here invents a node or an edge: a link whose endpoint the
// layout did not place is simply not drawn.
const GVIEW_MIN_ZOOM=0.4,GVIEW_MAX_ZOOM=3,GVIEW_ZOOM_STEP=0.2;
const gview={zoom:1,panX:0,panY:0,selected:'',dragging:false,dragX:0,dragY:0};

function graphViewNode(id){
const n=(state.graph.nodes||[]).find(x=>String(x?.id)===String(id));
return n||null}

/** Relation family for a colour cue, reusing the canonical sets above. */
function relationFamily(relation){
const r=rel(relation);
if(TYPE_RELATIONS.has(r))return 'type';
if(NEGATION_RELATIONS.has(r))return 'negation';
return 'other'}

function graphViewReset(){gview.zoom=1;gview.panX=0;gview.panY=0}

function graphViewApply(){
const stage=$('graphstage'),nodes=$('gnodes'),edges=$('gedges');
if(!stage||!nodes||!edges)return;
const t=`translate(${gview.panX}px,${gview.panY}px) scale(${gview.zoom})`;
nodes.style.transform=t;nodes.style.transformOrigin='50% 50%';
edges.style.transform=t;edges.style.transformOrigin='50% 50%';
const level=$('gzoomlevel');
if(level)level.textContent=`${Math.round(gview.zoom*100)}%`}

function graphViewSelect(id){
gview.selected=String(id||'');
renderGraphViewDetail();
const nodes=$('gnodes');
if(nodes)nodes.querySelectorAll('.gnode').forEach(el=>{
const on=el.dataset.nodeId===gview.selected;
el.setAttribute('aria-pressed',on?'true':'false')})}

function renderGraphViewDetail(){
const body=$('graphdetailbody');
if(!body)return;
const node=graphViewNode(gview.selected);
if(!node){
body.innerHTML=`<div class="empty"><b>${esc(T('graph.detail.none','No node selected.'))}</b><br><span>${esc(T('graph.detail.noneHint','Select a node in the graph to see its relations.'))}</span></div>`;
return}
const links=(state.graph.links||[]).filter(l=>String(l?.source??l?.from??'')===String(node.id)||String(l?.target??l?.to??'')===String(node.id));
const conf=node.confidence??node.weight;
const rels=links.slice(0,50).map(l=>{
const outgoing=String(l?.source??l?.from??'')===String(node.id);
const other=endId(outgoing?(l?.target??l?.to):(l?.source??l?.from));
const arrow=outgoing?'→':'←';
return `<div><span>${esc(arrow)} ${esc(l.relation||l.type||'related')} ${esc(other)}</span><em>${esc(relationFamily(l.relation))}</em></div>`}).join('');
body.innerHTML=`<h4>${esc(T('graph.detail.node','Node'))}</h4><dl class="kv"><dt>${esc(T('graph.detail.label','Label'))}</dt><dd>${esc(nodeLabel(node))}</dd><dt>${esc(T('graph.detail.id','ID'))}</dt><dd>${esc(node.id??'—')}</dd><dt>${esc(T('graph.detail.confidence','Confidence'))}</dt><dd>${esc(conf??'—')}</dd><dt>${esc(T('graph.detail.lastSeen','Last seen'))}</dt><dd>${esc(node.last_seen||node.lastSeen||'—')}</dd></dl><h4>${esc(T('graph.detail.relations','Relations'))}</h4>${rels?`<div class="rel-list">${rels}</div>`:`<div class="empty">${esc(T('graph.detail.noRelations','No relations for this node.'))}</div>`}`}

function renderGraphView(){
const stage=$('graphstage'),nodes=$('gnodes'),edges=$('gedges'),empty=$('graphempty');
if(!stage||!nodes||!edges)return;
const all=state.graph.nodes||[],links=state.graph.links||[],s=state.surfaces.graph;
nodes.innerHTML='';
edges.innerHTML='';
const layout=graphLayout(all,links),ids=Object.keys(layout);
if(!ids.length){
if(empty){
empty.hidden=false;
empty.innerHTML=`<b>${esc(T('graph.emptyInWorkspace','No graph data in this workspace'))}</b><br><span>${esc(Tx(s.reason))}</span>`}
return}
if(empty)empty.hidden=true;
const byId=new Map(all.map(n=>[String(n?.id),n]));
// Edges first so node buttons sit above the lines.
for(const l of links){
const a=layout[String(l?.source??l?.from??'')],b=layout[String(l?.target??l?.to??'')];
if(!a||!b)continue;
const z=document.createElementNS('http://www.w3.org/2000/svg','line');
z.setAttribute('x1',a.x+'%');z.setAttribute('y1',a.y+'%');
z.setAttribute('x2',b.x+'%');z.setAttribute('y2',b.y+'%');
z.setAttribute('data-relation-family',relationFamily(l.relation));
edges.appendChild(z)}
for(const id of ids){
const n=byId.get(id)||{id},p=layout[id];
const btn=document.createElement('button');
btn.type='button';
btn.className='gnode';
btn.dataset.nodeId=id;
btn.style.left=p.x+'%';btn.style.top=p.y+'%';
const raw=Number(n.confidence??n.weight??0.5);
const c=Number.isFinite(raw)?Math.max(0,Math.min(1,raw)):0.5;
btn.style.setProperty('--conf',c.toFixed(2));
btn.setAttribute('aria-pressed','false');
btn.innerHTML=`<b>${esc(nodeLabel(n))}</b><span>${esc(T('graph.nodeLabel','Graph node'))} · ${esc(n.id||'linked')}</span><i aria-hidden="true"></i>`;
btn.addEventListener('click',()=>graphViewSelect(id));
nodes.appendChild(btn)}
if(!gview.selected||!Object.hasOwn(layout,gview.selected))gview.selected='';
graphViewApply();
renderGraphViewDetail()}

function graphViewZoom(delta){
gview.zoom=Math.max(GVIEW_MIN_ZOOM,Math.min(GVIEW_MAX_ZOOM,Number((gview.zoom+delta).toFixed(2))));
graphViewApply()}

function bindGraphView(){
const stage=$('graphstage');
if(!stage)return;
const zin=$('gzoom-in'),zout=$('gzoom-out'),zreset=$('gzoom-reset');
if(zin)zin.addEventListener('click',()=>graphViewZoom(GVIEW_ZOOM_STEP));
if(zout)zout.addEventListener('click',()=>graphViewZoom(-GVIEW_ZOOM_STEP));
if(zreset)zreset.addEventListener('click',()=>{graphViewReset();graphViewApply()});
stage.addEventListener('wheel',e=>{e.preventDefault();graphViewZoom(e.deltaY<0?GVIEW_ZOOM_STEP:-GVIEW_ZOOM_STEP)},{passive:false});
stage.addEventListener('pointerdown',e=>{
if(e.target.closest('.gnode'))return;
gview.dragging=true;gview.dragX=e.clientX-gview.panX;gview.dragY=e.clientY-gview.panY;
stage.classList.add('dragging');
if(stage.setPointerCapture)stage.setPointerCapture(e.pointerId)});
stage.addEventListener('pointermove',e=>{
if(!gview.dragging)return;
gview.panX=e.clientX-gview.dragX;gview.panY=e.clientY-gview.dragY;graphViewApply()});
const stop=e=>{if(!gview.dragging)return;gview.dragging=false;stage.classList.remove('dragging');
if(stage.releasePointerCapture&&e.pointerId!=null&&stage.hasPointerCapture?.(e.pointerId))stage.releasePointerCapture(e.pointerId)};
stage.addEventListener('pointerup',stop);
stage.addEventListener('pointercancel',stop);
// Keyboard parity for the mouse actions: arrows pan, +/- zoom, 0 resets. A
// lookup rather than a branch chain, so the mapping stays one table.
const GRAPH_VIEW_KEYS={ArrowLeft:()=>{gview.panX-=20},ArrowRight:()=>{gview.panX+=20},ArrowUp:()=>{gview.panY-=20},ArrowDown:()=>{gview.panY+=20},'+':()=>graphViewZoom(GVIEW_ZOOM_STEP),'=':()=>graphViewZoom(GVIEW_ZOOM_STEP),'-':()=>graphViewZoom(-GVIEW_ZOOM_STEP),'_':()=>graphViewZoom(-GVIEW_ZOOM_STEP),'0':()=>graphViewReset()};
stage.addEventListener('keydown',e=>{
const action=GRAPH_VIEW_KEYS[e.key];
if(!action)return;
action();
e.preventDefault();graphViewApply()})}

if(typeof window!=='undefined'&&window.addEventListener){
window.addEventListener('huqan-i18n-ready',()=>{renderGraphView();renderGraphViewDetail()});
window.addEventListener('huqan-locale-change',()=>{renderGraphView();renderGraphViewDetail()})}
