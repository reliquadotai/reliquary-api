import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { affinePilotRequests as d, createAffinePilotClient, createAffinePilotTransport, parseAffineEvaluationPrepared, parseAffineEvaluationRequest, parseNativePreparationCatalog, GenerationApiError, OFFICIAL_SKILLS } from '../dist/index.js';
import { affinePilotStage, downloadVerifiedArtifact, verifyAffineReceipt } from '../examples/affine-pilot.mjs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
const h = 'a'.repeat(64), requestId = '12345678-1234-4234-8234-123456789abc';
const request = { schema: 'affine-native-evaluation-request/v1', profileDigest: h, jobDigest: h, maxHours: 1, maxCostMicroUsd: 5100000, nativeJobExpiresAt: 2000000000 };
const prepared = { request, configuration: { profileDigest: h, affineNativeEvaluationRequest: request, optimization: {method:'affine_native_evaluation'},compute:{maxHours:1},submissionMode:'operator_funded_pilot' }, mode: 'operator-funded-pilot' };
const review = { repository: 'example/model', reference: 'main', sessionId: 'session', maxCostMicroUsd: 5100000 };
const reviewed = { sessionId:'session', repository:'example/model',revision:'b'.repeat(40),weightBytes:100,architecture:'Qwen3_5ForConditionalGeneration',policyId:'mimo-diagnostic4-v1',policyDigest:h,maxSeconds:900,maxCostMicroUsd:5100000,expiresAt:2000000000 };
const prep = { ...reviewed,id:'prep',state:'ready',profileDigest:h,runId:null,error:null,createdAt:1,updatedAt:2 };
const confirm = { repository:review.repository,revision:reviewed.revision,sessionId:'session',maxCostMicroUsd:5100000,policyDigest:h,approvePreparation:true,requestId };
const hash = b => createHash('sha256').update(b).digest('hex');

test('fixed descriptors validate approvals, exact fields and upload bytes', () => {
  assert.equal(d.capabilities().path, '/api/v1/training/capabilities');
  assert.equal(d.review(review).path, '/api/v1/training/affine-native-evaluation/preparations/review');
  assert.equal(JSON.parse(d.prepare(confirm).init.body).requestId, requestId);
  assert.equal(d.uploadRequest(request,'request.jsonl',true).init.body,JSON.stringify(request)+'\n');
  assert.equal(new Headers(d.uploadRequest(request,'request.jsonl',true).init.headers).get('X-Dataset-Format'),'affine_native_evaluation_request');
  for (const v of [{...review,reference:'../main'},{...review,maxCostMicroUsd:5100001},{...review,repository:'https://evil.test/model'},{...review,token:'secret'}]) assert.throws(()=>d.review(v));
  assert.throws(()=>d.prepare({...confirm,approvePreparation:false}));
  assert.throws(()=>d.prepare({...confirm,requestId:'invalid'}));
  assert.throws(()=>d.uploadRequest(request,'request.jsonl',false));
  assert.throws(()=>d.start({draftId:'draft',revision:1,datasetId:'data',approveExecution:false},requestId));
  assert.throws(()=>d.artifact('task','artifact',{offset:0,maxBytes:262145}));
  assert.throws(()=>parseAffineEvaluationRequest({...request,other:true}));
  assert.throws(()=>parseAffineEvaluationPrepared({...prepared,configuration:{...prepared.configuration,profileDigest:'b'.repeat(64)}}));
  assert.deepEqual(parseNativePreparationCatalog({available:false,reason:'offline',sessionId:null,windowEndsAt:null,preparations:[]}).reason,'offline');
  for (const invalid of [undefined, null, false, 0, 1234567890123456, '']) {
    assert.throws(() => d.task(invalid));
    assert.throws(() => d.start({ draftId: 'draft', revision: 1, datasetId: 'data', approveExecution: true }, invalid));
    assert.throws(() => d.saveDraft(prepared, 'Diagnostic', invalid));
  }
});

test('authenticated capabilities is a fixed read that preserves unavailable state', async () => {
  let calls = 0;
  const response = { training: false, mode: 'operator-funded-pilot', profiles: [], reason: 'window_closed' };
  const transport = createAffinePilotTransport({ apiKey: 'key', fetch: async (url, init) => {
    calls++; assert.equal(new URL(url).pathname, '/api/v1/training/capabilities');
    assert.equal(init.method, 'GET'); assert.equal(init.headers.get('Authorization'), 'Bearer key');
    return Response.json(response);
  } });
  assert.deepEqual(await createAffinePilotClient(transport.request).capabilities(), response);
  await assert.rejects(transport.request('/api/v1/training/capabilities', { method: 'POST' }), e => e.code === 'invalid_route');
  assert.equal(calls, 1);
  await assert.rejects(createAffinePilotClient(async () => ({ training: true })).capabilities(), /Invalid training capabilities/);
  await assert.rejects(createAffinePilotClient(async () => ({ ...response, affineBatch: { ready: true } })).capabilities(), /Invalid batch capabilities/);
});

test('full staged path uses real fetch shape and separate scoped credentials', async () => {
  const seen = [], outputs = [
    {available:true,reason:null,sessionId:'session',windowEndsAt:2000000000,preparations:[]},reviewed,prep,prep,prepared,{file:{id:'data'}},{resource:{id:'draft',revision:1,kind:'training',name:'Diagnostic'}},{quote:{id:'quote',draftId:'draft',revision:1,datasetId:'data',expiresAt:2000000000,maxCostMicroUsd:5100000}},{task:{id:'task',resourceId:'draft',resourceRevision:1,datasetId:'data'}},{task:{id:'task'}}
  ];
  const options={apiKey:'training-key',resourcesApiKey:'resources-key',fetch:async(url,init)=>{seen.push({url:String(url),...init});return Response.json(outputs.shift());}};
  const stages=[['status',{}],['review',review],['prepare',confirm],['preparation',{id:'prep'}],['evaluation-prepare',{profileDigest:h,maxHours:1,maxCostMicroUsd:5100000}],['upload',{request,filename:'request.jsonl',rightsConfirmed:true}],['save-draft',{prepared,name:'Diagnostic',requestKey:requestId}],['quote',{draftId:'draft',revision:1,datasetId:'data'}],['start',{submission:{draftId:'draft',revision:1,datasetId:'data',approveExecution:true,quoteId:'quote'},requestKey:requestId}],['task',{id:'task'}]];
  for (const [stage,input] of stages) await affinePilotStage(stage,input,options);
  assert.equal(seen.length,10); assert(seen.every(r=>r.redirect==='manual'&&r.credentials==='omit'));
  assert.equal(seen[6].headers.get('Authorization'),'Bearer resources-key');
  assert.equal(seen[8].headers.get('Authorization'),'Bearer training-key');
  assert.equal(seen[8].headers.get('Idempotency-Key'),requestId);
  const transport=createAffinePilotTransport({apiKey:'training-key',fetch:options.fetch});
  await assert.rejects(transport.request('/api/resources',d.saveDraft(prepared,'Diagnostic',requestId).init),e=>e.code==='credential_required');
  for (const path of ['/api/auth/login','/api/admin/tasks','https://evil.test/api/resources','/api/v1/training/tasks/task?x=y']) await assert.rejects(transport.request(path),e=>e.code==='invalid_route');
});

test('unknown mutations are single attempts, preserve key and diagnostics, and injected refusals stay definite', async () => {
  let count=0;
  const transport=createAffinePilotTransport({apiKey:'key',fetch:async()=>{count++;return new Response('',{status:503,headers:{'X-Request-Id':'request-one','Retry-After':'2'}});}});
  await assert.rejects(createAffinePilotClient(transport.request).prepare(confirm), e=>e instanceof GenerationApiError&&e.code==='outcome_unknown'&&e.retryKey===requestId&&e.requestId==='request-one'&&e.retryAfterSeconds===2);
  assert.equal(count,1);
  const refusal=Object.assign(new Error('refused'),{status:403});
  await assert.rejects(createAffinePilotClient(async()=>{throw refusal;}).prepare(confirm),e=>e===refusal);
  await assert.rejects(createAffinePilotClient(async()=>({wrong:true})).prepare(confirm),e=>e.code==='outcome_unknown'&&e.retryKey===requestId);
});

test('transport refuses redirects, bounds streaming bodies and verifies artifact ranges', async () => {
  let calls=0;
  const options={apiKey:'key',fetch:async()=>{calls++;return new Response('',{status:302,headers:{Location:'https://evil.test/'}});}};
  await assert.rejects(createAffinePilotTransport(options).request(d.status().path),e=>e.code==='redirect_refused');
  assert.equal(calls,1);
  const r=d.artifact('task','artifact',{offset:0,maxBytes:3});
  const good=createAffinePilotClient(createAffinePilotTransport({apiKey:'key',fetch:async()=>new Response('abc',{status:206,headers:{'Content-Range':'bytes 0-2/3'}})}).request);
  const whole=createAffinePilotClient(createAffinePilotTransport({apiKey:'key',fetch:async()=>new Response('abc')}).request);
  assert.equal((await whole.artifact('task','artifact',{offset:0,maxBytes:3})).length,3);
  await assert.rejects(whole.artifact('task','artifact',{offset:1,maxBytes:3}));
  assert.deepEqual(await good.artifact('task','artifact',{offset:0,maxBytes:3}),new TextEncoder().encode('abc'));
  for (const response of [()=>new Response('abc',{status:206,headers:{'Content-Range':'bytes 1-3/4'}}),()=>new Response('abcd',{status:206,headers:{'Content-Range':'bytes 0-3/4'}})]) {
    await assert.rejects(createAffinePilotTransport({apiKey:'key',fetch:async()=>response()}).request(r.path,r.init));
  }
  const payload=Buffer.from('abc'); const metadata={id:'artifact',sha256:hash(payload),size:3};
  await downloadVerifiedArtifact(good,'task',metadata,()=>{});
  await assert.rejects(downloadVerifiedArtifact(good,'task',{...metadata,sha256:'b'.repeat(64)},()=>{}));
});

test('OpenAPI and official skill cover the complete route without a session mutation',async()=>{
  const spec=JSON.parse(await readFile(new URL('../contracts/affine-pilot.openapi.json',import.meta.url)));
  assert.equal(spec.info.version,'0.8.0');
  assert.equal(Object.keys(spec.paths).length,11);
  assert(spec.paths['/api/v1/training/capabilities'].get);
  for(const path of ['/api/resources','/api/v1/training/files','/api/v1/training/quotes','/api/v1/training/tasks'])assert(spec.paths[path].post);
  assert.deepEqual(spec.components.schemas.PrepareInput.required.sort(),['repository','revision','sessionId','maxCostMicroUsd','policyDigest','approvePreparation','requestId'].sort());
  assert(!Object.keys(spec.paths).some(p=>/claim|session|window/.test(p)));
  const skill=OFFICIAL_SKILLS.find(s=>s.id==='reliquary-affine-pilot'); assert(skill&&!skill.interfaces.includes('cli'));assert.equal(skill.version,'0.11.2'); assert.equal(skill.mcpTools.filter(t=>t.startsWith('reliquary_affine_')).length,6);
  const uploadGuide=skill.guidance.find(step=>step.includes('affine_request_upload'));
  assert.match(uploadGuide,/For MCP, call affine_request_upload with only request and rightsConfirmed:true/);
  assert.match(uploadGuide,/For HTTP, choose a simple \.jsonl filename.*X-Filename/);
  assert((await readFile(new URL('../skills/reliquary-affine-pilot/SKILL.md',import.meta.url),'utf8')).includes(uploadGuide));
});

test('receipt verification binds independently retained pins and rejects altered archive or signature',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const pins={receiptPublicKey:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),requestSha256:h,sourceClosureDigest:h,runtimeDigest:h,inputInventoryDigest:h,checkpointInventoryDigest:h,environmentDigest:h,assurance:'native-mimo-evaluation'};
  const payload={schema:'affine-native-evaluation-receipt/v1',stage:'evaluation_completed',taskId:'task',...request,...pins,outputInventoryDigest:h,nativeResultDigest:h,artifactSha256:h,artifactSize:3,elapsedSeconds:1,nativeParityVerified:false,operatorAccepted:false,nativeRewardVerified:false,chainTransactions:false};
  payload.schema='affine-native-evaluation-receipt/v1';delete payload.receiptPublicKey;delete payload.maxHours;delete payload.maxCostMicroUsd;
  const canonical=JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a],[b])=>a.localeCompare(b))));
  const envelope={payload,signer:pins.receiptPublicKey,signature:sign(null,Buffer.from(canonical),privateKey).toString('base64')};
  const detail={task:{id:'task',status:'succeeded'},result:{schema:'affine-native-evaluation-result/v1',assurance:payload.assurance,receipt:payload}};
  assert.equal(verifyAffineReceipt(envelope,pins,request,detail,{sha256:h,size:3}).integrityVerified,true);
  assert.throws(()=>verifyAffineReceipt(envelope,pins,request,detail,{sha256:'b'.repeat(64),size:3}));
  assert.throws(()=>verifyAffineReceipt({...envelope,signature:'A'.repeat(86)+'=='},pins,request,detail,{sha256:h,size:3}));
});

test('mismatched responses and local credential refusals retain exact semantics', async () => {
  await assert.rejects(createAffinePilotClient(async()=>({...reviewed,sessionId:'other'})).review(review),e=>e.code==='outcome_unknown');
  await assert.rejects(createAffinePilotClient(async()=>({...prep,revision:'c'.repeat(40)})).prepare(confirm),e=>e.code==='outcome_unknown'&&e.retryKey===requestId);
  await assert.rejects(createAffinePilotClient(async()=>({...prepared,request:{...request,maxHours:2}})).evaluationPrepare({profileDigest:h,maxHours:1,maxCostMicroUsd:5100000}),e=>e.code==='outcome_unknown');
  const transport=createAffinePilotTransport({apiKey:'key',fetch:async()=>{throw new Error('must not dispatch');}});
  await assert.rejects(createAffinePilotClient(transport.request).saveDraft(prepared,'Diagnostic',requestId),e=>e.code==='credential_required');
});

test('generic workflow receipts bind quotes, draft and task identities', async () => {
  const input={draftId:'draft',revision:1,datasetId:'data'};
  await assert.rejects(createAffinePilotClient(async()=>({quote:{id:'quote',...input,datasetId:'other',expiresAt:2000000000,maxCostMicroUsd:1}})).quote(input),e=>e.code==='outcome_unknown');
  await assert.rejects(createAffinePilotClient(async()=>({task:{id:'task',resourceId:'other',resourceRevision:1,datasetId:'data'}})).start({...input,approveExecution:true},requestId),e=>e.code==='outcome_unknown'&&e.retryKey===requestId);
  await assert.rejects(createAffinePilotClient(async()=>({task:{id:'other'}})).task('task'));
});
