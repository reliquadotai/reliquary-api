import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { affineBatchPins } from '../dist/index.js';

const h = 'a'.repeat(64), other = 'b'.repeat(64), expires = 4_000_000_000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])));
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [resolvePath('bin/reliqua.mjs'), ...args], { timeout: 15000, env: { ...process.env, RELIQUARY_TRAINING_KEY: 'fixture-training-secret', RELIQUARY_RESOURCES_KEY: 'fixture-resources-secret' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', reject);
  child.on('close', code => resolve({ code, stdout, stderr }));
});
const resolvePath = path => resolve(import.meta.dirname, '..', path);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'affine-cli-'));
  const request = { schema: 'affine-batch-request/v1', profileDigest: h, jobDigest: h, maxHours: 2, maxCostMicroUsd: 25000000, jobExpiresAt: expires };
  const config = { schemaVersion: 2, profileDigest: h, objective: 'One approved step', environment: { id: 'batch', version: '1' }, model: { id: 'fixture/model' }, optimization: { method: 'affine_batch', maxSteps: 1 }, compute: { offerId: 'fixture', gpuCount: 1, maxHours: 2, providerPolicy: 'private' }, affineBatchRequest: request, submissionMode: 'operator_funded_pilot' };
  const prepared = { request, configuration: config, mode: 'operator-funded-pilot' };
  const context = { upstreamRevision: 'a'.repeat(40), masterMode: 'bf16-bootstrap', masterDigest: null, referenceProvenance: 'published-reference', seed: 42, expectedDraw: 500, lastGreenDecidedAt: 1000, comparisonClockRule: 'actual-training-result-minus-frozen-last-green' };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const profile = { ...Object.fromEntries(affineBatchPins.map(k => [k, h])), ...context, schema: 'affine-batch-profile/v1', ownerUserId: 'fixture-owner', billingMode: 'operator-funded-pilot', receiptPublicKey: key, maxOutputBytes: 524288, maxCostMicroUsd: 25000000, jobExpiresAt: expires };
  const archive = Buffer.alloc(300000, 65);
  const receipt = { ...Object.fromEntries(affineBatchPins.map(k => [k, h])), ...context, schema: 'affine-batch-receipt/v1', taskId: 'task', profileDigest: h, requestSha256: h, environmentDigest: h, candidateDigest: other, comparisonDigest: h, artifactSha256: digest(archive), artifactSize: archive.length, elapsedSeconds: 1, jobExpiresAt: expires, stage: 'batch_comparison_completed', device: 'cuda', optimizerSteps: 1, trainingUpdated: true, finiteGradient: true, masterChanged: true, pgTokens: 3225, supportOutsideTokens: 0, actualDrawn: 507, trainingResultAt: 1000.5, actualTrainingEndedAt: 1000.5, decision: 'red', reasons: ['insufficient evidence'], gain: -0.00001, z: null, se: null, barZ: 1 - .75 * .5 / 43200, liveParity: false, officialAcceptance: false, chainSubmission: false, nativeRewardVerified: false };
  const envelope = { payload: receipt, signer: key, signature: sign(null, Buffer.from(canonical(receipt)), privateKey).toString('base64') };
  const receiptBytes = Buffer.from(JSON.stringify(envelope));
  const result = { schema: 'affine-batch-result/v1', receiptArtifactId: 'receipt', resultArtifactId: 'archive', assurance: 'signed-native-mimo-batch-comparison', receipt };
  const detail = { task: { id: 'task', status: 'succeeded', resourceId: 'draft', resourceRevision: 1, datasetId: 'dataset' }, result,
    artifacts: [{ id: 'receipt', size: receiptBytes.length, sha256: digest(receiptBytes) }, { id: 'archive', size: archive.length, sha256: digest(archive) }] };
  const state = { requests: [], mode: 'normal' };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    state.requests.push({ path: req.url, method: req.method, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    const json = value => res.end(JSON.stringify(value));
    if (state.mode === 'ambiguous' && req.method === 'POST') { res.statusCode = 408; return json({ error: { code: 'timeout' } }); }
    if (req.url === '/api/v1/training/capabilities') return json({ training: false, mode: 'operator-funded-pilot', profiles: [], reason: 'window_closed' });
    if (req.url === '/api/v1/training/affine-batch/prepare') return json(prepared);
    if (req.url === '/api/v1/training/files') return json({ file: { id: 'dataset' } });
    if (req.url === '/api/resources') return json({ resource: { id: 'draft', revision: 1, kind: 'training', name: 'Example', config } });
    if (req.url === '/api/v1/training/quotes') return json({ quote: { id: 'quote', draftId: 'draft', revision: 1, datasetId: 'dataset', expiresAt: expires, maxCostMicroUsd: 25000000 } });
    if (req.url === '/api/v1/training/tasks') return json({ task: { id: 'task', resourceId: 'draft', resourceRevision: 1, datasetId: 'dataset' } });
    if (req.url === '/api/v1/training/tasks/task') return json(detail);
    if (req.url.startsWith('/api/v1/training/tasks/task/artifacts/')) {
      const isReceipt = req.url.endsWith('/receipt');
      let bytes = isReceipt ? receiptBytes : archive;
      if (state.mode === 'corrupt-archive' && !isReceipt) bytes = Buffer.alloc(archive.length, 66);
      const range = /^bytes=([0-9]+)-([0-9]+)$/.exec(req.headers.range ?? '');
      assert(range);
      const start = Number(range[1]), end = Number(range[2]);
      assert(end - start < 262144 && end < bytes.length);
      res.statusCode = 206;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
      return res.end(bytes.subarray(start, end + 1));
    }
    res.statusCode = 404; json({ error: { code: 'not_found' } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let count = 0;
  const input = async value => { const path = join(directory, `input-${++count}.json`); await writeFile(path, JSON.stringify(value)); return path; };
  const cli = args => run(['affine', ...args, '--origin', origin, '--json']);
  const pins = { profileDigest: h, environmentDigest: h, requestSha256: h, affineBatch: profile };
  return { directory, request, prepared, state, input, cli, archive, receiptBytes, verify: { taskId: 'task', request, pins } };
}

test('staged CLI uses the qualified contract and separates data rights, launch approval and scoped keys', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const status = await f.cli(['status']); assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).training, false);
  const prep = await f.cli(['prepare', '--input', await f.input({ profileDigest: h, maxHours: 2, maxCostMicroUsd: 25000000 })]);
  assert.equal(prep.code, 0, prep.stderr); assert.deepEqual(JSON.parse(prep.stdout), f.prepared);
  const uploadFile = await f.input({ request: f.request, filename: 'batch.jsonl', rightsConfirmed: true });
  const startFile = await f.input({ submission: { draftId: 'draft', revision: 1, datasetId: 'dataset', approveExecution: true }, requestKey: 'original-start-key-123' });
  const before = f.state.requests.length;
  for (const args of [['upload', '--input', uploadFile], ['start', '--input', startFile], ['status', '--approve-execution'], ['task'], ['task', '--id', '../other'], ['start', '--input', startFile, '--approve-execution', '--approve-execution']]) {
    const r = await f.cli(args); assert.equal(r.code, 2, r.stderr); assert.equal(JSON.parse(r.stderr).error.code, 'invalid_arguments');
  }
  for (const requestKey of ['', null, false, 0, 1234567890123456]) {
    const invalidStart = await f.input({ submission: { draftId: 'draft', revision: 1, datasetId: 'dataset' }, requestKey });
    const invalidDraft = await f.input({ prepared: f.prepared, name: 'Example', requestKey });
    for (const args of [['start', '--input', invalidStart, '--approve-execution'], ['save-draft', '--input', invalidDraft]]) {
      const r = await f.cli(args); assert.equal(r.code, 2, r.stderr);
    }
  }
  assert.equal(f.state.requests.length, before);
  assert.equal((await f.cli(['upload', '--input', uploadFile, '--confirm-rights'])).code, 0);
  const draft = await f.cli(['save-draft', '--input', await f.input({ prepared: f.prepared, name: 'Example', requestKey: 'original-draft-key-123' })]); assert.equal(draft.code, 0, draft.stderr);
  const quote = await f.cli(['quote', '--input', await f.input({ draftId: 'draft', revision: 1, datasetId: 'dataset' })]); assert.equal(quote.code, 0, quote.stderr);
  const launched = await f.cli(['start', '--input', startFile, '--approve-execution']); assert.equal(launched.code, 0, launched.stderr);
  assert.equal((await f.cli(['task', '--id', 'task'])).code, 0);
  const writes = f.state.requests.filter(r => r.method === 'POST');
  assert.equal(writes.length, 5);
  assert.equal(writes.find(r => r.path === '/api/resources').headers.authorization, 'Bearer fixture-resources-secret');
  assert(writes.filter(r => r.path !== '/api/resources').every(r => r.headers.authorization === 'Bearer fixture-training-secret'));
  assert.equal(writes.find(r => r.path.endsWith('/files')).body, JSON.stringify(f.request) + '\n');
  assert.equal(writes.find(r => r.path.endsWith('/tasks')).headers['idempotency-key'], 'original-start-key-123');
  assert.equal(JSON.parse(writes.find(r => r.path.endsWith('/tasks')).body).approveExecution, true);
  f.state.mode = 'ambiguous'; const count = f.state.requests.length;
  const unknown = await f.cli(['start', '--input', startFile, '--approve-execution']);
  assert.equal(unknown.code, 1); assert.equal(f.state.requests.length, count + 1);
  assert.equal(JSON.parse(unknown.stderr).error.code, 'outcome_unknown');
  assert.equal(JSON.parse(unknown.stderr).error.retryKey, 'original-start-key-123');
  assert(!unknown.stderr.includes('fixture-training-secret'));
});

test('delivery verifies retained signature/pins and streams a private result without overwriting user files', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = await f.input(f.verify);
  const verified = await f.cli(['verify-delivery', '--input', input]); assert.equal(verified.code, 0, verified.stderr);
  const v = JSON.parse(verified.stdout); assert.equal(v.integrityVerified, true); assert.equal(v.decision, 'red'); assert.equal(v.officialAcceptance, false);
  const target = join(f.directory, 'delivery');
  const downloaded = await f.cli(['download', '--input', input, '--directory', target]); assert.equal(downloaded.code, 0, downloaded.stderr);
  assert.deepEqual(await readFile(join(target, 'result.zip')), f.archive);
  assert.deepEqual(await readFile(join(target, 'receipt.json')), f.receiptBytes);
  assert.equal(JSON.parse(await readFile(join(target, 'verification.json'))).integrityVerified, true);
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  for (const file of ['result.zip', 'receipt.json', 'verification.json']) assert.equal((await stat(join(target, file))).mode & 0o777, 0o600);
  const existing = await f.cli(['download', '--input', input, '--directory', target]); assert.equal(existing.code, 1);
  assert.deepEqual(await readFile(join(target, 'result.zip')), f.archive);
  f.state.mode = 'corrupt-archive';
  const failedTarget = join(f.directory, 'corrupt');
  const corrupt = await f.cli(['download', '--input', input, '--directory', failedTarget]); assert.equal(corrupt.code, 1);
  await assert.rejects(stat(failedTarget), e => e.code === 'ENOENT');
  f.state.mode = 'normal';
  const before = f.state.requests.length;
  const wrongPins = await f.input({ ...f.verify, pins: { ...f.verify.pins, requestSha256: other } });
  const mismatch = await f.cli(['download', '--input', wrongPins, '--directory', join(f.directory, 'mismatch')]);
  assert.equal(mismatch.code, 1);
  assert(f.state.requests.slice(before).every(r => !r.path.endsWith('/archive')));
});

test('CLI rejects oversized, symlinked or unexpected input before making a request', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const oversized = join(f.directory, 'oversized.json'); await writeFile(oversized, ' '.repeat(32769));
  const file = await f.input({ profileDigest: h, maxHours: 2, maxCostMicroUsd: 25000000 });
  const link = join(f.directory, 'link.json'); await symlink(file, link);
  const dir = join(f.directory, 'not-a-file'); await mkdir(dir);
  for (const path of [oversized, link, dir, await f.input({ profileDigest: h, maxHours: 2, maxCostMicroUsd: 25000000, secret: 'must-not-be-sent' })]) {
    const r = await f.cli(['prepare', '--input', path]); assert.equal(r.code, 2, r.stderr);
  }
  assert.equal(f.state.requests.length, 0);
});
