import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseBatchQuote, parseEvaluationOrder, parseEvaluationOrders, parseEvaluationQuote, parseGenerationOrderResponse, parseGenerationOrders } from '../dist/index.js';
import { createValidator } from './schema-validator.mjs';

async function contract(name) {
  const spec = JSON.parse(await readFile(new URL(`../contracts/${name}.openapi.json`, import.meta.url)));
  return {
    example: name => structuredClone(spec.components.examples[name].value),
    errors: createValidator(spec).errors,
  };
}

const generation = await contract('generation');
const evaluations = await contract('evaluations');
const openai = await contract('openai-batch');
const midnight = '2026-11-10T00:00:00.000Z';
const queue = { queue_position: 1, estimated_start_at: null };
const waiting = { starts: 'queued', reason: 'waiting_for_capacity', ...queue };
const reset = {
  starts: 'queued', reason: 'daily_capacity_reached', queue_position: 2,
  estimated_start_at: midnight, resets_at: midnight,
};

test('generation and evaluation quotes preserve optional model-specific capacity', () => {
  for (const [spec, schema, example, parse] of [
    [generation, 'FileQuote', 'fileEvaluationQuote', parseBatchQuote],
    [generation, 'PinnedQuote', 'pinnedQuote', parseBatchQuote],
    [evaluations, 'Quote', 'subnetQuote', parseEvaluationQuote],
  ]) {
    const quote = spec.example(example);
    assert.ok(!Object.hasOwn(parse(quote), 'capacity'));
    for (const capacity of [{ starts: 'now' }, waiting, reset]) {
      const wire = { ...quote, capacity };
      assert.deepEqual(spec.errors(schema, wire), []);
      assert.deepEqual(parse(wire).capacity, capacity);
    }
    const invalid = { ...quote, capacity: { ...waiting, queue_position: 0 } };
    assert.notDeepEqual(spec.errors(schema, invalid), []);
    assert.throws(() => parse(invalid), /Invalid order capacity response/);
  }
});

test('native order reads preserve queue position and unknown start, and OpenAI accepts its extension', () => {
  const generationOrder = generation.example('keyFileEvaluationOrder');
  const evaluationOrder = evaluations.example('order');
  for (const [spec, schema, wire, key, parse] of [
    [generation, 'KeyOrderResponse', generationOrder, 'order', parseGenerationOrderResponse],
    [evaluations, 'OrderResponse', evaluationOrder, 'evaluation', parseEvaluationOrder],
  ]) {
    assert.ok(!Object.hasOwn(parse(wire), 'queue_position'));
    const order = { ...wire[key], status: 'queued', status_reason: 'waiting_for_capacity', ...queue };
    const queued = { [key]: order };
    assert.deepEqual(spec.errors(schema, queued), []);
    assert.equal(parse(queued).queue_position, 1);
    assert.equal(parse(queued).estimated_start_at, null);
    delete order.estimated_start_at;
    assert.notDeepEqual(spec.errors(schema, queued), []);
    assert.throws(() => parse(queued), /Invalid order capacity response/);
  }

  const batch = openai.example('batchCreated');
  for (const reason of ['waiting_for_capacity', 'daily_capacity_reached', null]) {
    const item = { ...batch, reliquary_queue: { ...queue, reason } };
    assert.deepEqual(openai.errors('Batch', item), []);
    assert.deepEqual(openai.errors('BatchList', { ...openai.example('batchList'), data: [item] }), []);
  }
  assert.notDeepEqual(openai.errors('Batch', { ...batch, reliquary_queue: { ...queue, reason: 'unknown' } }), []);
});

test('native order lists retain queue fields and forced-draw verification', () => {
  const { refunded_usd: _refund, deliveries: _deliveries, ...order } = generation.example('keyFileEvaluationOrder').order;
  const orders = { orders: [{ ...order, status: 'queued', ...queue }] };
  assert.deepEqual(generation.errors('KeyOrdersResponse', orders), []);
  assert.equal(parseGenerationOrders(orders).orders[0].queue_position, 1);

  const { refunded_usd: _returned, files: _files, summary: _summary, generation: _generation, ...evaluation } = evaluations.example('order').evaluation;
  const listed = { evaluations: [{ ...evaluation, mode: 'subnet', status: 'queued', verification: 'draw', ...queue }] };
  assert.deepEqual(evaluations.errors('OrdersResponse', listed), []);
  const parsed = parseEvaluationOrders(listed).evaluations[0];
  assert.equal(parsed.queue_position, 1);
  assert.equal(parsed.verification, 'draw');
});
