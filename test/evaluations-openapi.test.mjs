import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseEvaluationCatalog, parseEvaluationQuoteInput, parseEvaluationQuote, assertEvaluationQuoteMatches, parseEvaluationOrder, parseEvaluationReport } from '../dist/index.js';

const spec = JSON.parse(await readFile(new URL('../contracts/evaluations.openapi.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const example = name => structuredClone(spec.components.examples[name].value);

test('evaluation OpenAPI and package exports expose only the existing owned API', () => {
  assert.equal(spec.openapi, '3.1.1');
  assert.equal(pkg.exports['./evaluations'].import, './dist/evaluation-api.js');
  assert.equal(pkg.exports['./evaluations/openapi'], './contracts/evaluations.openapi.json');
  const resolve = ref => ref.slice(2).split('/').reduce((v, k) => { assert.ok(Object.hasOwn(v, k), ref); return v[k]; }, spec);
  const walk = v => { if (!v || typeof v !== 'object') return; if (v.$ref) { assert.ok(v.$ref.startsWith('#/')); resolve(v.$ref); } Object.values(v).forEach(walk); };
  walk(spec);
  const ids = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) {
    assert.match(path, /^\/api\/v1\/evaluations(?:\/|$)/);
    assert.doesNotMatch(path, /\/(?:admin|internal|auth|custody)(?:\/|$)/);
    for (const [method, operation] of Object.entries(methods)) {
      assert.ok(['get', 'post'].includes(method));
      assert.ok(!ids.has(operation.operationId)); ids.add(operation.operationId);
      assert.ok(operation.responses['500'] && operation.responses['404']);
      assert.deepEqual(operation.security, path.endsWith('/catalog') ? [] : [{ workspaceKey: [] }]);
      if (!path.endsWith('/catalog')) assert.equal(operation['x-required-api-key-scope'], 'evaluations:write');
      assert.deepEqual((operation.parameters ?? []).filter(p => p.in === 'path').map(p => p.name).sort(), [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort());
    }
  }
  assert.equal(ids.size, 8);
});

test('published synthetic examples satisfy the exact runtime quote and report contracts', () => {
  parseEvaluationCatalog(example('catalog'));
  const input = parseEvaluationQuoteInput(example('quoteInput')), quote = parseEvaluationQuote(example('quote'));
  assertEvaluationQuoteMatches(quote, input);
  const order = parseEvaluationOrder(example('order'));
  assert.equal(parseEvaluationReport(example('report'), order).envs.test.n_problems_graded, 2);
});

test('OpenAPI preserves bounded lifecycle, fixed inputs and measured optional diagnostics', () => {
  assert.equal(spec.components.schemas.QuoteInput.additionalProperties, false);
  assert.equal(spec.components.schemas.QuoteInput.properties.max_turns.maximum, 48);
  assert.equal(spec.components.schemas.QuoteInput.properties.max_episode_tokens.maximum, 65536);
  assert.equal(spec.components.schemas.QuoteInput.properties.episode_timeout_seconds.maximum, 3600);
  const telecom = spec.components.schemas.QuoteInput.allOf.find(rule => rule.if.properties.harness.const === 'telecom-episode-v1');
  assert.deepEqual(telecom.if.required, ['harness']);
  assert.deepEqual(telecom.then, { properties: { thinking: { const: true } }, required: ['thinking'] });
  assert.equal(spec.components.schemas.OrdersResponse.properties.evaluations.maxItems, 100);
  assert.deepEqual(spec.paths['/api/v1/evaluations'].get.parameters.map(p => p.name), ['quote_id', 'client_ref']);
  assert.ok(spec.paths['/api/v1/evaluations'].post.parameters.some(p => p.name === 'Idempotency-Key' && p.required));
  assert.ok(spec.components.schemas.Metrics.properties.mean_turns.anyOf.some(s => s.type === 'null'));
  assert.ok(!spec.components.schemas.Metrics.required.includes('mean_turns'));
});
