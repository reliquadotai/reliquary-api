import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  parseGenerationCatalog, parseBatchQuote, parseBatchOrders, parseBatchOrderResponse,
  parseGenerationOrderResponse, parseGenerationOrders, parseGenerationQuoteInput,
  parseGenerationResponse, assertGenerationQuoteMatches, parseBatchFile,
} from '../dist/index.js';

const spec = JSON.parse(await readFile(new URL('../contracts/generation.openapi.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const example = name => structuredClone(spec.components.examples[name].value);
function resolve(ref) {
  assert.ok(ref.startsWith('#/'), `External reference is not part of this package: ${ref}`);
  return ref.slice(2).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, key) => { assert.ok(value && Object.hasOwn(value, key), `Missing ${ref}`); return value[key]; }, spec);
}

test('OpenAPI baseline, every reference, operation and path parameter stay complete', () => {
  assert.equal(spec.openapi, '3.1.1');
  assert.equal(spec.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(spec.info.version, '0.3.0');
  assert.deepEqual(spec.servers.map(s => s.url), ['https://api.reliqua.ai', 'https://app.reliqua.ai']);
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) resolve(value.$ref);
    for (const child of Object.values(value)) walk(child);
  };
  walk(spec);
  const ids = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) {
    assert.match(path, /^\/api\/(?:v1\/(?:generation\/catalog|dataset-orders|files)|batch\/(?:catalog|quotes|orders))/);
    assert.doesNotMatch(path, /\/(?:internal|admin|auth|custody|payments)(?:\/|$)/);
    for (const [method, operation] of Object.entries(methods)) {
      assert.ok(['get', 'post'].includes(method) || (method === 'put' && path.endsWith('/parts/{part}')));
      assert.ok(!ids.has(operation.operationId));
      ids.add(operation.operationId);
      const parameters = (operation.parameters ?? []).map(p => p.$ref ? resolve(p.$ref) : p);
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
      assert.deepEqual(parameters.filter(p => p.in === 'path').map(p => p.name).sort(), placeholders.sort());
      assert.ok(parameters.filter(p => p.in === 'path').every(p => p.required));
      assert.equal(new Set(parameters.map(p => `${p.in}:${p.name}`)).size, parameters.length);
      assert.ok(operation.responses['500']);
      for (const [status, response] of Object.entries(operation.responses)) {
        assert.match(status, /^[1-5][0-9]{2}$/);
        assert.ok(response.description);
        for (const media of Object.values(response.content ?? {})) assert.ok(media.schema);
      }
      const publicRead = path.endsWith('/catalog');
      const browser = path.startsWith('/api/batch/');
      assert.deepEqual(operation.security, publicRead ? [] : [{ [browser ? 'browserSession' : 'workspaceKey']: [] }]);
      if (!publicRead && !browser) assert.equal(operation['x-required-api-key-scope'], 'orders:write');
      if (method === 'post' && browser) {
        assert.ok(parameters.some(p => p.name === 'Origin' && p.required));
        assert.ok(parameters.some(p => p.name === 'X-XSRF-TOKEN' && p.required));
      }
    }
  }
  assert.equal(ids.size, 20);
});

test('route variants preserve success statuses, projection, idempotency and bounded lists', () => {
  for (const [root, audience] of [['/api/v1/dataset-orders', 'Key'], ['/api/batch/orders', 'Browser']]) {
    const orders = spec.paths[root];
    assert.ok(orders.post.responses['200'] && orders.post.responses['201']);
    assert.equal(orders.post.responses['200'].content['application/json'].schema.$ref, `#/components/schemas/${audience}OrderResponse`);
    const created = Object.values(orders.post.responses['201'].content['application/json'].examples)[0];
    const reserved = resolve(created.$ref).value.order;
    assert.equal(reserved.status, 'reserved');
    assert.equal(reserved.finished_at, null);
    assert.deepEqual(reserved.deliveries, []);
    assert.ok(orders.post.parameters.some(p => resolve(p.$ref).name === 'Idempotency-Key'));
    assert.equal(spec.components.schemas[`${audience}OrdersResponse`].properties.orders.maxItems, 100);
    assert.ok(!orders.get.parameters?.some(p => (p.$ref ? resolve(p.$ref) : p).name === 'cursor'));
    assert.ok(spec.paths[`${root}/{orderId}/cancel`].post.responses['202']);
    assert.ok(!spec.paths[`${root}/{orderId}/cancel`].post.responses['202'].content['application/json'].examples);
    const download = spec.paths[`${root}/{orderId}/deliveries/{deliveryId}/files/{fileName}`].get;
    assert.ok(download.responses['200'] && download.responses['206']);
    assert.ok(download.responses['206'].headers['Content-Range']);
    assert.ok(!download.responses['200'].headers.ETag);
  }
  assert.equal(spec.components.schemas.CatalogQuoteInput.additionalProperties, false);
  assert.equal(spec.components.schemas.PinnedQuoteInput.additionalProperties, false);
  assert.equal(spec.components.schemas.CatalogQuoteInput.properties.max_new_tokens.maximum, 32768);
  assert.equal(spec.components.schemas.PinnedQuoteInput.properties.max_new_tokens.maximum, 131072);
  assert.equal(spec.components.schemas.SamplingInput.properties.temperature.exclusiveMinimum, 0);
  assert.ok(!spec.components.schemas.PinnedQuoteInput.required.includes('sampling'));
  assert.equal(spec.components.schemas.OrderBase.properties.price_usd.minimum, 0);
  assert.equal(spec.components.schemas.BrowserOrder.allOf[1].properties.price_usd.minimum, 0.01);
  assert.equal(spec.components.schemas.QuoteBase.properties.price_usd.minimum, 0.01);
});

test('published synthetic examples satisfy both shipped runtime audiences', () => {
  parseGenerationCatalog(example('catalog'));
  for (const kind of ['catalog', 'pinned', 'file']) {
    const input = parseGenerationQuoteInput(example(`${kind}QuoteInput`));
    const quote = parseBatchQuote(example(`${kind}Quote`));
    assertGenerationQuoteMatches(quote, input);
    parseGenerationResponse('quote', quote, 'key', { input });
  }
  const key = parseGenerationOrderResponse(example('keyOrder'));
  const browser = parseBatchOrderResponse(example('browserOrder'));
  assert.ok(!Object.hasOwn(key, 'billing'));
  assert.equal(browser.billing.status, 'settled');
  assert.equal(key.deliveries[0].files[0].url.startsWith('/api/v1/dataset-orders/'), true);
  assert.equal(browser.deliveries[0].files[0].url.startsWith('/api/batch/orders/'), true);
  parseGenerationOrders(example('keyOrders'));
  parseBatchOrders(example('browserOrders'));
  parseGenerationOrderResponse(example('keyCreatedOrder'));
  parseBatchOrderResponse(example('browserCreatedOrder'));
  assert.equal(parseGenerationOrderResponse(example('keyHistoricalOrder')).price_usd, 0.000001);
  parseGenerationResponse('order', example('keyOrder'), 'key', { id: key.id });
  parseGenerationResponse('order', example('browserOrder'), 'browser', { id: browser.id });
});

test('runtime checks retain semantic identity, ownership links and finance invariants', () => {
  const money = example('browserOrder');
  money.order.billing.charged_micro_usd += 1;
  assert.throws(() => parseBatchOrderResponse(money));
  const link = example('keyOrder');
  link.order.deliveries[0].files[0].url = '/api/v1/dataset-orders/other-order/deliveries/example-delivery/files/part-00000.parquet';
  assert.throws(() => parseGenerationOrderResponse(link));
  assert.throws(() => parseGenerationResponse('order', example('keyOrder'), 'key', { id: 'other-order' }));
  const duplicate = example('keyOrders');
  duplicate.orders.push(duplicate.orders[0]);
  assert.throws(() => parseGenerationOrders(duplicate));
  const input = example('pinnedQuoteInput');
  input.sampling.temperature = 0;
  assert.throws(() => parseGenerationQuoteInput(input));
  const historical = example('browserCreatedOrder');
  historical.order.price_usd = 0.000001;
  historical.order.billing.reserved_micro_usd = 1;
  historical.order.billing.held_micro_usd = 1;
  assert.throws(() => parseBatchOrderResponse(historical));
});

test('batch file routes publish their contract and examples', () => {
  const file = parseBatchFile(example('batchFile'));
  assert.equal(file.upload.parts, Math.ceil(file.bytes / file.upload.part_size));
  assert.ok(spec.paths['/api/v1/files/{fileId}/parts/{part}'].put.requestBody.content['application/octet-stream']);
  assert.equal(spec.components.schemas.FileQuoteInput.additionalProperties, false);
  assert.deepEqual(spec.components.schemas.FileQuoteInput.required, ['model', 'revision', 'input_file_id']);
  assert.ok(spec.paths['/api/v1/files/{fileId}/content'].get.responses['206'].headers['Content-Range']);
  assert.ok(spec.paths['/api/v1/dataset-orders/quotes'].post.responses['201'].content['application/json'].examples.fileQuote);
});
