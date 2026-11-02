import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { affineBatchPins, createAffineBatchClient, parseAffineBatchProfile, parseAffineBatchRequest, parseAffineBatchResult } from '../dist/affine-batches.js';
import { createAffinePilotTransport } from '../dist/affine-pilot.js';
import { downloadVerifiedArtifact } from './affine-pilot.mjs';
const canonical = value => JSON.stringify(value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])));

/** The approved profile and uploaded request digest must be retained independently of the receipt. */
export function verifyAffineBatchReceipt(envelope, pins, request, detail, archive) {
  assert.deepEqual(Object.keys(envelope).sort(), ['payload', 'signature', 'signer']);
  const profile = parseAffineBatchProfile(pins.affineBatch), q = parseAffineBatchRequest(request), result = parseAffineBatchResult(detail.result), r = result.receipt;
  assert.deepEqual(envelope.payload, r); assert.equal(envelope.signer, profile.receiptPublicKey);
  assert.match(envelope.signature, /^[A-Za-z0-9+/]{86}==$/);
  assert.equal(detail.task.status, 'succeeded'); assert.equal(detail.task.id, r.taskId);
  for (const k of [...affineBatchPins, 'upstreamRevision', 'masterMode', 'masterDigest', 'referenceProvenance', 'seed', 'expectedDraw', 'lastGreenDecidedAt', 'comparisonClockRule', 'jobExpiresAt']) assert.equal(r[k], profile[k], `Profile binding differs: ${k}`);
  for (const k of ['profileDigest', 'environmentDigest', 'requestSha256']) { assert.match(pins[k], /^[a-f0-9]{64}$/); assert.equal(r[k], pins[k]); }
  assert.equal(q.profileDigest, pins.profileDigest); assert.equal(q.jobDigest, profile.jobDigest); assert.equal(q.jobExpiresAt, profile.jobExpiresAt);
  assert(q.maxCostMicroUsd <= profile.maxCostMicroUsd && r.elapsedSeconds <= q.maxHours * 3600);
  assert(r.trainingResultAt <= q.jobExpiresAt && r.artifactSize <= profile.maxOutputBytes);
  assert.equal(r.artifactSize, archive.size); assert.equal(r.artifactSha256, archive.sha256);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(profile.receiptPublicKey, 'hex')]), format: 'der', type: 'spki' });
  assert(verify(null, Buffer.from(canonical(r)), publicKey, Buffer.from(envelope.signature, 'base64')), 'Receipt signature differs.');
  return { integrityVerified: true, decision: r.decision, expectedDraw: r.expectedDraw, actualDrawn: r.actualDrawn, liveParity: false, officialAcceptance: false, chainSubmission: false, nativeRewardVerified: false };
}

/** Each invocation performs only the selected stage. Start requires its separate approval and stable key. */
export async function affineBatchPilotStage(stage, input, options) {
  const client = createAffineBatchClient(createAffinePilotTransport(options).request);
  switch (stage) {
    case 'prepare': return client.prepare(input);
    case 'upload': return client.uploadRequest(input.request, input.filename, input.rightsConfirmed);
    case 'save-draft': return client.saveDraft(input.prepared, input.name, input.requestKey);
    case 'quote': return client.quote(input);
    case 'start': return client.start(input.submission, input.requestKey);
    case 'task': return client.task(input.id);
    case 'verify-delivery': {
      const detail = await client.task(input.taskId), result = parseAffineBatchResult(detail.result);
      const receiptMeta = detail.artifacts.find(v => v.id === result.receiptArtifactId), archiveMeta = detail.artifacts.find(v => v.id === result.resultArtifactId);
      assert(receiptMeta && receiptMeta.size <= 65536 && archiveMeta);
      const parts = []; await downloadVerifiedArtifact(client, input.taskId, receiptMeta, bytes => parts.push(bytes));
      const envelope = JSON.parse(Buffer.concat(parts));
      const archive = await downloadVerifiedArtifact(client, input.taskId, archiveMeta, () => {});
      return verifyAffineBatchReceipt(envelope, input.pins, input.request, detail, archive);
    }
    default: throw new Error('Choose prepare, upload, save-draft, quote, start, task or verify-delivery.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [stage, path, extra] = process.argv.slice(2); assert(stage && path && !extra, 'Usage: node examples/affine-batch-pilot.mjs STAGE INPUT.private.json');
    const info = await stat(path); assert(info.isFile() && info.size <= 32768);
    const input = JSON.parse(await readFile(path, 'utf8'));
    const output = await affineBatchPilotStage(stage, input, { apiKey: process.env.TRAINING_API_KEY, resourcesApiKey: process.env.RESOURCES_API_KEY, origin: process.env.RELIQUARY_API_URL });
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.code ?? 'invalid_workflow', status: error.status, requestId: error.requestId, retryKey: error.retryKey }) + '\n'); process.exitCode = 1;
  }
}
