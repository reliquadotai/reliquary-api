import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAffinePilotClient, createAffinePilotTransport } from '../dist/affine-pilot.js';

const canonical = value => JSON.stringify(value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])));

/** Stream to the caller's sink; never allocate the entire result archive. */
export async function downloadVerifiedArtifact(client, taskId, metadata, sink) {
  assert.match(metadata.id, /^[\w-]{1,64}$/);
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(metadata.size) && metadata.size > 0 && metadata.size <= 5 * 1024 ** 3);
  const digest = createHash('sha256');
  for (let offset = 0; offset < metadata.size;) {
    const maxBytes = Math.min(262144, metadata.size - offset);
    const bytes = await client.artifact(taskId, metadata.id, { offset, maxBytes });
    assert.equal(bytes.length, maxBytes, 'Incomplete artifact range.');
    digest.update(bytes); await sink(bytes); offset += bytes.length;
  }
  assert.equal(digest.digest('hex'), metadata.sha256, 'Artifact digest differs.');
  return { sha256: metadata.sha256, size: metadata.size };
}

/** Pins must come from the independently retained approved profile, never the envelope. */
export function verifyAffineReceipt(envelope, pins, request, detail, archive) {
  assert.deepEqual(Object.keys(envelope).sort(), ['payload', 'signature', 'signer']);
  assert.match(pins.receiptPublicKey, /^[a-f0-9]{64}$/);
  assert.equal(envelope.signer, pins.receiptPublicKey);
  assert.match(envelope.signature, /^[A-Za-z0-9+/]{86}==$/);
  const r = envelope.payload;
  assert.equal(r.schema, 'affine-native-evaluation-receipt/v1');
  assert.equal(r.stage, 'evaluation_completed');
  for (const name of ['nativeParityVerified', 'operatorAccepted', 'nativeRewardVerified', 'chainTransactions']) assert.equal(r[name], false);
  assert.equal(detail.task.status, 'succeeded');
  assert.equal(detail.result.schema, 'affine-native-evaluation-result/v1');
  assert.equal(detail.result.assurance, r.assurance);
  assert.deepEqual(detail.result.receipt, r);
  for (const name of ['profileDigest', 'jobDigest', 'nativeJobExpiresAt']) assert.equal(r[name], request[name]);
  for (const name of ['sourceClosureDigest', 'runtimeDigest', 'inputInventoryDigest', 'checkpointInventoryDigest', 'environmentDigest', 'assurance', 'requestSha256']) assert.equal(r[name], pins[name]);
  for (const name of ['profileDigest', 'requestSha256', 'environmentDigest', 'jobDigest', 'sourceClosureDigest', 'runtimeDigest', 'inputInventoryDigest', 'checkpointInventoryDigest', 'outputInventoryDigest', 'nativeResultDigest', 'artifactSha256']) assert.match(r[name], /^[a-f0-9]{64}$/);
  assert.equal(r.taskId, detail.task.id);
  assert(Number.isSafeInteger(r.elapsedSeconds) && r.elapsedSeconds >= 0 && r.elapsedSeconds <= request.maxHours * 3600);
  assert.equal(r.artifactSize, archive.size); assert.equal(r.artifactSha256, archive.sha256);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pins.receiptPublicKey, 'hex')]), format: 'der', type: 'spki' });
  assert(verify(null, Buffer.from(canonical(r)), publicKey, Buffer.from(envelope.signature, 'base64')), 'Receipt signature differs.');
  return { integrityVerified: true, nativeParityVerified: false, operatorAccepted: false, nativeRewardVerified: false, chainTransactions: false };
}

/** Execute one explicitly selected stage. Persist outputs and original keys privately between stages. */
export async function affinePilotStage(stage, input, options) {
  const client = createAffinePilotClient(createAffinePilotTransport(options).request);
  switch (stage) {
    case 'status': return client.status();
    case 'review': return client.review(input);
    case 'prepare': return client.prepare(input);
    case 'preparation': return client.preparation(input.id);
    case 'evaluation-prepare': return client.evaluationPrepare(input);
    case 'upload': return client.uploadRequest(input.request, input.filename, input.rightsConfirmed);
    case 'save-draft': return client.saveDraft(input.prepared, input.name, input.requestKey);
    case 'quote': return client.quote(input);
    case 'start': return client.start(input.submission, input.requestKey);
    case 'task': return client.task(input.id);
    case 'verify-delivery': {
      const detail = await client.task(input.taskId);
      assert.equal(detail.task.id, input.taskId);
      const result = detail.result;
      assert.equal(result?.schema, 'affine-native-evaluation-result/v1');
      assert.notEqual(result.receiptArtifactId, result.resultArtifactId);
      const receiptMeta = detail.artifacts.find(a => a.id === result.receiptArtifactId);
      const archiveMeta = detail.artifacts.find(a => a.id === result.resultArtifactId);
      assert(receiptMeta && receiptMeta.size <= 65536 && archiveMeta);
      const parts = [];
      await downloadVerifiedArtifact(client, input.taskId, receiptMeta, bytes => parts.push(bytes));
      const envelope = JSON.parse(Buffer.concat(parts));
      const archive = await downloadVerifiedArtifact(client, input.taskId, archiveMeta, () => {});
      return verifyAffineReceipt(envelope, input.pins, input.request, detail, archive);
    }
    default: throw new Error('Choose status, review, prepare, preparation, evaluation-prepare, upload, save-draft, quote, start, task or verify-delivery.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [stage, path, extra] = process.argv.slice(2);
    assert(stage && path && !extra, 'Usage: node examples/affine-pilot.mjs STAGE INPUT.private.json');
    const info = await stat(path); assert(info.isFile() && info.size <= 32768);
    const input = JSON.parse(await readFile(path, 'utf8'));
    const result = await affinePilotStage(stage, input, { apiKey: process.env.TRAINING_API_KEY, resourcesApiKey: process.env.RESOURCES_API_KEY, origin: process.env.RELIQUARY_API_URL });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.code ?? 'invalid_workflow', status: error.status, requestId: error.requestId, retryKey: error.retryKey }) + '\n');
    process.exitCode = 1;
  }
}
