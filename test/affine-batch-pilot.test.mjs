import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { affineBatchPins, affineBatchRequests as d, createAffineBatchClient, createAffinePilotTransport, parseAffineBatchPrepared, parseAffineBatchRequest, parseAffineBatchProfile, parseAffineBatchReceipt, parseAffineBatchResult, GenerationApiError } from '../dist/index.js';
import { verifyAffineBatchReceipt } from '../examples/affine-batch-pilot.mjs';
const h = 'a'.repeat(64), other = 'b'.repeat(64), expires = 4_000_000_000;
const request = { schema:'affine-batch-request/v1',profileDigest:h,jobDigest:h,maxHours:2,maxCostMicroUsd:25000000,jobExpiresAt:expires };
const config = {schemaVersion:2,profileDigest:h,objective:'One approved step',environment:{id:'batch',version:'1'},model:{id:'fixture/model'},optimization:{method:'affine_batch',maxSteps:1},compute:{offerId:'fixture',gpuCount:1,maxHours:2,providerPolicy:'private'},affineBatchRequest:request,submissionMode:'operator_funded_pilot'};
const prepared = {request,configuration:config,mode:'operator-funded-pilot'};
const context = {upstreamRevision:'a'.repeat(40),masterMode:'bf16-bootstrap',masterDigest:null,referenceProvenance:'published-reference',seed:42,expectedDraw:500,lastGreenDecidedAt:1000,comparisonClockRule:'actual-training-result-minus-frozen-last-green'};
const profile = {...Object.fromEntries(affineBatchPins.map(k=>[k,h])),...context,schema:'affine-batch-profile/v1',ownerUserId:'fixture-owner',billingMode:'operator-funded-pilot',receiptPublicKey:h,maxOutputBytes:4096,maxCostMicroUsd:25000000,jobExpiresAt:expires};
const receipt = {...Object.fromEntries(affineBatchPins.map(k=>[k,h])),...context,schema:'affine-batch-receipt/v1',taskId:'task',profileDigest:h,requestSha256:h,environmentDigest:h,candidateDigest:other,comparisonDigest:h,artifactSha256:h,artifactSize:3,elapsedSeconds:1,jobExpiresAt:expires,stage:'batch_comparison_completed',device:'cuda',optimizerSteps:1,trainingUpdated:true,finiteGradient:true,masterChanged:true,pgTokens:3225,supportOutsideTokens:0,actualDrawn:507,trainingResultAt:1000.5,actualTrainingEndedAt:1000.5,decision:'red',reasons:['insufficient evidence'],gain:-0.00001,z:null,se:null,barZ:1-.75*.5/43200,liveParity:false,officialAcceptance:false,chainSubmission:false,nativeRewardVerified:false};
const result = {schema:'affine-batch-result/v1',receiptArtifactId:'receipt',resultArtifactId:'archive',assurance:'signed-native-mimo-batch-comparison',receipt};
const canonical = v=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])));

test('hosted batch wire matches exact request/profile/configuration and finite fractional receipt',()=>{
 assert.deepEqual(parseAffineBatchPrepared(prepared),prepared); assert.deepEqual(parseAffineBatchResult(result),result);parseAffineBatchProfile(profile);
 for(const bad of [{...request,extra:true},{...request,maxHours:0},{...request,maxCostMicroUsd:1.5},{...request,jobDigest:'x'}])assert.throws(()=>parseAffineBatchRequest(bad));
 for(const bad of [{...prepared,mode:'service-credits'},{...prepared,configuration:{...config,optimization:{method:'affine_batch',maxSteps:50}}},{...prepared,configuration:{...config,affineBatchRequest:{...request,maxCostMicroUsd:1}}}])assert.throws(()=>parseAffineBatchPrepared(bad));
 for(const bad of [{...receipt,se:-1},{...receipt,z:Infinity},{...receipt,gain:NaN},{...receipt,actualTrainingEndedAt:1001},{...receipt,barZ:1},{...receipt,officialAcceptance:true},{...receipt,extra:true},{...receipt,masterMode:'provided'}])assert.throws(()=>parseAffineBatchReceipt(bad));
 assert.throws(()=>parseAffineBatchResult({...result,resultArtifactId:'receipt'}));
 for (const invalid of [undefined, null, false, 0, 1234567890123456, '']) assert.throws(() => d.saveDraft(prepared, 'Example', invalid));
});

test('prepare is scoped, metadata upload is one line, saved draft retains one step and two scoped keys',async()=>{
 const seen=[];const transport=createAffinePilotTransport({apiKey:'training-key',resourcesApiKey:'resources-key',fetch:async(url,init)=>{
  seen.push({url:String(url),init});const path=new URL(url).pathname;
  const v=path.endsWith('/prepare')?prepared:path.endsWith('/files')?{file:{id:'dataset'}}:{resource:{id:'draft',revision:1,kind:'training',name:'Example',config}};
  return new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json'}});
 }});const client=createAffineBatchClient(transport.request);
 await client.prepare({profileDigest:h,maxHours:2,maxCostMicroUsd:25000000});await client.uploadRequest(request,'batch.jsonl',true);await client.saveDraft(prepared,'Example','stable-draft-key-123');
 assert.equal(new URL(seen[0].url).pathname,'/api/v1/training/affine-batch/prepare');assert.equal(seen[1].init.headers.get('X-Dataset-Format'),'affine_batch_request');assert.equal(seen[1].init.body,JSON.stringify(request)+'\n');assert.equal(seen[2].init.headers.get('Authorization'),'Bearer resources-key');assert.equal(JSON.parse(seen[2].init.body).config.optimization.maxSteps,1);assert.equal(seen[2].init.headers.get('Idempotency-Key'),'stable-draft-key-123');
 assert.throws(()=>d.start({draftId:'draft',revision:1,datasetId:'dataset',approveExecution:false},'stable-start-key-123'));await assert.rejects(transport.request('/api/admin/anything',{method:'POST'}),e=>e.code==='invalid_route');
});

test('mutation mismatch is unknown, original key retained; known local refusals and no retries',async()=>{
 let calls=0;const client=createAffineBatchClient(async()=>{calls++;return {...prepared,request:{...request,maxHours:1}};});await assert.rejects(client.prepare({profileDigest:h,maxHours:2,maxCostMicroUsd:25000000}),e=>e.code==='outcome_unknown');assert.equal(calls,1);
 const expired=createAffineBatchClient(async()=>({...prepared,request:{...request,jobExpiresAt:1},configuration:{...config,affineBatchRequest:{...request,jobExpiresAt:1}}}));await assert.rejects(expired.prepare({profileDigest:h,maxHours:2,maxCostMicroUsd:25000000}),e=>e.code==='outcome_unknown');
 const saved=createAffineBatchClient(async()=>({resource:{id:'draft',revision:1,kind:'training',name:'Wrong'}}));await assert.rejects(saved.saveDraft(prepared,'Example','original-key-12345'),e=>e.code==='outcome_unknown'&&e.retryKey==='original-key-12345');
 const changed=createAffineBatchClient(async()=>({resource:{id:'draft',revision:1,kind:'training',name:'Example',config:{...config,compute:{...config.compute,maxHours:1}}}}));await assert.rejects(changed.saveDraft(prepared,'Example','original-key-12345'),e=>e.code==='outcome_unknown'&&e.retryKey==='original-key-12345');
 const refused=createAffineBatchClient(async()=>{throw new GenerationApiError('credential_required');});await assert.rejects(refused.prepare({profileDigest:h,maxHours:2,maxCostMicroUsd:25000000}),e=>e.code==='credential_required');
});

test('Node example verifies signature and retained profile/request/archive bindings including null metrics',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');const key=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');const pins={profileDigest:h,environmentDigest:h,requestSha256:h,affineBatch:{...profile,receiptPublicKey:key}};
 const envelope={payload:receipt,signer:key,signature:sign(null,Buffer.from(canonical(receipt)),privateKey).toString('base64')};const detail={task:{id:'task',status:'succeeded'},result};const archive={sha256:h,size:3};
 assert.equal(verifyAffineBatchReceipt(envelope,pins,request,detail,archive).integrityVerified,true);
 const historicalReceipt={...receipt,jobExpiresAt:1001};const historicalRequest={...request,jobExpiresAt:1001};const historicalPins={...pins,affineBatch:{...pins.affineBatch,jobExpiresAt:1001}};const historicalEnvelope={payload:historicalReceipt,signer:key,signature:sign(null,Buffer.from(canonical(historicalReceipt)),privateKey).toString('base64')};
 assert.equal(verifyAffineBatchReceipt(historicalEnvelope,historicalPins,historicalRequest,{...detail,result:{...result,receipt:historicalReceipt}},archive).integrityVerified,true,'Historical signed delivery remains verifiable after profile expiry');
 assert.throws(()=>verifyAffineBatchReceipt({...envelope,signature:'A'.repeat(86)+'=='},pins,request,detail,archive));assert.throws(()=>verifyAffineBatchReceipt(envelope,{...pins,requestSha256:other},request,detail,archive));assert.throws(()=>verifyAffineBatchReceipt(envelope,{...pins,affineBatch:{...pins.affineBatch,seed:43}},request,detail,archive));assert.throws(()=>verifyAffineBatchReceipt(envelope,pins,request,detail,{sha256:other,size:3}));
});


test('fixed comparison rule extends receipts without changing historical formula or flags',()=>{
 const fixed={...receipt,comparisonClockRule:'fixed-z-1-public-prior-v1',barZ:1};
 assert.deepEqual(parseAffineBatchReceipt(fixed),fixed);parseAffineBatchProfile({...profile,comparisonClockRule:fixed.comparisonClockRule});
 for(const bad of [{...fixed,barZ:receipt.barZ},{...fixed,comparisonClockRule:'unknown'},{...fixed,nativeRewardVerified:true}])assert.throws(()=>parseAffineBatchReceipt(bad));
 assert.deepEqual(parseAffineBatchReceipt(receipt),receipt);
});
