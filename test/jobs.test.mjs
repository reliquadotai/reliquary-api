import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseJob, parseJobClaim, parseJobsPage, parseJobCapabilities, parseJobInputUpload, parseJobCreateInput,
  parseDatasetValidationReport, validateJobDatasetContent, validateDatasetBytes,
  jobRequests, createJobsClient, createJobsTransport, JobApiError,
  createSubnetTaskClient, parseSubnetManifest,
  WORKLOAD_DEFINITIONS,
} from '../dist/index.js';

const execFile = promisify(callbackExecFile);
const uuid = '11111111-1111-4111-8111-111111111111';
const unit = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const workerId = '44444444-4444-4444-8444-444444444444';
const requestKey = '55555555-5555-4555-8555-555555555555';
const now = 1800000000000;
const id = 'cpu:' + uuid;
const content = '{"text":"example"}\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const input = { dataset_id: uuid, sha256: sha256(content), format: 'corpus', size_bytes: Buffer.byteLength(content) };
const spec = { kind: 'dataset_validation', input, limits: { deadline_seconds: 300, max_attempts: 2 } };
const job = {
  schema_version: 1, id, kind: 'dataset_validation', source_ref: { type: 'dataset_validation', id: uuid }, state: 'queued', native_phase: null,
  revision: '1', spec_sha256: sha256(JSON.stringify(spec)), spec, current_attempt_id: null,
  work_units: [{ id: unit, job_id: id, state: 'queued', attempt_ids: [], artifact_ids: [] }], attempts: [], artifacts: [],
  created_at: now, updated_at: now, finished_at: null,
};
const attempt = { id: attemptId, job_id: id, work_unit_id: unit, attempt_number: 1, worker_id: workerId, fence: 1, state: 'running', lease_expires_at: now + 60000, heartbeat_at: now, started_at: now, finished_at: null, error_code: null };
const running = { ...job, state: 'running', current_attempt_id: attemptId, work_units: [{ ...job.work_units[0], state: 'running', attempt_ids: [attemptId] }], attempts: [attempt] };
const capability = { kind: 'dataset_validation', input_formats: ['instruction', 'preference', 'corpus'], execution: 'cpu', attempts_supported: true, controls: ['pause', 'resume', 'cancel'], can_submit: false, reason: 'Feature disabled.', enrolled_workers: 0, live_workers: 0, qualified_workers: 0, queued_jobs: 0, running_jobs: 0, oldest_queued_at: null };
const caps = { schema_version: 1, workloads: [capability] };
const manifest = { name: 'Example task', model: 'example-model', modelRevision: 'example-revision', checkpointSha256: 'a'.repeat(64), environment: 'example-env', environmentSha256: 'b'.repeat(64), promptStart: 0, promptCount: 1, samplesPerPrompt: 1, maxNewTokens: 32, thinking: false, incentiveCap: 0, deadlineSeconds: 300 };
const native = { ...job, id: 'subnet:' + uuid, kind: 'corpus_generation', source_ref: { type: 'subnet_task', id: uuid }, native_phase: 'queued', revision: 'c'.repeat(64), spec: { kind: 'corpus_generation', manifest }, work_units: [] };

test('job projection distinguishes native sources from actual CPU work units and attempts', () => {
  assert.deepEqual(parseJob(job), job);
  assert.deepEqual(parseJob(running), running);
  assert.deepEqual(parseJob(native), native);
  assert.throws(() => parseJobsPage({ schema_version: 1, jobs: [native], next_cursor: null }));
  assert.deepEqual(parseJobsPage({ schema_version: 1, jobs: [native], next_cursor: null }, 'browser').jobs, [native]);
  for (const changed of [
    { ...job, id: '../task' }, { ...job, source_ref: { ...job.source_ref, id: workerId } }, { ...native, attempts: [attempt] },
    { ...job, kind: 'corpus_generation' }, { ...job, current_attempt_id: attemptId }, { ...job, state: 'succeeded' },
    { ...running, attempts: [{ ...attempt, fence: 0 }] }, { ...running, attempts: [{ ...attempt, work_unit_id: workerId }] },
    { ...running, attempts: [attempt, attempt] }, { ...running, attempts: [{ ...attempt, heartbeat_at: now - 1 }] },
  ]) assert.throws(() => parseJob(changed));
});

test('claim binds private lease credentials to the exact currently running attempt', () => {
  const claim = { schema_version: 1, job: running, attempt: { ...attempt, lease_token: 'x'.repeat(48) } };
  assert.deepEqual(parseJobClaim(claim), claim);
  assert.deepEqual(parseJobClaim({ schema_version: 1, job: null, attempt: null }), { schema_version: 1, job: null, attempt: null });
  for (const a of [{ ...claim.attempt, fence: 2 }, { ...claim.attempt, lease_token: 'short' }, { ...claim.attempt, work_unit_id: workerId }]) assert.throws(() => parseJobClaim({ ...claim, attempt: a }));
  assert.throws(() => parseJobClaim({ ...claim, job }));
  assert.throws(() => parseJobClaim({ ...claim, job: null }));
});

test('capabilities keep authorization, fresh qualified workers and bounded backlog separate', () => {
  assert.deepEqual(WORKLOAD_DEFINITIONS.map(w => [w.kind, w.recovery_mode]), [['dataset_validation', 'restart_safe'], ['corpus_generation', 'native_managed']]);
  assert(Object.isFrozen(WORKLOAD_DEFINITIONS));
  assert.deepEqual(parseJobCapabilities(caps), caps);
  assert.equal(parseJobCapabilities({ ...caps, workloads: [{ ...capability, can_submit: true, queued_jobs: 1, oldest_queued_at: now }] }).workloads[0].qualified_workers, 0);
  for (const change of [{ qualified_workers: 1 }, { live_workers: 1 }, { queued_jobs: 1 }, { queued_jobs: 5, running_jobs: 4, oldest_queued_at: now }]) assert.throws(() => parseJobCapabilities({ ...caps, workloads: [{ ...capability, ...change }] }));
});

test('JSONL validation preserves existing format semantics, UTF8 digest and safe bounded errors', async () => {
  const report = await validateJobDatasetContent(content, 'corpus');
  assert.deepEqual(report, { schema_version: 1, input_sha256: input.sha256, format: 'corpus', rows: 1, valid: true, errors: [] });
  assert.deepEqual(parseDatasetValidationReport(report), report);
  for (const [format, data] of [['instruction', '{"prompt":"p","response":"r"}\n'], ['preference', '{"prompt":"p","chosen":"a","rejected":"b"}\n']]) assert.equal((await validateJobDatasetContent(data, format)).valid, true);
  for (const data of ['{"text":"   "}', '{"text":"x","extra":"x"}', '[]', 'null', 'invalid', '\n  \n', JSON.stringify({ text: 'x'.repeat(32001) })]) {
    const result = await validateJobDatasetContent(data, 'corpus');
    assert.equal(result.valid, false); parseDatasetValidationReport(result);
  }
  const secret = 'PRIVATE_TEST_CONTENT_9347';
  assert.equal(JSON.stringify(await validateJobDatasetContent(JSON.stringify({ secret }), 'corpus')).includes(secret), false);
  const badUTF8 = await validateDatasetBytes(new Uint8Array([255]), 'corpus', 32768);
  assert.deepEqual(badUTF8.errors, [{ line: 0, code: 'invalid_utf8' }]); parseDatasetValidationReport(badUTF8);
  const many = await validateJobDatasetContent('invalid\n'.repeat(30), 'corpus');
  assert.equal(many.errors.length, 20);
  const bom = new Uint8Array([239, 187, 191, ...new TextEncoder().encode(content)]);
  const bomReport = await validateDatasetBytes(bom, 'corpus', 32768);
  assert.equal(bomReport.valid, true); assert.equal(bomReport.input_sha256, sha256(bom));
  assert.throws(() => parseDatasetValidationReport({ ...report, valid: false }));
});

test('input, request builders and pagination accept exact byte bounds and reject traversal or unrelated authority', () => {
  const boundary = '\n'.repeat(32768);
  assert.equal(parseJobInputUpload({ schema_version: 1, format: 'corpus', content: boundary }).content.length, 32768);
  assert.throws(() => parseJobInputUpload({ schema_version: 1, format: 'corpus', content: 'é'.repeat(16385) }));
  assert.throws(() => parseJobCreateInput({ schema_version: 1, spec: { kind: 'corpus_generation', manifest } }));
  const requests = jobRequests();
  assert.equal(requests.detail(id).path, '/api/v1/jobs/cpu%3A' + uuid);
  assert.equal(requests.list({ cursor: 'opaque_cursor', limit: 25 }).path, '/api/v1/jobs?cursor=opaque_cursor&limit=25');
  for (const bad of ['../admin', 'cpu:' + uuid + '/cancel', 'subnet:' + uuid]) assert.throws(() => requests.detail(bad));
  for (const bad of [{ cursor: '../key' }, { limit: 101 }, { limit: NaN }, { token: 'key' }]) assert.throws(() => requests.list(bad));
  assert.throws(() => requests.create({ schema_version: 1, spec }, 'new-key'));
  assert.throws(() => requests.control('subnet:' + uuid, 'cancel', { schema_version: 1, revision: '1', reason: 'Review cancellation.' }, requestKey));
});

test('uncertain mutations preserve original idempotency and revision without retries', async () => {
  let calls = 0;
  const client = createJobsClient(async () => { calls++; return {}; });
  await assert.rejects(client.create({ schema_version: 1, spec }, requestKey), e => e instanceof JobApiError && e.code === 'outcome_unknown' && e.requestKey === requestKey);
  await assert.rejects(client.control(id, 'pause', { schema_version: 1, revision: '7', reason: 'Review pause.' }, requestKey), e => e.code === 'outcome_unknown' && e.requestKey === requestKey && e.revision === '7');
  assert.equal(calls, 2);
  const refusal = Object.assign(new Error('refused'), { status: 403 });
  await assert.rejects(createJobsClient(async () => { throw refusal; }).create({ schema_version: 1, spec }, requestKey), e => e === refusal);
  const timeout = createJobsClient(async () => { throw Object.assign(new Error('timed out'), { status: 408 }); });
  await assert.rejects(timeout.create({ schema_version: 1, spec }, requestKey), e => e.code === 'outcome_unknown' && e.requestKey === requestKey);
  const wrong = createJobsClient(async () => ({ schema_version: 1, job: { ...job, spec: { ...spec, limits: { ...spec.limits, max_attempts: 1 } } } }));
  await assert.rejects(wrong.create({ schema_version: 1, spec }, requestKey), e => e.code === 'outcome_unknown');
  const badUpload = createJobsClient(async () => ({ schema_version: 1, input: { ...input, sha256: 'a'.repeat(64) } }));
  await assert.rejects(badUpload.uploadInput({ schema_version: 1, format: 'corpus', content }, requestKey), e => e.code === 'outcome_unknown' && e.requestKey === requestKey);
});

test('native common controls require the browser administrator transport and exact native revision', async () => {
  const calls = [];
  const client = createJobsClient(async (path, init) => { calls.push({ path, init }); return { schema_version: 1, job: native }; }, { audience: 'browser' });
  const input = { schema_version: 1, revision: native.revision, reason: 'Reviewed pause.' };
  await client.control(native.id, 'pause', input, requestKey);
  assert.equal(calls[0].path, '/api/jobs/subnet%3A' + uuid + '/pause');
  assert.equal(calls[0].init.headers['X-Resource-Revision'], native.revision);
  assert.equal(calls[0].init.headers['Idempotency-Key'], requestKey);
  assert.deepEqual(JSON.parse(calls[0].init.body), input);
  const keyClient = createJobsClient(async () => { throw new Error('Should not call key transport.'); });
  assert.throws(() => keyClient.control(native.id, 'pause', input, requestKey), e => e.code === 'unsupported_workload');
  assert.throws(() => client.control(native.id, 'resume', { ...input, revision: '1' }, requestKey));
});

test('operator client preserves canonical native inputs and delegates wallet action proof to browser transport', async () => {
  const run = { id: uuid, name: manifest.name, status: 'queued', revision: 'c'.repeat(64), manifestSha256: 'd'.repeat(64), manifest,
    native: { jobId: 'example-job', taskId: 'example-task', manifestSha256: 'e'.repeat(64), profileSha256: 'f'.repeat(64), minerEndpoint: null }, progress: null, deliveries: [], createdAt: now, updatedAt: now, reason: null };
  const seen = [];
  const client = createSubnetTaskClient(async (path, init, confirmation) => { seen.push({ path, init, confirmation }); return { run }; });
  assert.deepEqual(await client.launch(manifest, requestKey), run);
  assert.deepEqual(JSON.parse(seen[0].init.body), { schemaVersion: 1, requestId: requestKey, manifest: parseSubnetManifest(manifest) });
  assert.equal(seen[0].init.headers['Idempotency-Key'], requestKey);
  assert.match(seen[0].confirmation, /exact launch inputs/);
  await client.cancel(run, 'Reviewed cancellation.');
  assert.equal(seen[1].init.headers['X-Resource-Revision'], run.revision);
  assert.match(seen[1].confirmation, /In-flight submissions must drain/);
  const broken = createSubnetTaskClient(async () => ({ run: { ...run, manifest: { ...manifest, thinking: true } } }));
  await assert.rejects(broken.launch(manifest, requestKey), e => e.code === 'outcome_unknown' && e.retryKey === requestKey && e.message === 'The launch receipt did not match the reviewed task. Retry the same confirmation.');
  const wrongCancel = createSubnetTaskClient(async () => ({ run: { ...run, id: requestKey } }));
  await assert.rejects(wrongCancel.cancel(run, 'Reviewed cancellation.'), e => e.code === 'outcome_unknown' && e.retryKey === undefined && e.message === 'The cancellation receipt did not match this task. Refresh its state.');
});

test('clean packed client and CLI use real loopback protocol, safe key authority and explicit writes', async () => {
  const seen = [];
  const worker = { id: requestKey, name: 'Example worker', expires_at: now + 600000, revoked_at: null, last_seen_at: null, qualified_at: null };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', bytes => { body += bytes; });
    request.on('end', () => {
      seen.push({ path: request.url, method: request.method, headers: request.headers, body });
      response.setHeader('Content-Type', 'application/json');
      const path = request.url.split('?')[0];
      let output;
      if (path.endsWith('/capabilities')) output = caps;
      else if (path === '/api/v1/job-inputs') { const parsed = JSON.parse(body); output = { schema_version: 1, input: { ...input, sha256: sha256(parsed.content), size_bytes: Buffer.byteLength(parsed.content) } }; }
      else if (path === '/api/v1/job-workers' && request.method === 'GET') output = { schema_version: 1, workers: [], next_cursor: null };
      else if (path === '/api/v1/job-workers' && request.method === 'POST') output = { schema_version: 1, worker, token: 'x'.repeat(48) };
      else if (path.endsWith('/revoke')) output = { schema_version: 1, worker: { ...worker, revoked_at: now } };
      else if (path.endsWith('/events')) output = { schema_version: 1, events: [], next_cursor: null };
      else if (path.endsWith('/artifacts/report-a')) {
        const report = { schema_version: 1, input_sha256: input.sha256, format: 'corpus', rows: 1, valid: true, errors: [] };
        const data = JSON.stringify(report);
        output = { schema_version: 1, artifact: { id: 'report-a', job_id: id, work_unit_id: unit, attempt_id: attemptId, kind: 'validation_report', name: 'validation.json', size_bytes: Buffer.byteLength(data), sha256: sha256(data), content_type: 'application/json', created_at: now }, report };
      }
      else if (path === '/api/v1/jobs' && request.method === 'GET') output = { schema_version: 1, jobs: [job], next_cursor: null };
      else output = { schema_version: 1, job };
      response.end(JSON.stringify(output));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'job-client-test-'));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const client = createJobsClient(createJobsTransport({ origin, apiKey: 'fixture-key' }).request);
    await client.capabilities(); await client.list({ limit: 25 }); await client.detail(id); await client.events(id);
    await client.uploadInput({ schema_version: 1, format: 'corpus', content: '\n'.repeat(32768) }, requestKey);
    await client.uploadInput({ schema_version: 1, format: 'corpus', content: 'é'.repeat(16384) }, requestKey);
    await client.create({ schema_version: 1, spec }, requestKey);
    assert.equal((await client.artifact(id, 'report-a')).report.input_sha256, input.sha256);
    await client.control(id, 'pause', { schema_version: 1, revision: '1', reason: 'Reviewed pause.' }, requestKey);
    await client.workers(); await client.enrollWorker({ schema_version: 1, name: worker.name, ttl_seconds: 600 }, requestKey);
    await client.revokeWorker(worker.id, 'Reviewed revoke.', requestKey);
    assert(seen.every(r => r.headers.authorization === 'Bearer fixture-key' && !r.headers.cookie));
    assert.equal(seen.find(r => r.path.endsWith('/pause')).headers['x-resource-revision'], '1');
    assert.equal(JSON.parse(seen.find(r => r.path === '/api/v1/job-inputs').body).content.length, 32768);
    const repo = new URL('..', import.meta.url).pathname;
    const packed = await execFile('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', root], { cwd: repo });
    const tarball = join(root, packed.stdout.trim());
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await execFile('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: root });
    const cli = join(root, 'node_modules/@reliquary/api/bin/jobctl.mjs');
    const env = { ...process.env, JOBS_API_KEY: 'fixture-key', JOBS_API_ORIGIN: origin };
    const listed = await execFile(process.execPath, [cli, 'list'], { cwd: root, env });
    assert.deepEqual(JSON.parse(listed.stdout).jobs, [job]);
    const file = join(root, 'request.json'); await writeFile(file, JSON.stringify({ schema_version: 1, spec }));
    const before = seen.length;
    await assert.rejects(execFile(process.execPath, [cli, 'submit', '--file', file, '--request-key', requestKey], { cwd: root, env }), e => /--confirm/.test(e.stderr));
    assert.equal(seen.length, before);
    const created = await execFile(process.execPath, [cli, 'submit', '--file', file, '--request-key', requestKey, '--confirm'], { cwd: root, env });
    assert.deepEqual(JSON.parse(created.stdout), job);
    const readOnly = await execFile(process.execPath, ['--input-type=module', '-e', 'import {jobRequests,parseJob} from "@reliquary/api/jobs"; console.log(JSON.stringify(jobRequests().list()))'], { cwd: root });
    assert.deepEqual(JSON.parse(readOnly.stdout), { path: '/api/v1/jobs' });
    const definitions = await execFile(process.execPath, [cli, 'definitions'], { cwd: root, env: { ...env, JOBS_API_KEY: '', JOBS_API_ORIGIN: 'invalid' } });
    assert.deepEqual(JSON.parse(definitions.stdout), WORKLOAD_DEFINITIONS);
    assert.equal((await readFile(join(root, 'node_modules/@reliquary/api/contracts/generation.openapi.json'))).toString(), (await readFile(new URL('../contracts/generation.openapi.json', import.meta.url))).toString());
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('key transport refuses private/native routes and safely classifies bounded ambiguous mutations', async () => {
  let calls = 0;
  const transport = createJobsTransport({ apiKey: 'fixture-key', fetch: async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }); } });
  for (const path of ['/api/internal/job-workers/claim', '/api/admin/subnet/tasks', '/api/v1/jobs/subnet%3A' + uuid, '/api/v1/jobs?token=secret', '/api/v1/jobs?cursor=a&cursor=b', '/api/v1/jobs/cpu%3A' + uuid + '/../../admin']) await assert.rejects(transport.request(path), e => e.code === 'invalid_route');
  assert.equal(calls, 0);
  await assert.rejects(transport.request('/api/v1/jobs', { method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: '{}' }), e => e.code === 'outcome_unknown' && e.requestKey === requestKey);
  assert.equal(calls, 1);
  const timeout = createJobsTransport({ apiKey: 'fixture-key', fetch: async () => new Response('', { status: 408 }) });
  await assert.rejects(timeout.request('/api/v1/jobs', { method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: '{}' }), e => e.code === 'outcome_unknown');
  const bounded = createJobsTransport({ apiKey: 'fixture-key', fetch: async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)) });
  await assert.rejects(bounded.request('/api/v1/jobs'), e => e.code === 'response_too_large');
  await assert.rejects(bounded.request('/api/v1/jobs', { method: 'POST', headers: { 'Idempotency-Key': requestKey, 'X-Resource-Revision': '7' }, body: '{}' }), e => e.code === 'outcome_unknown' && e.requestKey === requestKey && e.revision === '7');
});
