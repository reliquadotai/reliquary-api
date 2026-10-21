import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluationClient, createEvaluationTransport, parseEvaluationCatalog, parseEvaluationQuoteInput, parseEvaluationOrder, parseEvaluationReport, evaluationRequests, GenerationApiError, verifyEvaluationProtocol } from '../dist/index.js';
import { fixture, sha } from './evaluation-fixture.mjs';

test('evaluation DTOs preserve real counts, clocks and unknown diagnostics', () => {
  const f = fixture();
  parseEvaluationCatalog(f.catalog); parseEvaluationQuoteInput(f.input);
  const order = parseEvaluationOrder({ evaluation: f.order });
  const report = parseEvaluationReport(f.report, order);
  assert.equal(report.created_at, f.report.created_at);
  assert.equal(report.envs.test.n_problems_graded, 2);
  assert.equal(report.envs.test.graded_rows, 4);
  assert.equal(report.envs.test.mean_turns, null);
  assert.equal(report.envs.test.attempted_samples, null);
  assert.equal(report.envs.test.tool_calls_total, null);
  assert.deepEqual(report.envs.test['pass@k'], { 1: 0.5, 2: 0.75 });
});

test('quote input rejects floating revisions, unset sets, budget overflow and unknown fields', () => {
  const { input } = fixture();
  for (const change of [{ revision: 'main' }, { max_turns: 49 }, { episode_timeout_seconds: 3601 }, { max_episode_tokens: 65537 }, { max_episode_tokens: 64 }, { unreviewed: true }, { mode: 'subnet', model_access: 'private' }, { envs: [{ env: 'test', problems: 2, samples: 2 }] }])
    assert.throws(() => parseEvaluationQuoteInput({ ...input, ...change }));
});

test('Telecom episode quotes require explicit thinking without changing other harnesses', () => {
  const { input } = fixture();
  const telecom = { ...input, mode: 'direct', harness: 'telecom-episode-v1', thinking: true };
  assert.equal(parseEvaluationQuoteInput(telecom).thinking, true);
  for (const thinking of [false, undefined])
    assert.throws(() => parseEvaluationQuoteInput({ ...telecom, thinking }));
  for (const harness of ['single-turn', 'signed-bash-v1'])
    assert.equal(parseEvaluationQuoteInput({ ...input, mode: 'direct', harness, thinking: false }).thinking, false);
});

test('raw producer protocol bytes are authoritative across integral floats and non-ASCII', async () => {
  const f = fixture();
  f.quote.protocol.sampling.temperature = 1;
  f.quote.sampling.temperature = 1;
  f.input.sampling.temperature = 1;
  f.quote.protocol_json = JSON.stringify(f.quote.protocol).replace('"temperature":1', '"temperature":1.0');
  f.quote.protocol_sha256 = sha(f.quote.protocol_json);
  const client = createEvaluationClient(async () => f.quote);
  assert.equal((await client.quote(f.input)).protocol_json, f.quote.protocol_json);
  f.quote.protocol_sha256 = '0'.repeat(64);
  await assert.rejects(client.quote(f.input));
});

test('single-attempt create retains exact key and treats a wrong receipt as unknown', async () => {
  const f = fixture(), seen = [];
  const client = createEvaluationClient(async (path, init) => { seen.push({ path, init }); throw new TypeError('lost acknowledgement'); });
  await assert.rejects(client.create(f.quote.quote_id, 'original-request-key-0001', f.order.client_ref), e => e instanceof GenerationApiError && e.code === 'outcome_unknown' && e.retryKey === 'original-request-key-0001');
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].init.body), { quote_id: f.quote.quote_id, client_ref: f.order.client_ref });
  const wrong = createEvaluationClient(async () => ({ evaluation: { ...f.order, quote_id: 'another-quote' } }));
  await assert.rejects(wrong.create(f.quote.quote_id, 'original-request-key-0001', f.order.client_ref), e => e.code === 'outcome_unknown');
});

test('owned reconciliation filters preserve exact quote and caller reference', async () => {
  const f = fixture(), ref = 'job:/set+1=@a', paths = [];
  f.order.client_ref = ref;
  const client = createEvaluationClient(async path => { paths.push(path); return { evaluations: [f.order] }; });
  assert.equal((await client.orders({ quote_id: 'quote-a', client_ref: ref })).evaluations.length, 1);
  assert.equal(new URL(paths[0], 'https://example.test').searchParams.get('client_ref'), ref);
  await assert.rejects(client.orders({ quote_id: 'another-quote' }));
});

test('evaluation transport remains route-scoped, bounded and redirect-safe', async () => {
  const seen = [];
  const transport = createEvaluationTransport({ origin: 'https://example.test', apiKey: 'evaluation-secret', fetch: async (url, init) => { seen.push({ url, init }); return new Response('{}'); } });
  await transport.request('/api/v1/evaluations/catalog');
  assert.equal(seen[0].init.headers.has('Authorization'), false);
  const request = evaluationRequests().orders({ quote_id: 'quote-a', client_ref: 'job:/set+1=@a' });
  await transport.request(request.path, { headers: { Cookie: 'do-not-send' } });
  assert.equal(seen[1].init.headers.get('Authorization'), 'Bearer evaluation-secret');
  assert.equal(seen[1].init.headers.has('Cookie'), false);
  assert.equal(seen[1].init.redirect, 'manual');
  for (const path of ['/api/v1/dataset-orders', '/api/admin/subnet/tasks', '/api/v1/evaluations?quote_id=a&quote_id=b', '/api/v1/evaluations?unexpected=x', '/api/v1/evaluations/order-a?client_ref=x'])
    await assert.rejects(transport.request(path), e => e.code === 'invalid_route');
  const redirect = createEvaluationTransport({ apiKey: 'secret', fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } }) });
  await assert.rejects(redirect.request('/api/v1/evaluations'), e => e.code === 'redirect_refused');
});

test('report verification refuses other checkpoints, sets, digests, counts and producer objects', () => {
  const f = fixture(), order = parseEvaluationOrder({ evaluation: f.order });
  const changes = [r => r.provenance.revision = 'b'.repeat(40), r => r.eval_id = 'other', r => r.provenance.sets[0].protocol_sha256 = '0'.repeat(64), r => r.envs.test.expected_rows++, r => r.protocol_sha256 = '0'.repeat(64), r => r.protocol_json += ' '];
  for (const change of changes) { const report = structuredClone(f.report); change(report); assert.throws(() => parseEvaluationReport(report, order)); }
  const partial = structuredClone(f.report); partial.complete = partial.envs.test.complete = false; partial.envs.test.graded_rows--; partial.envs.test.missing_rows++;
  assert.equal(parseEvaluationReport(partial, order).complete, false);
});

test('new checkpoints share protocol identity while quote model pins remain exact', async () => {
  const a = fixture(), b = fixture({ revision: 'b'.repeat(40) });
  assert.equal(a.quote.protocol_sha256, b.quote.protocol_sha256);
  const client = createEvaluationClient(async () => b.quote);
  await assert.rejects(client.quote(a.input), /does not match/);
});

test('protocol duplicate keys are rejected, including decoded escape aliases', async () => {
  for (const raw of ['{"x":1,"x":1}', '{"x":1,"\\u0078":1}', '{"outer":[{"x":1,"x":2}]}'])
    await assert.rejects(verifyEvaluationProtocol({ protocol: JSON.parse(raw), protocol_json: raw, protocol_sha256: sha(raw) }), /Duplicate/);
});

test('legacy v2 reports remain readable without qualifying a pinned comparison', () => {
  const f = fixture();
  for (const field of ['protocol', 'protocol_json', 'protocol_sha256', 'protocol_bindings']) { delete f.order[field]; delete f.report[field]; }
  delete f.report.provenance.model_sha;
  delete f.report.provenance.sets[0].protocol_sha256;
  const order = parseEvaluationOrder({ evaluation: f.order });
  assert.equal(parseEvaluationReport(f.report, order).protocol_sha256, null);
  f.order.protocol = fixture().protocol;
  assert.throws(() => parseEvaluationReport(f.report, parseEvaluationOrder({ evaluation: f.order })));
  const pinned = fixture(); pinned.report.provenance.model_sha = 'b'.repeat(40);
  assert.throws(() => parseEvaluationReport(pinned.report, parseEvaluationOrder({ evaluation: pinned.order })));
});
