import assert from 'node:assert/strict';
import {newThesis,initialWorkspace,validateThesis,validateRisk,validateCopy,isThesis,toSpec,formatCondition} from '../src/lib/proviso/domain.ts';
const t=newThesis(),limits=initialWorkspace.limits;
assert.deepEqual(validateThesis(t,limits),[]);
for(const patch of [{title:''},{market:'FAKE'},{side:'buy'},{match:'none'},{intent:'execute'},{allocation:0},{allocation:501},{allocation:NaN},{leverage:11},{leverage:4},{leverage:1.5},{stop:100},{stop:0},{take:0},{expiryDays:31},{expiryDays:1.5},{cooldownMinutes:-1},{conditions:[]},{conditions:Array(9).fill(t.conditions[0])}])assert.ok(validateThesis({...t,...patch},limits).length,JSON.stringify(patch));
for(const c of [{signal:'unknown',op:'>',value:1},{signal:'price',op:'>',value:0},{signal:'oi',op:'<',value:-1},{signal:'fear_greed',op:'>',value:101},{signal:'funding',op:'=',value:1},{signal:'price',op:'>',value:NaN}])assert.ok(validateThesis({...t,conditions:[{id:'c',...c}]},limits).length);
assert.deepEqual(validateThesis({...t,conditions:[{id:'c',signal:'funding',op:'<',value:-.01}]}),[]);
assert.equal(validateRisk(limits),true);
for(const patch of [{maxAllocation:Infinity},{maxLeverage:11},{dailyLoss:0},{maxSlippage:2.1}])assert.equal(validateRisk({...limits,...patch}),false);
assert.equal(validateCopy(initialWorkspace.copy),true);
for(const patch of [{markets:[]},{markets:['FAKE']},{allocation:0},{leverage:11},{sealed:'auto'}])assert.equal(validateCopy({...initialWorkspace.copy,...patch}),false);
assert.equal(isThesis({...t,id:'test',created:'2026-10-20',updated:'2026-10-20'}),true);
for(const v of [null,{},'bad',{...t,conditions:null},{...t,leverage:NaN}])assert.equal(isThesis(v),false);
const a=newThesis(),b=newThesis();a.conditions[0].value=42;assert.equal(b.conditions[0].value,0);
const spec=toSpec({...t,match:'any',side:'short',intent:'live'});
assert.equal(spec.entry.when.any.length,2);assert.equal(spec.entry.then[0].side,'short');assert.equal(spec.mode,'live');assert.equal(spec.exit.stop.pct,-6);assert.equal(spec.fire,'once');assert.equal(spec.expires,'30d');
assert.equal(formatCondition({id:'f',signal:'fear_greed',op:'<',value:20},'HYPE'),'fear_greed(index) < 20');
assert.equal(formatCondition({id:'f',signal:'funding',op:'<',value:0},'HYPE'),'funding(HYPE) < 0%');
console.log('Workspace checks passed: all validation boundaries, malformed drafts, independent state, readable rules, and unsigned export semantics.');
// TU-14: every template opens as a valid alert draft within the default limits, and each call is a fresh copy.
const {templates}=await import('../src/lib/proviso/templates.ts');
assert.ok(templates.length>=4);
assert.equal(new Set(templates.map(x=>x.id)).size,templates.length);
for(const tpl of templates){const d=tpl.thesis();assert.deepEqual(validateThesis(d,limits),[],tpl.id);assert.equal(d.intent,'alert',tpl.id);assert.equal(d.id,'',tpl.id);toSpec(d);}
{const x=templates[0].thesis(),y=templates[0].thesis();x.conditions[0].value=99;assert.notEqual(y.conditions[0].value,99);}
// Expansion #7: the RWA templates pass the same rule check sealing uses (core's capabilities, live markets).
{const {validate}=await import('../../../packages/dsl/src/index.ts');
const m=(lev)=>({maxLeverage:lev,volume24hUsd:5e7});
const hl={BTC:m(40),ETH:m(25),HYPE:m(10),SOL:m(20),'xyz:NVDA':m(20),'xyz:GOLD':m(25),'xyz:SILVER':m(25),'xyz:CL':m(20),'xyz:BRENTOIL':m(20),'xyz:TSLA':m(20)};
const rhc={USDG:{isCanonical:true,poolDepthUsd:Infinity},TSLA:{isCanonical:true,poolDepthUsd:2e5},AMZN:{isCanonical:true,poolDepthUsd:2e5}};
const rwa=templates.filter(t=>t.group==='rwa');assert.equal(rwa.length,6);
for(const tpl of templates){const r=validate(toSpec(tpl.thesis()),{hl,rhc,user:{maxUsd:500,maxLev:3}});assert.ok(r.ok,tpl.id+': '+JSON.stringify(r.errors));}
for(const t of rwa){assert.ok(t.relies&&t.fails,t.id);}}
console.log('Template checks passed: every template is a valid, fresh alert draft that passes the sealing rule check.');
// Dry Run nudges on paper calls: profit first, then 30 and 10 days; never on live calls.
{const {paperNudge}=await import('../src/lib/proviso/call.ts');
const day=86_400_000,now=Date.UTC(2026,9,23),at=(d)=>new Date(now-d*day);
assert.equal(paperNudge({mode:'live',state:'closed',stampedAt:at(40),pnlUsd:5},now),null);
assert.match(paperNudge({mode:'paper',state:'closed',stampedAt:at(2),pnlUsd:12.5},now),/made \$12\.50/);
assert.match(paperNudge({mode:'paper',state:'alert',stampedAt:at(31),pnlUsd:null},now),/^30 days/);
assert.match(paperNudge({mode:'paper',state:'alert',stampedAt:at(10),pnlUsd:-3},now),/^10 days/);
assert.equal(paperNudge({mode:'paper',state:'alert',stampedAt:at(9),pnlUsd:null},now),null);}
// Follower P&L: one line, the caller beside it on the same calls.
{const {copyLine}=await import('../src/lib/proviso/call.ts');
assert.equal(copyLine({followerPnlUsd:5,followerReturnPct:5,callerReturnPct:4}),'Followers made +5.0% ($5.00) copying this call; the caller made +4.0% on the same call.');
assert.equal(copyLine({followerPnlUsd:-12.5,followerReturnPct:-2.5,callerReturnPct:null,copiedCalls:3}),'Followers made −2.5% (−$12.50) across 3 copied calls.');}
