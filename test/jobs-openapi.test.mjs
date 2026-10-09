import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseJobResponse, parseJobsPage, parseJobCreateInput, parseJobInputRef, parseDatasetValidationReport, parseJobCapabilities } from '../dist/index.js';

const spec = JSON.parse(await readFile(new URL('../contracts/jobs.openapi.json', import.meta.url), 'utf8'));
const resolve = ref => {
  assert(ref.startsWith('#/'));
  return ref.slice(2).split('/').reduce((parent, key) => { assert(parent && Object.hasOwn(parent, key), `Unresolved ${ref}`); return parent[key]; }, spec);
};
test('job OpenAPI names only the implemented common customer routes and complete references', () => {
  assert.equal(spec.openapi, '3.1.1');
  assert.equal(spec.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(spec.info.version, '0.2.0');
  assert.deepEqual(spec.servers.map(s => s.url), ['https://api.reliqua.ai', 'https://app.reliqua.ai']);
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) resolve(value.$ref);
    for (const nested of Object.values(value)) walk(nested);
  };
  walk(spec);
  const operations = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) {
    assert.match(path, /^\/api\/(?:v1\/)?(?:jobs|job-inputs|job-workers)(?:\/|$)/);
    assert.doesNotMatch(path, /\/(?:admin|internal|training|custody|payments)(?:\/|$)/);
    for (const [method, op] of Object.entries(methods)) {
      assert(['get', 'post'].includes(method)); assert(!operations.has(op.operationId)); operations.add(op.operationId);
      const browser = !path.startsWith('/api/v1/');
      assert.deepEqual(op.security, [{ [browser ? 'browserSession' : 'workspaceKey']: [] }]);
      if (!browser) assert.equal(op['x-required-api-key-scope'], method === 'post' ? 'resources:write' : 'resources:read');
      const parameters = op.parameters.map(p => resolve(p.$ref));
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
      assert.deepEqual(parameters.filter(p => p.in === 'path').map(p => p.name).sort(), placeholders.sort());
      assert(parameters.filter(p => p.in === 'path').every(p => p.required));
      assert.equal(new Set(parameters.map(p => `${p.in}:${p.name}`)).size, parameters.length);
      if (method === 'post') {
        assert(parameters.some(p => p.name === 'Idempotency-Key' && p.required));
        if (browser) for (const name of ['Origin', 'X-XSRF-TOKEN']) assert(parameters.some(p => p.name === name && p.required));
      }
      assert(op.responses['500']);
      for (const response of Object.values(op.responses)) {
        const resolved = response.$ref ? resolve(response.$ref) : response;
        assert(resolved.description && resolved.content['application/json'].schema);
      }
      assert.equal(op.responses['429'].$ref, '#/components/responses/RateLimited');
    }
  }
  assert.equal(operations.size, 26);
});

test('owner rate limits use the existing error envelope and bounded response diagnostics', () => {
  const response = spec.components.responses.RateLimited;
  assert.equal(response.content['application/json'].schema.$ref, '#/components/schemas/Error');
  assert.equal(response.content['application/json'].example.error.code, 'rate_limited');
  assert.equal(response.headers['Retry-After'].schema.type, 'integer');
  assert.equal(response.headers['Retry-After'].schema.minimum, 1);
  assert.equal(response.headers['Retry-After'].schema.maximum, 60);
  assert.equal(response.headers['X-Request-ID'].schema.maxLength, 128);
  assert.match(response.description, /240 GET/);
  assert.match(response.description, /120 writes/);
});

test('synthetic job examples parse through released trust boundaries and retain source authority', () => {
  const value = name => structuredClone(spec.components.examples[name].value);
  parseJobResponse(value('queuedJob')); parseJobsPage(value('jobs')); parseJobCreateInput(value('create'));
  parseJobInputRef(value('input').input); parseDatasetValidationReport(value('report')); parseJobCapabilities(value('capabilities'));
  assert.equal(spec.components.schemas.NativeJob.properties.attempts.maxItems, 0);
  assert.equal(spec.components.schemas.NativeJob.properties.work_units.maxItems, 0);
  assert.equal(spec.components.schemas.CpuJob.properties.work_units.minItems, 1);
  assert.equal(spec.components.schemas.ValidationSpec.properties.input.$ref, '#/components/schemas/InputRef');
  assert.equal(spec.components.schemas.WorkerEnrollmentResponse.properties.token.anyOf[0].writeOnly, true);
  assert.equal(spec.components.schemas.ValidationReport.properties.errors.maxItems, 20);
  assert.equal(spec.components.schemas.InputRef.properties.size_bytes.maximum, 32768);
});
