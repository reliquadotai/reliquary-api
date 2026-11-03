import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {AFFINE_BATCH_KIT_REVISION, reviewAffineBatch,exportAffineBatch,planAffineBatch} from '../dist/affine-batches.js';
const f=JSON.parse(readFileSync(new URL('./fixtures/affine-batches.json',import.meta.url))), enc=v=>new TextEncoder().encode(JSON.stringify(v)), mining=enc(f.mining), hotkey='fixture-owner';
const input={hotkey,head:'b'.repeat(64),reference:'c'.repeat(64),master:'provided',seed:42,prior:'env-average',trainingResultAt:21601,lastGreenDecidedAt:1};
test('official batch structural fixtures preserve prefix cap behavior and arbitrary rollout counts',async()=>{
 for(const c of f.cases){if(!c.valid){await assert.rejects(reviewAffineBatch(enc(c.batch),hotkey,mining));continue;}const report=await reviewAffineBatch(enc(c.batch),hotkey,mining);for(const k of ['prompts','rollouts','droppedGroups'])assert.equal(report[k],c[k],c.name);assert.equal(report.structuralOnly,true);assert.equal(report.tokenValidation,'not_run');}
});
test('batch review hashes exact bytes, keeps defaults, never clamps or mutates exported inputs',async()=>{
 const value=f.cases[0].batch,before=JSON.stringify(value),raw=new TextEncoder().encode('  '+before+'\n');const report=await reviewAffineBatch(raw,hotkey,mining);assert.equal(report.sha256,createHash('sha256').update(raw).digest('hex'));assert.deepEqual(report.train,Object.fromEntries(Object.entries(f.mining.batch_file.train.fields).map(([k,v])=>[k,v.default])));assert.equal(JSON.stringify(value),before);
 const exported=await exportAffineBatch(value,hotkey,mining);assert.equal(new TextDecoder().decode(exported),before+'\n');assert.equal(JSON.stringify(value),before);
 for(const train of [{lr:Infinity},{kl:false},{lr:0},{kl:0.100001},{extra:1},null])await assert.rejects(reviewAffineBatch(enc({...value,version:'affine-batch-v2',train}),hotkey,mining));
 for(const train of [{lr:1.25e-7,kl:0.005},{lr:1e-6,kl:0.1},{}])await reviewAffineBatch(enc({...value,version:'affine-batch-v2',train}),hotkey,mining);
 await assert.rejects(exportAffineBatch({...value,groups:[{prompt:'x',rollouts:[{output:new Date(),reward:1}]}]},hotkey,mining));
 await assert.rejects(exportAffineBatch({...value,groups:[{prompt:'x',rollouts:[{output:'x',reward:Infinity}]}]},hotkey,mining));
 for(const bytes of [new Uint8Array(),new Uint8Array([255]),new Uint8Array(64*1024*1024+1)])await assert.rejects(reviewAffineBatch(bytes,hotkey,mining));
 await assert.rejects(reviewAffineBatch(enc(value),'other-owner',mining));await assert.rejects(reviewAffineBatch(enc({...value,train:{}}),hotkey,mining));
});
test('portable plan is deterministic, input-bound and never executes or claims qualification',async()=>{
 const raw=enc(f.cases[0].batch),p=await planAffineBatch(raw,mining,input);assert.deepEqual(p,await planAffineBatch(raw,mining,input));assert.equal(p.upstream.revision,AFFINE_BATCH_KIT_REVISION);assert.equal(p.comparison.barZ,1);assert.equal(p.qualification,'not_run');for(const k of ['liveParity','officialAcceptance','chainSubmission'])assert.equal(p[k],false);
 assert.equal(p.batch.sha256,createHash('sha256').update(raw).digest('hex'));assert.equal(p.mining.sha256,createHash('sha256').update(mining).digest('hex'));assert.deepEqual(p.commands.map(c=>c.stage),['validate','train','compare']);assert(p.commands.every(c=>c.argv.includes('<MINING>')));assert(p.commands[1].argv.includes('<MASTER>'));assert.deepEqual(p.commands[2].argv.slice(-2),['--master','<MASTER>']);
 for(const change of [{seed:-1},{seed:2**32},{head:'main'},{reference:'https://example.invalid'},{trainingResultAt:-1},{prior:'automatic'},{unexpected:true}])await assert.rejects(planAffineBatch(raw,mining,{...input,...change}));
});

test('async review and plans freeze bytes and metadata before caller mutation',async()=>{
 const raw=enc(f.cases[0].batch), original=raw.slice(), contract=mining.slice(), metadata={...input};
 const pending=planAffineBatch(raw,contract,metadata);
 raw.fill(0);contract.fill(0);metadata.seed=99;metadata.head='d'.repeat(64);
 const plan=await pending;assert.equal(plan.batch.sha256,createHash('sha256').update(original).digest('hex'));assert.equal(plan.comparison.seed,42);assert.equal(plan.head.digest,input.head);
});

test('fixed kit rejects unsupported mining train bounds and CLI-invalid identities; zero clock is valid',async()=>{
 const raw=enc(f.cases[0].batch), changed=structuredClone(f.mining);changed.batch_file.train.fields.lr.max=1;
 await assert.rejects(reviewAffineBatch(raw,hotkey,enc(changed)),{message:'unsupported_train_contract'});
 for(const h of ['bad owner','owner\nvalue','owner/path']){await assert.rejects(reviewAffineBatch(enc({...f.cases[0].batch,hotkey:h}),h,mining));}
 const plan=await planAffineBatch(raw,mining,{...input,lastGreenDecidedAt:0,trainingResultAt:0});assert.equal(plan.comparison.barZ,1);
});


test('all current train fields accept endpoints and reject wrong types, unknown choices and lexical float step multipliers',async()=>{
 const batch={...f.cases[0].batch,version:'affine-batch-v2'};
 for(const [key,field] of Object.entries(f.mining.batch_file.train.fields)){
  for(const v of field.choices??[field.min,field.max])await exportAffineBatch({...batch,train:{[key]:v}},hotkey,mining);
  for(const v of [null,true,'2',...(field.type==='string'?['unknown',2]:[-1,Infinity])])await assert.rejects(exportAffineBatch({...batch,train:{[key]:v}},hotkey,mining),undefined,key);
 }
 for(const literal of ['2.0','2e0','1.0','2.5']){
  const raw=new TextEncoder().encode(JSON.stringify({...batch,train:{step_mult:2}}).replace('"step_mult":2','"step_mult":'+literal));
  await assert.rejects(reviewAffineBatch(raw,hotkey,mining));
 }
 const parsed=await reviewAffineBatch(enc({...batch,train:{adv_center:'group_norm',adv_clip:1,step_mult:2,lr_scale_embed:0}}),hotkey,mining);
 assert.equal(parsed.train.step_mult,2);assert.equal(parsed.train.lr_scale_embed,0);
});
test('current plans pin fixed public approximation and refuse unsupported round policies',async()=>{
 const raw=enc(f.cases[0].batch),plan=await planAffineBatch(raw,mining,input);
 assert.equal(plan.comparison.comparisonClockRule,'fixed-z-1-public-prior-v1');assert.equal(plan.comparison.assurance,'PUBLIC PRIOR APPROXIMATION');assert.equal(plan.comparison.settings.max_tokens,12288);
 for(const [k,v] of Object.entries({bar_z:0.25,max_tokens:8192,max_context_tokens:12288,weighting:'uniform',cap_rule:'env',k_cand:1})){
  const changed=structuredClone(f.mining);changed.training.promotion_gate.heldout.current_round.settings[k]=v;
  await assert.rejects(planAffineBatch(raw,enc(changed),input),{message:'unsupported_comparison_contract'});
 }
});
