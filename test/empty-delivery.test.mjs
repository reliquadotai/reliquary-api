import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {downloadDelivery} from '../dist/batch-node.js';

test('empty delivery files are created, hash verified and reused without a request', async () => {
  const emptySha256 = createHash('sha256').digest('hex');
  const directory = await mkdtemp(join(tmpdir(), 'empty-delivery-'));
  const order = {deliveries: [{delivery_id: 'delivery-empty', files: [
    {name: 'errors.jsonl', size: 0, sha256: emptySha256, url: '/api/v1/dataset-orders/order-a/deliveries/delivery-empty/files/errors.jsonl'},
  ]}]};
  const transport = {stream() { throw new Error('An empty file does not need a request.'); }};
  const [file] = await downloadDelivery(transport, order, directory);
  assert.equal(file.verified, true);
  assert.equal((await readFile(join(directory, 'delivery-empty', 'errors.jsonl'))).length, 0);
  assert.equal((await downloadDelivery(transport, order, directory))[0].verified, true);
});
