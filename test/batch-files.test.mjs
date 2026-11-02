import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  batchFileRequests, createBatchFileClient, createGenerationClient, createGenerationTransport, generationRequests,
  parseBatchFile, parseBatchFileList, parseBatchQuote, parseGenerationOrderDetail, parseGenerationQuoteInput,
  assertGenerationQuoteMatches, isFileQuote,
} from '../dist/index.js';
import { uploadFile, downloadDelivery } from '../dist/batch-node.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const REV = 'c'.repeat(40);
const fileQuoteInput = { model: 'org/model', revision: REV, input_file_id: 'file-abc', max_new_tokens: 512, output_format: 'openai_jsonl' };
const fileQuote = {
  quote_id: 'quote-f', price_usd: 1.25, est_price_usd: 0.75, est_tokens: 100, max_tokens: 200, eta_hours: 1, max_hours: 2,
  expires_at: '2030-01-01T00:00:00Z', model: 'org/model', revision: REV, input_file_id: 'file-abc', prompt_count: 2,
  samples_per_prompt: 1, max_new_tokens: 512, sampling: { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, max_tokens: 512, seed: 7, n: 1 },
  line_errors: 1, preview: [{ custom_id: 'r-1', prompt_tokens: 12, text: '<|user|>hi\n<|assistant|>' }], pricing: { mode: 'any_model' },
  output_format: 'openai_jsonl',
};

test('file quotes parse with their own identity and bind to the request', () => {
  assert.deepEqual(parseGenerationQuoteInput(fileQuoteInput), fileQuoteInput);
  for (const bad of [{ ...fileQuoteInput, env: 'x' }, { ...fileQuoteInput, input_file_id: '../x' }, { ...fileQuoteInput, revision: 'main' },
    { ...fileQuoteInput, output_format: 'csv' }, { ...fileQuoteInput, max_new_tokens: 0 }, { ...fileQuoteInput, thinking: true }])
    assert.throws(() => parseGenerationQuoteInput(bad));
  const quote = parseBatchQuote(fileQuote);
  assert.ok(isFileQuote(quote));
  assert.deepEqual(quote, fileQuote);
  assertGenerationQuoteMatches(quote, fileQuoteInput);
  assert.throws(() => assertGenerationQuoteMatches({ ...quote, input_file_id: 'file-other' }, fileQuoteInput), /changed/);
  assert.throws(() => assertGenerationQuoteMatches(quote, { model: 'org/model', source: 'x', prompt_count: 1, samples_per_prompt: 1, max_new_tokens: 32, thinking: false }), /changed/);
  for (const bad of [{ ...fileQuote, sampling: { ...fileQuote.sampling, logit_bias: {} } }, { ...fileQuote, line_errors: -1 },
    { ...fileQuote, preview: 'x' }, { ...fileQuote, sampling: { ...fileQuote.sampling, temperature: 0 } }])
    assert.throws(() => parseBatchQuote(bad));
});

test('file orders keep their file identity and owned delivery links', () => {
  const { quote_id, price_usd, est_price_usd, est_tokens, max_tokens, eta_hours, max_hours, expires_at, line_errors, preview, pricing, ...fields } = fileQuote;
  const order = { ...fields, id: 'order-f', status: 'delivered', price_usd: 1.25, cancel_requested: false, status_reason: null, needs_attention: false,
    progress: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z', finished_at: null, refunded_usd: 0.1,
    deliveries: [{ delivery_id: 'dl-order-f', files: [{ name: 'output-00000.jsonl', size: 3, sha256: 'a'.repeat(64),
      url: '/api/v1/dataset-orders/order-f/deliveries/dl-order-f/files/output-00000.jsonl' }] }] };
  const parsed = parseGenerationOrderDetail(order);
  assert.equal(parsed.input_file_id, 'file-abc');
  assert.equal(parsed.sampling.seed, 7);
  assert.throws(() => parseGenerationOrderDetail({ ...order, env: 'x' }));
});

test('file routes and records are strict', () => {
  const requests = batchFileRequests();
  assert.equal(requests.part('file-abc', 3).path, '/api/v1/files/file-abc/parts/3');
  assert.equal(requests.list().path, '/api/v1/files?purpose=batch');
  for (const id of ['..', 'file-../x', 'abc', 'file-a/b']) assert.throws(() => requests.get(id));
  assert.throws(() => requests.part('file-abc', 0));
  assert.throws(() => requests.create({ filename: '../x.jsonl', bytes: 3, purpose: 'batch' }));
  assert.throws(() => requests.create({ filename: 'x.jsonl', bytes: 300 * 1024 * 1024, purpose: 'batch' }));
  const file = { id: 'file-abc', object: 'file', bytes: 40, filename: 'in.jsonl', purpose: 'batch', status: 'uploading',
    created_at: '2026-01-01T00:00:00Z', upload: { part_size: 16, parts: 3 } };
  assert.deepEqual(parseBatchFile(file), file);
  assert.throws(() => parseBatchFile({ ...file, upload: { part_size: 16, parts: 2 } }));
  assert.throws(() => parseBatchFileList({ data: [file, file] }));
  // Generation request builders still refuse file paths: files have their own routes.
  assert.throws(() => generationRequests().detail('file-abc/../x'));
});

function fakePlatform() {
  const files = new Map();
  const seen = [];
  const delivered = new Map();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', c => chunks.push(c));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: request.method, url: request.url, auth: request.headers.authorization, type: request.headers['content-type'], range: request.headers.range, bytes: body.length });
      const json = (status, value) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      let m;
      if (request.method === 'POST' && request.url === '/api/v1/files') {
        const input = JSON.parse(body);
        const id = 'file-' + (files.size + 1);
        const part = 16;
        files.set(id, { id, object: 'file', bytes: input.bytes, filename: input.filename, purpose: input.purpose, status: 'uploading',
          created_at: '2026-01-01T00:00:00Z', upload: { part_size: part, parts: Math.ceil(input.bytes / part) }, parts: new Map() });
        const { parts, ...doc } = files.get(id);
        return json(201, doc);
      }
      if ((m = request.url.match(/^\/api\/v1\/files\/(file-\d+)\/parts\/(\d+)$/)) && request.method === 'PUT') {
        const file = files.get(m[1]);
        if (file.failNext) { file.failNext = false; return json(502, { error: { code: 'bad_gateway' } }); }
        file.parts.set(Number(m[2]), body);
        return json(200, { part: Number(m[2]), etag: sha(body).slice(0, 16) });
      }
      if ((m = request.url.match(/^\/api\/v1\/files\/(file-\d+)\/complete$/))) {
        const file = files.get(m[1]);
        file.content = Buffer.concat([...file.parts.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]));
        if (file.content.length !== file.bytes) return json(409, { error: { code: 'parts_missing' } });
        file.status = 'processed';
        const { parts, content, upload, failNext, ...doc } = file;
        return json(200, doc);
      }
      if ((m = request.url.match(/^\/api\/v1\/files\/(file-\d+)$/))) {
        const { parts, content, failNext, ...doc } = files.get(m[1]);
        return json(200, doc);
      }
      if ((m = request.url.match(/^\/api\/v1\/dataset-orders\/order-f\/deliveries\/dl-1\/files\/(.+)$/))) {
        const content = delivered.get(decodeURIComponent(m[1]));
        const start = request.headers.range ? Number(request.headers.range.match(/^bytes=(\d+)-$/)[1]) : 0;
        response.statusCode = start ? 206 : 200;
        if (start) response.setHeader('Content-Range', `bytes ${start}-${content.length - 1}/${content.length}`);
        response.setHeader('Content-Length', String(content.length - start));
        return response.end(content.subarray(start));
      }
      return json(404, { error: { code: 'not_found' } });
    });
  });
  return { server, files, seen, delivered };
}

test('a local file uploads in the parts the platform asks for, an ambiguous part is sent again', async () => {
  const fake = fakePlatform();
  await new Promise(r => fake.server.listen(0, '127.0.0.1', r));
  try {
    const transport = createGenerationTransport({ origin: `http://127.0.0.1:${fake.server.address().port}`, apiKey: 'test-key' });
    const dir = await mkdtemp(join(tmpdir(), 'batch-'));
    const path = join(dir, 'requests.jsonl');
    const content = Buffer.from('{"custom_id":"a"}\n{"custom_id":"b"}\n{"custom_id":"c"}\n');
    await writeFile(path, content);
    const progress = [];
    let failed = false;
    const original = transport.putPart;
    const flaky = { ...transport, putPart: async (p, b, s) => {
      if (!failed && p.endsWith('/parts/2')) { failed = true; fake.files.get('file-1').failNext = true; }
      return original(p, b, s);
    } };
    const file = await uploadFile(flaky, path, { onPart: (p, n) => progress.push(`${p}/${n}`) });
    assert.equal(file.status, 'processed');
    assert.equal(file.bytes, content.length);
    assert.deepEqual(fake.files.get(file.id).content, content);
    assert.deepEqual(progress, ['1/4', '2/4', '3/4', '4/4']);
    const puts = fake.seen.filter(r => r.method === 'PUT');
    assert.equal(puts.length, 5);
    assert.ok(puts.every(r => r.type === 'application/octet-stream' && r.auth === 'Bearer test-key'));
    const client = createBatchFileClient(transport);
    assert.equal((await client.get(file.id)).status, 'processed');
  } finally { await new Promise(r => fake.server.close(r)); }
});

test('a delivery is written to disk, resumed by Range and checked against its sha256', async () => {
  const fake = fakePlatform();
  const output = Buffer.from('{"custom_id":"a"}\n'.repeat(50));
  const report = Buffer.from('{"schema":"v3"}');
  fake.delivered.set('output-00000.jsonl', output);
  fake.delivered.set('report.json', report);
  await new Promise(r => fake.server.listen(0, '127.0.0.1', r));
  try {
    const transport = createGenerationTransport({ origin: `http://127.0.0.1:${fake.server.address().port}`, apiKey: 'test-key' });
    const order = { deliveries: [{ delivery_id: 'dl-1', files: [
      { name: 'output-00000.jsonl', size: output.length, sha256: sha(output), url: '/api/v1/dataset-orders/order-f/deliveries/dl-1/files/output-00000.jsonl' },
      { name: 'report.json', size: report.length, sha256: null, url: '/api/v1/dataset-orders/order-f/deliveries/dl-1/files/report.json' },
    ] }] };
    const dir = await mkdtemp(join(tmpdir(), 'deliv-'));
    // A previous run stopped half way: the rest is fetched from that offset.
    await import('node:fs/promises').then(fs => fs.mkdir(join(dir, 'dl-1'), { recursive: true }));
    await writeFile(join(dir, 'dl-1', 'output-00000.jsonl.part'), output.subarray(0, 100));
    const files = await downloadDelivery(transport, order, dir);
    assert.deepEqual(await readFile(join(dir, 'dl-1', 'output-00000.jsonl')), output);
    assert.equal(files[0].verified, true);
    assert.equal(files[1].verified, false);
    assert.equal(fake.seen.find(r => r.url.endsWith('output-00000.jsonl')).range, 'bytes=100-');
    // Again: nothing fetched, the files on disk check out.
    const before = fake.seen.length;
    await downloadDelivery(transport, order, dir);
    assert.equal(fake.seen.length, before);
    // A file whose bytes do not match its hash is set aside, never kept under its name.
    const bad = { deliveries: [{ delivery_id: 'dl-1', files: [{ ...order.deliveries[0].files[0], name: 'report.json', size: report.length, sha256: 'b'.repeat(64),
      url: '/api/v1/dataset-orders/order-f/deliveries/dl-1/files/report.json' }] }] };
    const other = await mkdtemp(join(tmpdir(), 'deliv-'));
    await assert.rejects(downloadDelivery(transport, bad, other), /sha256/);
    await assert.rejects(stat(join(other, 'dl-1', 'report.json')));
    await assert.rejects(downloadDelivery(transport, { deliveries: [{ delivery_id: '..', files: [] }] }, other));
  } finally { await new Promise(r => fake.server.close(r)); }
});

test('the transport refuses part uploads outside the part route and oversized parts', async () => {
  let calls = 0;
  const transport = createGenerationTransport({ apiKey: 'test-key', fetch: async () => { calls++; return new Response('{}'); } });
  await assert.rejects(transport.putPart('/api/v1/dataset-orders/quotes', new Uint8Array(3)), e => e.code === 'invalid_route');
  await assert.rejects(transport.putPart('/api/v1/files/file-a/parts/1', new Uint8Array(65 * 1024 * 1024)), e => e.code === 'request_too_large');
  await assert.rejects(transport.request('/api/v1/files/file-a/parts/1', { method: 'POST', body: '{}' }), e => e.code === 'invalid_route');
  await assert.rejects(transport.request('/api/v1/files?purpose=other'), e => e.code === 'invalid_route');
  assert.equal(calls, 0);
  // The generation client still works on the same transport.
  createGenerationClient(transport.request);
});

test('a streamed download is bounded by its headers, not by the time its body takes', async () => {
  const body = Buffer.alloc(64, 'x');
  const server = createServer((request, response) => {
    response.setHeader('Content-Length', String(body.length));
    response.write(body.subarray(0, 32));
    setTimeout(() => response.end(body.subarray(32)), 300);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const transport = createGenerationTransport({ origin: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key', timeoutMs: 100 });
    const order = { deliveries: [{ delivery_id: 'dl-1', files: [{ name: 'a.jsonl', size: 64, sha256: sha(body),
      url: '/api/v1/dataset-orders/order-f/deliveries/dl-1/files/a.jsonl' }] }] };
    const dir = await mkdtemp(join(tmpdir(), 'slow-'));
    const [file] = await downloadDelivery(transport, order, dir);
    assert.equal(file.verified, true);
  } finally { await new Promise(r => server.close(r)); }
});
