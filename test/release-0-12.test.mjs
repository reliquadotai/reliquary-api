import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  FILE_GRADERS, OFFICIAL_SKILLS, DEVELOPER_PREVIEW, assertGenerationQuoteMatches, batchFileRequests, parseBatchFile,
  parseBatchFileList, parseBatchQuote, parseEvaluationCatalog, parseEvaluationOrder, parseEvaluationQuote,
  parseFileEvaluation, parseFileQuoteInput, parseGenerationCatalog, parseGenerationOrderResponse, parseGenerationQuoteInput,
  parseGenerationResponse, parseProductInventory, createGenerationClient, parseEvaluationQuoteInput,
  assertEvaluationQuoteMatches, parseEvaluationSummary, SKILL_STATES, skillProductOpen,
} from '../dist/index.js';
import { createValidator } from './schema-validator.mjs';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const pkg = await json('../package.json');
const contracts = {
  generation: await json('../contracts/generation.openapi.json'),
  evaluations: await json('../contracts/evaluations.openapi.json'),
  openai: await json('../contracts/openai-batch.openapi.json'),
};
const production = await json('./fixtures/production-2026-11-09.json');
const validators = Object.fromEntries(Object.entries(contracts).map(([name, spec]) => [name, createValidator(spec)]));
const valid = (contract, schema, value) => assert.deepEqual(validators[contract].errors(schema, value), [], `${contract} ${typeof schema === 'string' ? schema : 'schema'}`);
const invalid = (contract, schema, value) => assert.notDeepEqual(validators[contract].errors(schema, value), [], `${contract} ${schema} should refuse`);
const example = (contract, name) => structuredClone(contracts[contract].components.examples[name].value);
const REVISION = 'b968826d9c46dd6066d109eabc6255188de91218';

test('every published example validates against the schema of each operation that uses it', () => {
  for (const [name, spec] of Object.entries(contracts)) {
    const { errors, resolve } = validators[name];
    let checked = 0;
    const check = (media, label) => {
      for (const [key, entry] of Object.entries(media.examples ?? {})) {
        const value = entry.$ref ? resolve(entry.$ref).value : entry.value;
        assert.deepEqual(errors(media.schema, value), [], `${name} ${label} example ${key}`);
        checked++;
      }
      if (media.example !== undefined) { assert.deepEqual(errors(media.schema, media.example), [], `${name} ${label} example`); checked++; }
    };
    for (const [path, methods] of Object.entries(spec.paths))
      for (const [method, operation] of Object.entries(methods)) {
        for (const media of Object.values(operation.requestBody?.content ?? {})) check(media, `${method} ${path} request`);
        for (const [status, response] of Object.entries(operation.responses))
          for (const media of Object.values(response.content ?? {})) if (media.schema) check(media, `${method} ${path} ${status}`);
      }
    assert.ok(checked > 3, `${name} has validated examples`);
  }
});

test('contract versions and package exports describe release 0.12.0', () => {
  assert.equal(pkg.version, '0.12.0');
  assert.equal(DEVELOPER_PREVIEW.version, '0.12.0');
  assert.equal(DEVELOPER_PREVIEW.releaseManifest, '/releases/0.12.0.json');
  assert.equal(contracts.generation.info.version, '0.3.0');
  assert.equal(contracts.evaluations.info.version, '0.2.0');
  assert.equal(contracts.openai.info.version, '0.1.0');
  assert.equal(pkg.exports['./openai-batch/openapi'], './contracts/openai-batch.openapi.json');
  assert.ok(pkg.files.includes('contracts'));
});

test('production catalogs validate against the contracts and keep architectures', () => {
  const live = production.generationCatalog;
  valid('generation', 'GenerationCatalog', live);
  const catalog = parseGenerationCatalog(live);
  assert.deepEqual(catalog.architectures, ['Qwen3ForCausalLM', 'Qwen3_5ForCausalLM', 'Qwen3_5ForConditionalGeneration']);
  assert.deepEqual(catalog, live);
  assert.equal(parseGenerationCatalog({ ...live, architectures: null }).architectures, null);
  assert.ok(!Object.hasOwn(parseGenerationCatalog({ ordering: 'disabled', any_model_ordering: 'disabled', envs: [], models: [] }), 'architectures'));
  for (const architectures of [['Qwen3ForCausalLM', 'Qwen3ForCausalLM'], ['bad name'], 'Qwen3ForCausalLM', [1]])
    assert.throws(() => parseGenerationCatalog({ ...live, architectures }));
  invalid('generation', 'GenerationCatalog', { ...live, architectures: ['bad name'] });
  const { architectures: _omitted, ...withoutList } = live;
  invalid('generation', 'GenerationCatalog', withoutList);
  assert.deepEqual(parseGenerationResponse('catalog', live).architectures, live.architectures);
  const inventory = parseProductInventory({ schemaVersion: 1, revision: 'r1', fetchedAt: '2026-11-09T00:00:00Z', sources: [], objects: [], generation: live });
  assert.deepEqual(inventory.generation.architectures, live.architectures);

  valid('evaluations', 'Catalog', production.evaluationCatalog);
  const evaluations = parseEvaluationCatalog(production.evaluationCatalog);
  assert.ok(evaluations.envs.some(env => env.sets.some(set => set.set_id === 'verifiers-aime25-r0-n30')));
});

test('file quotes take an optional grader and keep the production quote fields', () => {
  assert.deepEqual([...FILE_GRADERS], ['boxed_math_v1', 'exact_match_v1']);
  const input = example('generation', 'fileEvaluationQuoteInput');
  assert.deepEqual(parseFileQuoteInput(input), input);
  assert.deepEqual(parseGenerationQuoteInput(input), input);
  for (const grader of ['BOXED_MATH_V1', 'judge', '', null]) assert.throws(() => parseFileQuoteInput({ ...input, grader }));
  invalid('generation', 'FileQuoteInput', { ...input, grader: 'judge' });
  assert.ok(contracts.generation.components.schemas.FileQuoteInput.properties.grader);

  const evaluation = parseBatchQuote(example('generation', 'fileEvaluationQuote'));
  assert.equal(evaluation.purpose, 'eval');
  assert.equal(evaluation.grader, 'boxed_math_v1');
  assert.equal(evaluation.pricing.grading_fee_usd, 1);
  assert.equal(evaluation.architecture, 'Qwen3ForCausalLM');
  assert.equal(evaluation.gpu_count, 1);
  assert.equal(evaluation.thinking, false);
  assert.equal(evaluation.verification, 'draw');
  assert.equal(evaluation.seed, 7);
  assertGenerationQuoteMatches(evaluation, input);
  parseGenerationResponse('quote', example('generation', 'fileEvaluationQuote'), 'key', { input });

  const batch = parseBatchQuote(example('generation', 'fileQuote'));
  assert.equal(batch.purpose, undefined);
  assert.equal(batch.grader, undefined);
  assert.equal(batch.architecture, 'Qwen3ForCausalLM');
  // The grader is part of the reviewed configuration.
  assert.throws(() => assertGenerationQuoteMatches(evaluation, { ...input, grader: 'exact_match_v1' }));
  const { grader: _grader, ...plain } = input;
  assert.throws(() => assertGenerationQuoteMatches(evaluation, plain));
  assert.throws(() => assertGenerationQuoteMatches(batch, { ...input, input_file_id: batch.input_file_id, revision: batch.revision, model: batch.model }));

  const quote = example('generation', 'fileEvaluationQuote');
  for (const broken of [
    { ...quote, grader: 'judge' },
    { ...quote, purpose: 'eval', grader: undefined },
    { ...quote, purpose: undefined },
    { ...quote, pricing: { mode: 'any_model' } },
    { ...quote, gpu_count: 0 },
    { ...quote, verification: 'unknown' },
    { ...quote, seed: -1 },
  ]) assert.throws(() => parseBatchQuote(JSON.parse(JSON.stringify(broken))));
  const { purpose: _p, ...withoutPurpose } = quote;
  invalid('generation', 'FileQuote', withoutPurpose);
  invalid('generation', 'FileQuote', { ...quote, unknown_field: true });
});

test('file evaluation orders expose order.evaluation as recorded in production', () => {
  const projection = production.fileEvaluationOrderProjection;
  valid('generation', 'FileEvaluation', projection.evaluation);
  for (const delivery of projection.deliveries) valid('generation', 'KeyDelivery', delivery);
  const evaluation = parseFileEvaluation(projection.evaluation);
  assert.equal(evaluation.status, 'graded');
  assert.equal(evaluation.summary.envs.boxed_math_v1['pass@1'].value, 0.5);
  assert.deepEqual(evaluation.summary.macro, { 'pass@1': 0.5, 'pass@k': { 1: 0.5 } });

  // The remaining fields as worker/dataset-any.ts anyOrderPayload writes them for a file order.
  const id = projection.deliveries[0].delivery_id.slice(3);
  const order = {
    id, model: 'Qwen/Qwen3-8B', revision: REVISION, input_file_id: production.openaiEvaluationFile.id, output_format: 'openai_jsonl',
    verification: 'draw', seed: 7, gpu_count: 1, prompt_count: 2, samples_per_prompt: 1, max_new_tokens: 64, thinking: false,
    sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, max_tokens: 64, seed: 7, n: 1 }, cancel_requested: false,
    needs_attention: false, progress: null, created_at: '2026-11-09T11:43:31.000Z', updated_at: '2026-11-09T11:55:51.000Z',
    finished_at: '2026-11-09T11:55:51.000Z', purpose: 'eval', ...projection,
  };
  valid('generation', 'KeyOrderResponse', { order });
  const parsed = parseGenerationOrderResponse({ order });
  assert.equal(parsed.purpose, 'eval');
  assert.deepEqual(parsed.evaluation, evaluation);
  assert.equal(parsed.gpu_count, 1);
  assert.equal(parsed.verification, 'draw');
  assert.equal(parsed.seed, 7);
  assert.deepEqual(parsed.deliveries.map(d => d.delivery_id), [`dl-${id}`, 'evaluation']);
  assert.deepEqual(parsed.deliveries[1].files.map(f => f.name), ['graded.parquet', 'manifest.json', 'report.json']);
  valid('generation', 'KeyOrderResponse', example('generation', 'keyFileEvaluationOrder'));
  assert.equal(parseGenerationOrderResponse(example('generation', 'keyFileEvaluationOrder')).evaluation.grader, 'boxed_math_v1');

  for (const status of ['pending', 'ungraded']) {
    const pending = parseFileEvaluation({ grader: 'exact_match_v1', status, complete: null, summary: null });
    assert.equal(pending.summary, null);
    valid('generation', 'FileEvaluation', pending);
  }
  for (const broken of [
    { ...projection.evaluation, summary: null },
    { ...projection.evaluation, status: 'pending' },
    { ...projection.evaluation, grader: 'judge' },
    { ...projection.evaluation, complete: 'yes' },
    { ...projection.evaluation, summary: { ...projection.evaluation.summary, macro: null } },
  ]) assert.throws(() => parseFileEvaluation(broken));
  assert.throws(() => parseGenerationOrderResponse({ order: { ...order, evaluation: undefined } }));
  assert.throws(() => parseGenerationOrderResponse({ order: { ...order, purpose: undefined } }));
  const { purpose: _purpose, evaluation: _evaluation, ...batchOrder } = order;
  assert.ok(!Object.hasOwn(parseGenerationOrderResponse({ order: batchOrder }), 'evaluation'));
});

test('batch files carry their sha256 once processed and the list names its object', async () => {
  const processed = example('generation', 'batchFileProcessed');
  assert.equal(parseBatchFile(processed).sha256, processed.sha256);
  assert.equal(parseBatchFile({ ...processed, sha256: null }).sha256, null);
  assert.ok(!Object.hasOwn(parseBatchFile(example('generation', 'batchFile')), 'sha256'));
  for (const sha256 of ['ABC', 'a'.repeat(63), 7]) assert.throws(() => parseBatchFile({ ...processed, sha256 }));
  assert.throws(() => parseBatchFile({ ...example('generation', 'batchFile'), sha256: 'a'.repeat(64) }));
  // The native route answers in ISO time; the same file on the OpenAI route uses unix seconds.
  const native = { ...production.openaiEvaluationFile, created_at: new Date(production.openaiEvaluationFile.created_at * 1000).toISOString() };
  valid('generation', 'BatchFile', native);
  assert.deepEqual(parseBatchFile(native), native);
  const list = parseBatchFileList({ object: 'list', data: [native] });
  assert.equal(list.object, 'list');
  assert.equal(parseBatchFileList({ data: [native] }).object, 'list');
  assert.throws(() => parseBatchFileList({ object: 'batch', data: [] }));
  valid('generation', 'BatchFileList', { object: 'list', data: [native] });
  invalid('generation', 'BatchFileList', { data: [native] });
  assert.equal(batchFileRequests().get(native.id).path, `/api/v1/files/${native.id}`);
});

test('OpenAI-compatible Batch contract matches recorded production objects', () => {
  const spec = contracts.openai;
  assert.deepEqual(Object.keys(spec.paths).sort(), [
    '/api/openai/v1/batches', '/api/openai/v1/batches/{batch_id}', '/api/openai/v1/batches/{batch_id}/cancel',
    '/api/openai/v1/files', '/api/openai/v1/files/{file_id}', '/api/openai/v1/files/{file_id}/content',
  ]);
  for (const [path, methods] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(methods)) {
      assert.deepEqual(operation.security, [{ workspaceKey: [] }], `${method} ${path}`);
      assert.equal(operation['x-required-api-key-scope'], 'orders:write');
      assert.ok(operation.responses['401'] && operation.responses['500']);
      for (const [status, response] of Object.entries(operation.responses))
        if (Number(status) >= 400) assert.equal(response.content['application/json'].schema.$ref, '#/components/schemas/Error');
    }
  assert.ok(spec.paths['/api/openai/v1/files'].post.requestBody.content['multipart/form-data']);
  assert.ok(spec.paths['/api/openai/v1/batches'].post.parameters.some(p => p.name === 'Idempotency-Key' && !p.required));
  for (const name of ['openaiFile', 'openaiEvaluationFile']) valid('openai', 'File', production[name]);
  for (const name of ['openaiBatchCreated', 'openaiBatchCompleted', 'openaiEvaluationBatchCreated']) valid('openai', 'Batch', production[name]);
  assert.equal(production.openaiEvaluationBatchCreated.metadata.reliquary_grader, 'boxed_math_v1');
  invalid('openai', 'Batch', { ...production.openaiBatchCompleted, status: 'done' });
  invalid('openai', 'Batch', { ...production.openaiBatchCompleted, usage: null });
  invalid('openai', 'CreateBatch', { input_file_id: production.openaiFile.id, endpoint: '/v1/embeddings', completion_window: '24h' });
  invalid('openai', 'CreateBatch', { input_file_id: production.openaiFile.id, endpoint: '/v1/chat/completions', completion_window: '24h', metadata: { reliquary_grader: 'judge' } });
  valid('openai', 'Error', { error: { message: 'No such batch.', type: 'not_found_error', param: null, code: 'batch_not_found' } });
  valid('openai', 'RequestLine', { custom_id: 'm1', method: 'POST', url: '/v1/chat/completions', body: { model: 'Qwen/Qwen3-8B', messages: [] }, reference: '56' });
  invalid('openai', 'RequestLine', { custom_id: 'm1', method: 'POST', url: '/v1/chat/completions', body: {}, reference: '' });
});

test('evaluation quotes and orders keep the forced-draw verification', () => {
  const quote = parseEvaluationQuote(example('evaluations', 'subnetQuote'));
  assert.equal(quote.verification, 'draw');
  assert.ok(!Object.hasOwn(parseEvaluationQuote(example('evaluations', 'quote')), 'verification'));
  assert.throws(() => parseEvaluationQuote({ ...example('evaluations', 'subnetQuote'), verification: 'qualified' }));
  valid('evaluations', 'Quote', example('evaluations', 'subnetQuote'));
  invalid('evaluations', 'Quote', { ...example('evaluations', 'subnetQuote'), verification: 'other' });
  const order = example('evaluations', 'order');
  order.evaluation.verification = 'draw';
  assert.equal(parseEvaluationOrder(order).verification, 'draw');
  const evaluation = order.evaluation;
  valid('evaluations', 'Order', evaluation);
});

test('catalog environment ids with a colon parse in quotes, orders and summaries', () => {
  const input = example('evaluations', 'subnetQuoteInput');
  assert.equal(input.envs[0].env, 'verifiers:aime25');
  assert.deepEqual(parseEvaluationQuoteInput(input), input);
  valid('evaluations', 'QuoteInput', input);
  assertEvaluationQuoteMatches(parseEvaluationQuote(example('evaluations', 'subnetQuote')), input);
  for (const env of ['verifiers:aime25', 'verifiers:mmlu-pro']) assert.equal(parseEvaluationQuoteInput({ ...input, envs: [{ ...input.envs[0], env }] }).envs[0].env, env);
  for (const env of [':aime', 'a/b', 'a b', 'x'.repeat(65)]) assert.throws(() => parseEvaluationQuoteInput({ ...input, envs: [{ ...input.envs[0], env }] }));
  const order = example('evaluations', 'order');
  const metrics = order.evaluation.summary.envs.test;
  order.evaluation.envs = [{ env: 'verifiers:aime25', set_id: 'fixed-set', problems: 2, samples: 2 }];
  order.evaluation.summary.envs = { 'verifiers:aime25': metrics };
  assert.ok(parseEvaluationOrder(order).summary.envs['verifiers:aime25']);
  assert.ok(parseEvaluationSummary({ complete: true, envs: { 'verifiers:aime25': metrics }, macro: { 'pass@1': 0.5, 'pass@k': {} } }));
});

test('the generation client sends the grader and checks it on the returned quote', async () => {
  const input = example('generation', 'fileEvaluationQuoteInput');
  const sent = [];
  const client = createGenerationClient(async (path, init) => { sent.push({ path, body: JSON.parse(init.body) }); return example('generation', 'fileEvaluationQuote'); });
  const quote = await client.quote(input);
  assert.deepEqual(sent, [{ path: '/api/v1/dataset-orders/quotes', body: input }]);
  assert.equal(quote.grader, 'boxed_math_v1');
  const wrong = createGenerationClient(async () => ({ ...example('generation', 'fileEvaluationQuote'), grader: 'exact_match_v1' }));
  await assert.rejects(wrong.quote(input), /quoted configuration changed/);
});

test('release skills cover evaluations on a file and the discovery questions', async () => {
  assert.equal(OFFICIAL_SKILLS.length, 45);
  assert.ok(OFFICIAL_SKILLS.every(skill => skill.version === '0.12.0'));
  assert.equal(new Set(OFFICIAL_SKILLS.map(skill => skill.docs)).size, OFFICIAL_SKILLS.length);
  const skill = id => OFFICIAL_SKILLS.find(item => item.id === id);
  const file = skill('reliquary-evaluation-file');
  assert.ok(file);
  assert.equal(file.category, 'evaluation');
  assert.equal(file.access, 'approval-required');
  assert.deepEqual(file.requiredScopes, ['orders']);
  assert.equal(file.docs, '/docs/agents/evaluation-file');
  assert.equal(file.reference, '/docs/api-reference/file-evaluations');
  assert.match(file.description, /^Evaluate a model on your own questions with reference answers/);
  for (const tool of ['reliquary_batch_upload', 'reliquary_batch_quote', 'reliquary_batch_order', 'reliquary_generation_order_get', 'reliquary_batch_files'])
    assert.ok(file.mcpTools.includes(tool), tool);
  const text = file.guidance.join('\n');
  for (const needle of ['reference', 'boxed_math_v1', 'exact_match_v1', 'approveExecution:true', 'idempotencyKey', 'grading_fee_usd', 'order.evaluation', 'delivery evaluation', 'https://app.reliqua.ai/api/openai/v1'])
    assert.ok(text.includes(needle), needle);
  const instructions = await readFile(new URL('../skills/reliquary-evaluation-file/SKILL.md', import.meta.url), 'utf8');
  assert.match(instructions, /^---\nname: reliquary-evaluation-file\ndescription: "Evaluate a model on your own questions with reference answers/);
  assert.match(instructions, /\n## Interfaces and limits\n/);
  assert.match(instructions, /\nReference: https:\/\/app\.reliqua\.ai\/docs\/api-reference\/file-evaluations\n/);
  assert.match(instructions, /\nWorkflow page: https:\/\/app\.reliqua\.ai\/docs\/agents\/evaluation-file\n/);
  assert.match(instructions, /Order only after the user approves that exact unexpired quote/);
  assert.match(instructions, /last \\boxed\{\}/);

  const batch = skill('reliquary-batch-files');
  assert.equal(batch.reference, '/docs/api-reference/batch');
  assert.match(batch.guidance.join('\n'), /official OpenAI SDK .* base_url https:\/\/app\.reliqua\.ai\/api\/openai\/v1/);
  assert.match(batch.guidance.join('\n'), /reliquary-evaluation-file/);
  assert.match(await readFile(new URL('../skills/reliquary-batch-files/SKILL.md', import.meta.url), 'utf8'), /\nReference: https:\/\/app\.reliqua\.ai\/docs\/api-reference\/batch\n/);
  assert.match(skill('reliquary-evaluation-discover').guidance.join('\n'), /reliquary-evaluation-file/);
  for (const id of ['reliquary-generation-discover', 'reliquary-evaluation-discover', 'reliquary-batch-files'])
    assert.match(skill(id).guidance.join('\n'), /architectures/, id);
  assert.match(skill('reliquary-batch-download').guidance.join('\n'), /delivery evaluation/);

  // Skills describe workflows, never how an account is admitted or funded.
  for (const item of OFFICIAL_SKILLS) {
    const content = await readFile(new URL(`../skills/${item.id}/SKILL.md`, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /approved (?:pilot )?accounts?|account approval|request access|grant(?:s|ed)? credits|credits? (?:are|is) granted|manually (?:approve|credit)|onboarding|top up/i, item.id);
  }
});

test('workflows whose product is not open yet are marked and say what to use instead', async () => {
  const closed = ['reliquary-generation-quote', 'reliquary-generation-order',
    ...['readiness', 'datasets', 'import', 'draft', 'quote', 'start', 'progress', 'artifacts', 'cancel', 'dataset-lifecycle'].map(s => 'reliquary-training-' + s),
    ...['readiness', 'validate', 'progress', 'report', 'control'].map(s => 'reliquary-cpu-' + s),
    'reliquary-affine-pilot', 'reliquary-affine-batches'];
  assert.deepEqual(OFFICIAL_SKILLS.filter(skill => skill.state === 'not-yet-available').map(skill => skill.id).sort(), [...closed].sort());
  assert.deepEqual([...SKILL_STATES], ['available', 'qualified-pilot', 'gated', 'not-yet-available']);
  for (const skill of OFFICIAL_SKILLS) {
    assert.ok(SKILL_STATES.includes(skill.state), skill.id);
    assert.equal(skillProductOpen(skill), !closed.includes(skill.id));
    const content = await readFile(new URL(`../skills/${skill.id}/SKILL.md`, import.meta.url), 'utf8');
    if (closed.includes(skill.id)) {
      assert.match(skill.availability, /^Not yet available: /);
      assert.ok(content.startsWith(`---\nname: ${skill.id}\n`));
      assert.equal(content.split('\n')[7], `> ${skill.availability}`, skill.id);
      assert.ok(skill.guidance.every(step => content.includes(step)), `${skill.id} keeps its instructions`);
      assert.match(content, /\nSupport: not-yet-available\. /);
    } else {
      assert.equal(skill.availability, undefined, skill.id);
      assert.doesNotMatch(content, /Not yet available/);
    }
  }
  for (const id of ['reliquary-generation-quote', 'reliquary-generation-order'])
    assert.match(OFFICIAL_SKILLS.find(skill => skill.id === id).availability, /reliquary-batch-files/);
  for (const id of ['reliquary-batch-files', 'reliquary-batch-download', 'reliquary-evaluation-file', 'reliquary-evaluation-quote', 'reliquary-generation-track', 'reliquary-generation-delivery', 'reliquary-generation-cancel', 'reliquary-credits', 'reliquary-compute'])
    assert.ok(skillProductOpen(OFFICIAL_SKILLS.find(skill => skill.id === id)), id);
  const compute = OFFICIAL_SKILLS.find(skill => skill.id === 'reliquary-compute').guidance.join('\n');
  assert.match(compute, /Managed rentals are not available yet: this workflow compares offers only/);
});
