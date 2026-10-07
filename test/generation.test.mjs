import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import {
  createGenerationClient, createGenerationTransport, generationRequests, parseGenerationResponse,
  parseBatchOrderDetail, parseGenerationOrderDetail, GenerationApiError,
} from '../dist/index.js';

const input = { model: 'example-model', source: 'example-source', prompt_count: 1, samples_per_prompt: 1, max_new_tokens: 32, thinking: false };
const quote = { ...input, quote_id: 'quote-a', price_usd: 1, est_tokens: 32, eta_hours: 0.1, expires_at: '2030-01-01T00:00:00Z' };
const catalog = { ordering: 'disabled', any_model_ordering: 'disabled', models: [], envs: [] };
const order = { ...input, id: 'order-a', status: 'delivered', price_usd: 1, cancel_requested: false, status_reason: null, needs_attention: false,
  progress: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z', finished_at: null,
  refunded_usd: 0, deliveries: [{ delivery_id: 'delivery-a', files: [{ name: 'data.jsonl', size: 3, sha256: 'a'.repeat(64), url: '/api/v1/dataset-orders/order-a/deliveries/delivery-a/files/data.jsonl' }] }] };
const browserOrder = { ...order, billing: { status: 'held', reserved_micro_usd: 1_000_000, held_micro_usd: 1_000_000, charged_micro_usd: null, released_micro_usd: 0 },
  deliveries: [{ delivery_id: 'delivery-a', files: [{ ...order.deliveries[0].files[0], url: '/api/batch/orders/order-a/deliveries/delivery-a/files/data.jsonl' }] }] };

test('browser and key projections preserve authority, billing and owned artifact bindings', () => {
  assert.deepEqual(parseGenerationOrderDetail(order), order);
  assert.deepEqual(parseBatchOrderDetail(browserOrder), browserOrder);
  assert.throws(() => parseBatchOrderDetail(order));
  assert.throws(() => parseGenerationOrderDetail(browserOrder));
  assert.throws(() => parseBatchOrderDetail({ ...browserOrder, billing: { ...browserOrder.billing, released_micro_usd: 1 } }));
  assert.throws(() => parseGenerationResponse('orders', { orders: [order, order] }));
});

test('client binds quotes and order reads to the requested intent', async () => {
  const client = createGenerationClient(async () => ({ ...quote, prompt_count: 2 }));
  await assert.rejects(client.quote(input), /quoted configuration changed/);
  const other = createGenerationClient(async () => ({ order: { ...order, id: 'other', deliveries: [] } }));
  await assert.rejects(other.detail('order-a'), /did not match/);
  await assert.rejects(other.cancel('order-a'), e => e instanceof GenerationApiError && e.code === 'outcome_unknown');
});

test('builders reject traversal, mixed identities, malformed sampling and oversized ranges', () => {
  const requests = generationRequests();
  for (const id of ['..', '../admin', 'a/b', 'a%2Fb']) assert.throws(() => requests.detail(id));
  for (const name of ['..', '../key', 'a/b', 'a\\b', '\n']) assert.throws(() => requests.download('order-a', 'delivery-a', name));
  assert.throws(() => requests.download('order-a', 'delivery-a', 'data.jsonl', { offset: 0, maxBytes: 262145 }));
  assert.throws(() => requests.download('order-a', 'delivery-a', 'data.jsonl', { offset: Number.MAX_SAFE_INTEGER, maxBytes: 2 }));
  assert.throws(() => requests.quote({ ...input, revision: 'a'.repeat(40), env: 'example' }));
  assert.throws(() => requests.quote({ ...input, prompt_count: NaN }));
  assert.throws(() => requests.quote({ ...input, worker_url: 'https://example.invalid' }));
  const { source, ...common } = input;
  assert.throws(() => requests.quote({ ...common, model: 'example/model', revision: 'a'.repeat(40), env: 'example', sampling: { temperature: 0 } }));
});

test('ambiguous creation retains original request key and never retries automatically', async () => {
  const calls = [];
  const client = createGenerationClient(async (path, init) => { calls.push({ path, init }); return { unexpected: true }; });
  const key = 'original-request-key-0001';
  await assert.rejects(client.create('quote-a', key), e => e.code === 'outcome_unknown' && e.retryKey === key);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['Idempotency-Key'], key);
  assert.deepEqual(JSON.parse(calls[0].init.body), { quote_id: 'quote-a' });
});

test('injected transports preserve definite refusals and classify ambiguous mutation failures', async () => {
  for (const status of [0, 408, 500, 502]) {
    const client = createGenerationClient(async () => { throw Object.assign(new Error('failure'), { status }); }, { audience: 'browser' });
    await assert.rejects(client.create('quote-a', 'original-request-key-0001'), e => e.code === 'outcome_unknown' && e.retryKey === 'original-request-key-0001');
  }
  const refusal = Object.assign(new Error('review required'), { status: 403 });
  const client = createGenerationClient(async () => { throw refusal; });
  await assert.rejects(client.create('quote-a', 'original-request-key-0001'), e => e === refusal);
});

test('fetch transport follows real customer protocol without forwarding credentials to public reads', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', bytes => { body += bytes; });
    request.on('end', () => {
      seen.push({ path: request.url, method: request.method, headers: request.headers, body });
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/v1/generation/catalog') return response.end(JSON.stringify(catalog));
      if (request.url === '/api/v1/dataset-orders/quotes') { response.statusCode = 201; return response.end(JSON.stringify(quote)); }
      if (request.url === '/api/v1/dataset-orders/order-a/deliveries/delivery-a/files/data.jsonl') {
        response.statusCode = 206; response.setHeader('Content-Range', 'bytes 0-2/3'); response.setHeader('Content-Type', 'application/x-ndjson'); return response.end('abc');
      }
      if (request.url === '/api/v1/dataset-orders' && request.method === 'GET') return response.end(JSON.stringify({ orders: [order] }));
      if (request.url === '/api/v1/dataset-orders' && request.method === 'POST') response.statusCode = 201;
      if (request.url.endsWith('/cancel')) response.statusCode = 202;
      return response.end(JSON.stringify({ order }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const transport = createGenerationTransport({ origin, apiKey: 'test-key' });
    const client = createGenerationClient(transport.request);
    assert.deepEqual(await client.catalog(), catalog);
    assert.deepEqual(await client.quote(input), quote);
    await client.create('quote-a', 'original-request-key-0001');
    await client.orders(); await client.detail('order-a'); await client.cancel('order-a');
    const file = await transport.download('order-a', 'delivery-a', 'data.jsonl', { offset: 0, maxBytes: 3 });
    assert.equal(new TextDecoder().decode(file.bytes), 'abc');
    assert.equal(seen[0].headers.authorization, undefined);
    assert(seen.slice(1).every(r => r.headers.authorization === 'Bearer test-key' && !r.headers.cookie));
    assert.equal(seen[2].headers['idempotency-key'], 'original-request-key-0001');
    assert.equal(seen.at(-1).headers.range, 'bytes=0-2');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('transport refuses other origins, private routes, insecure origins and redirects', async () => {
  for (const origin of ['http://example.invalid', 'https://example.invalid/path', 'https://user:secret@example.invalid', 'https://example.invalid?secret=x'])
    assert.throws(() => createGenerationTransport({ origin }));
  let calls = 0;
  const transport = createGenerationTransport({ apiKey: 'test-key', fetch: async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }); } });
  for (const path of ['https://example.invalid/api/v1/dataset-orders', '/api/admin/subnet/tasks', '/api/internal/tasks', '/api/v1/dataset-orders?token=x', '/api/v1/dataset-orders/a/../quotes'])
    await assert.rejects(transport.request(path), e => e.code === 'invalid_route');
  assert.equal(calls, 0);
  await assert.rejects(transport.request('/api/v1/dataset-orders'), e => e.code === 'redirect_refused');
  await assert.rejects(transport.request('/api/v1/dataset-orders', { method: 'POST', headers: { 'Idempotency-Key': 'original-request-key-0001' }, body: '{}' }), e => e.code === 'outcome_unknown' && e.retryKey === 'original-request-key-0001');
  assert.equal(calls, 2);
});

test('transport bounds response bytes and preserves ambiguous write classification', async () => {
  const transport = createGenerationTransport({ apiKey: 'test-key', fetch: async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)) });
  await assert.rejects(transport.request('/api/v1/dataset-orders'), e => e.code === 'response_too_large');
  await assert.rejects(transport.request('/api/v1/dataset-orders', { method: 'POST', headers: { 'Idempotency-Key': 'original-request-key-0001' } }), e => e.code === 'outcome_unknown' && e.retryKey === 'original-request-key-0001');
  const file = createGenerationTransport({ apiKey: 'test-key', fetch: async () => new Response('four') });
  await assert.rejects(file.download('order-a', 'delivery-a', 'data.jsonl', { offset: 0, maxBytes: 3 }), e => e.code === 'response_too_large');
  const wrong = createGenerationTransport({ apiKey: 'test-key', fetch: async () => new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 1-3/10' } }) });
  await assert.rejects(wrong.download('order-a', 'delivery-a', 'data.jsonl', { offset: 0, maxBytes: 3 }), e => e.code === 'invalid_file_range');
});
