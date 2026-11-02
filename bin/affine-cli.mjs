import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { affineBatchRequests, createAffineBatchClient, parseAffineBatchProfile, parseAffineBatchRequest, parseAffineBatchResult } from '../dist/affine-batches.js';
import { createAffinePilotClient, createAffinePilotTransport } from '../dist/affine-pilot.js';
import { downloadVerifiedArtifact } from '../examples/affine-pilot.mjs';
import { verifyAffineBatchReceipt } from '../examples/affine-batch-pilot.mjs';

export class UsageError extends Error { code = 'invalid_arguments'; }
const fail = message => { throw new UsageError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key)))
    fail('The input fields do not match this stage. See the Affine CLI guide.');
}

async function readInput(path) {
  if (typeof path !== 'string') fail('--input requires a JSON file.');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > 32768) fail('Use a regular JSON file of at most 32 KiB.');
    const buffer = Buffer.alloc(32769);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 32768) fail('Use a JSON file of at most 32 KiB.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    fail('Use a readable regular JSON file of at most 32 KiB.');
  } finally { await file?.close(); }
}

function verificationInput(input) {
  fields(input, ['taskId', 'request', 'pins']);
  fields(input.pins, ['profileDigest', 'environmentDigest', 'requestSha256', 'affineBatch']);
  for (const key of ['profileDigest', 'environmentDigest', 'requestSha256'])
    if (!/^[a-f0-9]{64}$/.test(input.pins[key])) fail('Retain the approved profile, environment and original uploaded request digests.');
  parseAffineBatchProfile(input.pins.affineBatch);
  parseAffineBatchRequest(input.request);
  affineBatchRequests.task(input.taskId);
}

async function delivery(client, input, directory) {
  const detail = await client.task(input.taskId);
  const result = parseAffineBatchResult(detail.result);
  const receiptMeta = detail.artifacts.find(item => item.id === result.receiptArtifactId);
  const archiveMeta = detail.artifacts.find(item => item.id === result.resultArtifactId);
  assert(receiptMeta && receiptMeta.size <= 65536 && archiveMeta, 'Missing delivery artifacts.');
  const parts = [];
  await downloadVerifiedArtifact(client, input.taskId, receiptMeta, bytes => parts.push(bytes));
  const receiptBytes = Buffer.concat(parts), envelope = JSON.parse(receiptBytes);
  // Verify the signature and retained bindings before streaming a potentially large archive.
  verifyAffineBatchReceipt(envelope, input.pins, input.request, detail, archiveMeta);
  let target, archive, created = false;
  try {
    if (directory !== undefined) {
      target = resolve(directory);
      await mkdir(target, { mode: 0o700 });
      created = true;
      await writeFile(join(target, 'receipt.json'), receiptBytes, { flag: 'wx', mode: 0o600 });
      archive = await open(join(target, 'result.zip.part'), 'wx', 0o600);
    }
    const downloaded = await downloadVerifiedArtifact(client, input.taskId, archiveMeta, bytes => archive?.writeFile(bytes));
    const verified = verifyAffineBatchReceipt(envelope, input.pins, input.request, detail, downloaded);
    if (archive) { await archive.sync(); await archive.close(); archive = undefined; }
    const output = { taskId: input.taskId, ...verified, archive: downloaded, ...(target ? { directory: target } : {}) };
    if (target) {
      await rename(join(target, 'result.zip.part'), join(target, 'result.zip'));
      await writeFile(join(target, 'verification.json'), JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return output;
  } catch (error) {
    await archive?.close().catch(() => {});
    if (created) await rm(target, { recursive: true, force: true });
    throw error;
  }
}

/** One selected stage per invocation; never poll, provision hardware or retry a mutation. */
export async function affineCommand(stage, options, transportOptions) {
  if (stage === 'upload' && options['confirm-rights'] !== true) fail('Uploading requires --confirm-rights for this request.');
  if (stage === 'start' && options['approve-execution'] !== true) fail('Launching requires --approve-execution for this exact submission.');
  const input = ['status', 'task'].includes(stage) ? undefined : await readInput(options.input);
  let submission;
  try {
    switch (stage) {
      case 'status': break;
      case 'task': affineBatchRequests.task(options.id); break;
      case 'prepare': affineBatchRequests.prepare(input); break;
      case 'upload':
        fields(input, ['request', 'filename'], ['rightsConfirmed']);
        if (input.rightsConfirmed !== undefined && input.rightsConfirmed !== true) fail('The input does not confirm data rights.');
        affineBatchRequests.uploadRequest(input.request, input.filename, true); break;
      case 'save-draft': fields(input, ['prepared', 'name', 'requestKey']); affineBatchRequests.saveDraft(input.prepared, input.name, input.requestKey); break;
      case 'quote': affineBatchRequests.quote(input); break;
      case 'start':
        fields(input, ['submission', 'requestKey']);
        if (!object(input.submission) || (input.submission.approveExecution !== undefined && input.submission.approveExecution !== true)) fail('The input does not approve this submission.');
        submission = { ...input.submission, approveExecution: true };
        affineBatchRequests.start(submission, input.requestKey); break;
      case 'verify-delivery': case 'download': verificationInput(input); break;
      default: fail('Unknown Affine stage. Run reliqua --help.');
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    fail('Invalid stage input. Use the returned IDs, retained pins and stable request key.');
  }
  if (stage === 'download' && typeof options.directory !== 'string') fail('Downloading requires a new --directory.');
  const transport = createAffinePilotTransport(transportOptions);
  const client = createAffineBatchClient(transport.request);
  switch (stage) {
    case 'status': return createAffinePilotClient(transport.request).capabilities();
    case 'prepare': return client.prepare(input);
    case 'upload': return client.uploadRequest(input.request, input.filename, true);
    case 'save-draft': return client.saveDraft(input.prepared, input.name, input.requestKey);
    case 'quote': return client.quote(input);
    case 'start': return client.start(submission, input.requestKey);
    case 'task': return client.task(options.id);
    case 'verify-delivery': case 'download': return delivery(client, input, stage === 'download' ? options.directory : undefined);
  }
}

