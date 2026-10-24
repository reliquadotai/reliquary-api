import assert from 'node:assert/strict';
import { test } from 'node:test';
import { responseDiagnostics } from '../dist/error-diagnostics.js';
import { createGenerationTransport, createGenerationClient, createEvaluationTransport, createJobsTransport, createJobsClient, GenerationApiError, JobApiError } from '../dist/index.js';

const key = '55555555-5555-4555-8555-555555555555';
const diagnostics = { 'X-Request-ID': 'request-a:123', 'Retry-After': '17' };
const jobs = { name: 'jobs', transport: createJobsTransport, client: createJobsClient, read: '/api/v1/jobs', create: client => client.control('cpu:11111111-1111-4111-8111-111111111111', 'pause', { schema_version: 1, revision: '7', reason: 'Reviewed pause.' }, key), error: JobApiError };
const generation = { name: 'generation', transport: createGenerationTransport, client: createGenerationClient, read: '/api/v1/dataset-orders', create: client => client.create('quote-a', key), error: GenerationApiError };

test('response diagnostics accept bounded safe headers and strict HTTP dates', () => {
  const now = Date.UTC(2030, 0, 1);
  for (const [value, expected] of [['0', 0], ['86400', 86400], ['17', 17], ['-1', undefined], ['1.5', undefined], ['86401', undefined], ['99999999999999', undefined], ['later', undefined]])
    assert.equal(responseDiagnostics(new Headers({ 'Retry-After': value }), now).retryAfterSeconds, expected);
  assert.equal(responseDiagnostics(new Headers({ 'Retry-After': 'Tue, 01 Jan 2030 00:00:17 GMT' }), now).retryAfterSeconds, 17);
  assert.equal(responseDiagnostics(new Headers({ 'Retry-After': 'Tue, 01 Jan 2030 00:00:00 GMT' }), now + 1000).retryAfterSeconds, 0);
  assert.equal(responseDiagnostics(new Headers({ 'Retry-After': 'Wed, 02 Jan 2030 00:00:01 GMT' }), now).retryAfterSeconds, undefined);
  assert.equal(responseDiagnostics(new Headers({ 'Retry-After': 'Fri, 31 Feb 2030 00:00:00 GMT' }), now).retryAfterSeconds, undefined);
  for (const value of ['unsafe id', 'https://example.invalid/request', 'x'.repeat(129)])
    assert.equal(responseDiagnostics(new Headers({ 'X-Request-ID': value })).requestId, undefined);
  assert.equal(responseDiagnostics(new Headers({ 'X-Request-ID': 'x'.repeat(128) })).requestId.length, 128);
});

for (const surface of [jobs, generation]) {
  test(`${surface.name} defaults to the canonical origin while retaining explicit application origins`, async () => {
    const seen = [];
    const fetch = async url => { seen.push(url.origin); return new Response('{}'); };
    await surface.transport({ apiKey: 'fixture-key', fetch }).request(surface.read);
    await surface.transport({ origin: 'https://app.reliqua.ai', apiKey: 'fixture-key', fetch }).request(surface.read);
    assert.deepEqual(seen, ['https://api.reliqua.ai', 'https://app.reliqua.ai']);
    assert.throws(() => surface.transport({ origin: 'invalid origin' }), error => error instanceof surface.error && error.code === 'invalid_origin');
  });

  test(`${surface.name} preserves bounded diagnostics and original intent without retrying`, async () => {
    let calls = 0;
    const fetch = async () => { calls++; return new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: diagnostics }); };
    const transport = surface.transport({ apiKey: 'fixture-key', fetch });
    await assert.rejects(transport.request(surface.read), error => error instanceof surface.error && error.code === 'rate_limited' && error.status === 429 && error.requestId === 'request-a:123' && error.retryAfterSeconds === 17);
    for (const status of [408, 503]) {
      const client = surface.client(surface.transport({ apiKey: 'fixture-key', fetch: async () => { calls++; return new Response('', { status, headers: diagnostics }); } }).request);
      await assert.rejects(surface.create(client), error => error.code === 'outcome_unknown' && error.status === status && (error.requestKey ?? error.retryKey) === key && error.requestId === 'request-a:123' && error.retryAfterSeconds === 17 && (surface.name !== 'jobs' || error.revision === '7'));
    }
    assert.equal(calls, 3);
  });

  test(`${surface.name} retains response references on unreadable receipts and drops unsafe hints`, async () => {
    for (const headers of [diagnostics, { ...diagnostics, 'Content-Length': String(4 * 1024 * 1024 + 1) }]) {
      const client = surface.client(surface.transport({ apiKey: 'fixture-key', fetch: async () => new Response('invalid JSON', { headers }) }).request);
      await assert.rejects(surface.create(client), error => error.code === 'outcome_unknown' && error.requestId === 'request-a:123' && error.retryAfterSeconds === 17 && (error.requestKey ?? error.retryKey) === key);
    }
    const transport = surface.transport({ apiKey: 'fixture-key', fetch: async () => new Response('', { status: 503, headers: { 'X-Request-ID': 'unsafe id', 'Retry-After': '86401' } }) });
    await assert.rejects(transport.request(surface.read), error => error.status === 503 && error.requestId === undefined && error.retryAfterSeconds === undefined);
  });
}

for (const [name, createTransport, path] of [
  ['generation', createGenerationTransport, '/api/v1/dataset-orders'],
  ['evaluation', createEvaluationTransport, '/api/v1/evaluations'],
]) {
  test(`${name} direct transport treats a mutation timeout as unknown without retrying`, async () => {
    let calls = 0;
    const transport = createTransport({ apiKey: 'fixture-key', fetch: async () => {
      calls++;
      return new Response('{"error":{"code":"request_timeout"}}', { status: 408, headers: diagnostics });
    } });
    await assert.rejects(transport.request(path, {
      method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ quote_id: 'quote-a' }),
    }), error => error instanceof GenerationApiError && error.code === 'outcome_unknown' && error.status === 408 &&
      error.retryKey === key && error.requestId === 'request-a:123' && error.retryAfterSeconds === 17);
    assert.equal(calls, 1);
  });
}

test('optional diagnostics retain existing positional error messages and intent fields', () => {
  const generation = new GenerationApiError('outcome_unknown', 408, key, 'Original message.', 'request-a', 2);
  assert.equal(generation.message, 'Original message.'); assert.equal(generation.retryKey, key);
  const jobs = new JobApiError('outcome_unknown', 503, key, '7', 'request-b', 3);
  assert.equal(jobs.requestKey, key); assert.equal(jobs.revision, '7');
});
