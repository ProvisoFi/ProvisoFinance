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
console.log('Template checks passed: every template is a valid, fresh alert draft.');
