import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEvaluationClient, GenerationApiError, verifyEvaluationProtocol } from '../dist/index.js';
import { runCheckpointEvaluation, boundedRead, downloadEvaluationReport } from '../examples/evaluate-checkpoint.mjs';
import { appendCheckpointBenchmarks, exportCheckpointBenchmarks, verifyCheckpointPublication } from '../examples/export-checkpoint-benchmarks.mjs';
import { fixture, sha } from './evaluation-fixture.mjs';

const context = '1'.repeat(64);
async function privateDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'checkpoint-'));
  await chmod(dir, 0o700); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
const fileTransport = f => ({ download: async (id, name, { offset, maxBytes }) => ({ bytes: Buffer.from(f.reportJson).subarray(offset, offset + maxBytes) }) });

test('the exact cross-language producer fixture verifies without reserialization', async () => {
  const f = JSON.parse(await readFile(new URL('./fixtures/evaluation-protocol.json', import.meta.url), 'utf8'));
  await verifyEvaluationProtocol({ protocol: f.set_protocol, protocol_json: f.set_protocol_json, protocol_sha256: f.set_protocol_sha256 });
  await verifyEvaluationProtocol(f);
  assert.equal(sha(f.protocol_json), f.protocol_sha256);
});

test('lost create acknowledgement restarts through exact owned receipt, without another POST', async t => {
  const dir = await privateDirectory(t), journalPath = join(dir, 'state.private.json'), f = fixture();
  let placed = false, creates = 0, quotes = 0; const keys = [];
  const client = createEvaluationClient(async (path, init = {}) => {
    if (path.endsWith('/catalog')) return f.catalog;
    if (path.endsWith('/quotes')) { quotes++; return f.quote; }
    if (init.method === 'POST') { creates++; keys.push(init.headers['Idempotency-Key']); placed = true; throw new TypeError('lost acknowledgement'); }
    if (path.includes('?')) return { evaluations: placed ? [f.order] : [] };
    return { evaluation: f.order };
  });
  const options = { journalPath, client, transport: fileTransport(f), credentialContext: context, waitSeconds: 0 };
  await assert.rejects(runCheckpointEvaluation(f.config, { ...options, confirm: true }), e => e.code === 'outcome_unknown');
  const retained = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(retained.entries[0].phase, 'confirmation_unresolved');
  assert.equal(retained.entries[0].quote.quote_id, f.quote.quote_id);
  assert.equal(retained.entries[0].request_key, keys[0]);
  const resumed = await runCheckpointEvaluation(f.config, options);
  assert.equal(resumed.entries[0].phase, 'delivered');
  assert.equal(resumed.entries[0].result.report.envs.test.n_problems_graded, 2);
  assert.equal(resumed.entries[0].result.report.envs.test.graded_rows, 4);
  assert.equal(creates, 1); assert.equal(quotes, 1);
});

test('unresolved confirmation never requotes or rekeys; failed authorization preserves it', async t => {
  const dir = await privateDirectory(t), journalPath = join(dir, 'state.private.json'), f = fixture();
  let creates = 0, forbidden = false; const bodies = [], keys = [];
  const client = createEvaluationClient(async (path, init = {}) => {
    if (path.endsWith('/catalog')) return f.catalog;
    if (path.endsWith('/quotes')) return f.quote;
    if (path.includes('?')) { if (forbidden) throw new GenerationApiError('permission_required', 403); return { evaluations: [] }; }
    if (init.method === 'POST') { creates++; bodies.push(init.body); keys.push(init.headers['Idempotency-Key']); if (creates === 1) throw new TypeError('transport lost'); return { evaluation: f.order }; }
    return { evaluation: f.order };
  });
  const options = { journalPath, client, transport: fileTransport(f), credentialContext: context, waitSeconds: 0 };
  await assert.rejects(runCheckpointEvaluation(f.config, { ...options, confirm: true }));
  await runCheckpointEvaluation(f.config, options); assert.equal(creates, 1);
  forbidden = true;
  await assert.rejects(runCheckpointEvaluation(f.config, { ...options, confirm: true }), e => e.status === 403);
  forbidden = false;
  await runCheckpointEvaluation(f.config, { ...options, confirm: true });
  assert.deepEqual(keys, [keys[0], keys[0]]); assert.deepEqual(bodies, [bodies[0], bodies[0]]);
});

test('changed checkpoint, API credential or unapproved price cannot submit', async t => {
  const dir = await privateDirectory(t), journalPath = join(dir, 'state.private.json'), f = fixture(); let creates = 0;
  const client = createEvaluationClient(async (path, init = {}) => { if (path.endsWith('/catalog')) return f.catalog; if (path.endsWith('/quotes')) return f.quote; if (init.method === 'POST') creates++; return { evaluations: [] }; });
  const options = { journalPath, client, transport: fileTransport(f), credentialContext: context, waitSeconds: 0 };
  await runCheckpointEvaluation(f.config, options);
  await assert.rejects(runCheckpointEvaluation({ ...f.config, checkpoint_step: 11 }, { ...options, confirm: true }), /different checkpoint/);
  await assert.rejects(runCheckpointEvaluation(f.config, { ...options, credentialContext: '2'.repeat(64), confirm: true }), /credential/);
  const priceState = join(dir, 'price.private.json');
  await assert.rejects(runCheckpointEvaluation({ ...f.config, max_total_usd: 0.99 }, { ...options, journalPath: priceState, confirm: true }), /cost ceiling/);
  assert.equal(creates, 0);
});

test('zero-ceiling preparation can explicitly approve the same retained quote before any POST', async t => {
  const dir = await privateDirectory(t), journalPath = join(dir, 'approval.private.json'), f = fixture(); let quotes = 0, creates = 0;
  const client = createEvaluationClient(async (path, init = {}) => {
    if (path.endsWith('/catalog')) return f.catalog;
    if (path.endsWith('/quotes')) { quotes++; return f.quote; }
    if (path.includes('?')) return { evaluations: [] };
    if (init.method === 'POST') { creates++; throw new TypeError('lost acknowledgement'); }
    return { evaluation: f.order };
  });
  const options = { journalPath, client, transport: fileTransport(f), credentialContext: context, waitSeconds: 0 };
  await runCheckpointEvaluation({ ...f.config, max_total_usd: 0 }, options);
  assert.equal(creates, 0);
  await assert.rejects(runCheckpointEvaluation(f.config, { ...options, confirm: true }));
  const state = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.deepEqual(state.approval.quote_ids, [f.quote.quote_id]); assert.equal(state.approval.max_total_usd, 1);
  await assert.rejects(runCheckpointEvaluation({ ...f.config, max_total_usd: 2 }, { ...options, confirm: true }), /original exact quote approval/);
  assert.equal(quotes, 1); assert.equal(creates, 1);
});

test('GET retries respect bounded Retry-After and do not retry authorization failures', async () => {
  const sleeps = []; let reads = 0;
  assert.equal(await boundedRead(async () => { if (++reads < 3) throw new GenerationApiError('rate_limited', 429, undefined, undefined, 'request-a', 2); return 'done'; }, { sleep: async ms => sleeps.push(ms) }), 'done');
  assert.deepEqual(sleeps, [2000, 2000]);
  reads = 0;
  await assert.rejects(boundedRead(async () => { reads++; throw new GenerationApiError('permission_required', 403); }, { sleep: async () => {} }));
  assert.equal(reads, 1);
  reads = 0;
  await assert.rejects(boundedRead(async () => { reads++; throw new GenerationApiError('unavailable', 503); }, { attempts: 3, sleep: async () => {} }));
  assert.equal(reads, 3);
});

test('verified report download refuses tampering, truncation and oversized deliveries', async () => {
  const f = fixture(), transport = fileTransport(f);
  assert.equal((await downloadEvaluationReport(transport, f.order)).report.envs.test.mean_score, 0.5);
  await assert.rejects(downloadEvaluationReport({ download: async () => ({ bytes: Buffer.from('wrong') }) }, f.order), /incomplete/);
  const wrong = structuredClone(f.order); wrong.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(downloadEvaluationReport(transport, wrong), /digest/);
  wrong.files[0].size = 8 * 1024 * 1024 + 1;
  await assert.rejects(downloadEvaluationReport(transport, wrong), /bounded/);
});

test('held-out export binds source clocks, unique denominators and immutable protocols across checkpoints', () => {
  const now = Date.now(), a = fixture({ at: now - 2000 }), b = fixture({ revision: 'b'.repeat(40), step: 20, at: now - 1000 });
  const first = appendCheckpointBenchmarks(null, a.checkpoint, a.target, now, a.publicationEvidence);
  assert.equal(first.observed_at, a.report.created_at * 1000);
  assert.equal(first.benchmarks[0].checkpoints[0].at, a.report.created_at * 1000);
  assert.notEqual(first.observed_at, Date.parse(a.order.finished_at));
  assert.equal(first.benchmarks[0].checkpoints[0].samples, 2);
  assert.equal(first.benchmarks[0].checkpoints[0].score, 0.5);
  assert.equal(first.benchmarks[0].checkpoints[0].cost_usd, null);
  assert.equal(first.benchmarks[0].checkpoints[0].gpu_hours, null);
  assert.equal(first.benchmarks[0].baseline, null);
  const second = appendCheckpointBenchmarks(first, b.checkpoint, a.target, now, b.publicationEvidence);
  assert.equal(second.benchmarks.length, 1); assert.equal(second.benchmarks[0].checkpoints.length, 2);
  assert.deepEqual(appendCheckpointBenchmarks(second, b.checkpoint, a.target, now, b.publicationEvidence), second);
  const changed = structuredClone(b.checkpoint); changed.config.checkpoint_step = 10;
  assert.throws(() => appendCheckpointBenchmarks(first, changed, a.target, now, b.publicationEvidence), /Optimizer step/);
  const baseline = appendCheckpointBenchmarks(null, a.checkpoint, { ...a.target, baseline_checkpoint: `example/model@${a.input.revision}` }, now, a.publicationEvidence);
  assert.equal(baseline.benchmarks[0].baseline.samples, 2); assert.deepEqual(baseline.benchmarks[0].checkpoints, []);
});

test('export refuses trainer writes, unknown disjointness, missing native clocks and incomplete reports', () => {
  const f = fixture();
  assert.throws(() => appendCheckpointBenchmarks(null, f.checkpoint, { ...f.target, evaluation_run_id: f.target.trainer_run_id }));
  const unknown = structuredClone(f.checkpoint); unknown.entries[0].set.protocol.disjointness = { disjoint: null }; unknown.entries[0].set.protocol_json = JSON.stringify(unknown.entries[0].set.protocol); unknown.entries[0].set.protocol_sha256 = sha(unknown.entries[0].set.protocol_json);
  assert.throws(() => appendCheckpointBenchmarks(null, unknown, f.target, Date.now(), f.publicationEvidence), /disjointness/);
  for (const mutate of [r => delete r.created_at, r => r.provenance.revision = 'b'.repeat(40), r => { r.complete = r.envs.test.complete = false; r.envs.test.graded_rows--; r.envs.test.missing_rows++; }]) {
    const changed = structuredClone(f.checkpoint), report = JSON.parse(changed.entries[0].result.report_json); mutate(report); const raw = JSON.stringify(report); changed.entries[0].result.report_json = raw; changed.entries[0].result.report_sha256 = changed.entries[0].result.order.files[0].sha256 = sha(raw);
    assert.throws(() => appendCheckpointBenchmarks(null, changed, f.target, Date.now(), f.publicationEvidence));
  }
});

test('an ambiguous export retains its exact pending envelope for idempotent resume', async t => {
  const dir = await privateDirectory(t), journalPath = join(dir, 'export.private.json'), f = fixture(); const payloads = [];
  await assert.rejects(exportCheckpointBenchmarks(f.target, f.checkpoint, { journalPath, publicationEvidence: f.publicationEvidence, publisher: async payload => { payloads.push(payload); throw new Error('lost export acknowledgement'); } }));
  const first = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.ok(first.pending); assert.equal(first.published, null);
  await exportCheckpointBenchmarks(f.target, f.checkpoint, { journalPath, publicationEvidence: f.publicationEvidence, publisher: async payload => { payloads.push(payload); return { verified: true, evaluation_run_id: f.target.evaluation_run_id, envelope_sha256: payload.envelope_sha256 }; } });
  assert.deepEqual(payloads[0].envelope, payloads[1].envelope);
  const second = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(second.pending, null); assert.ok(second.published);
});

test('optional Python writer only updates the existing dedicated run and verifies acknowledgement', () => {
  const script = fileURLToPath(new URL('../examples/export-checkpoint-benchmarks.py', import.meta.url));
  const code = `import importlib.util,json,hashlib,sys\nfrom types import SimpleNamespace\nspec=importlib.util.spec_from_file_location('writer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nclass Summary(dict):\n def update(self): self.updates+=1\nsummary=Summary();summary.updates=0\ntrainer=SimpleNamespace(id='trainer-a',summary=Summary(),job_type='training')\nrun=SimpleNamespace(id='evaluation-a',summary=summary,job_type='evaluation')\nclass Api:\n def run(self,path): return trainer if path.endswith('/trainer-a') else run\npayload=json.load(sys.stdin)\na=m.publish(payload,Api);assert a['verified'];assert summary.updates==1;assert not trainer.summary\nm.publish(payload,Api);assert summary.updates==1\nrun.job_type='training'\ntry:m.publish(payload,Api);raise AssertionError('wrong role accepted')\nexcept ValueError:pass\nprint('passed')\n`;
  const f = fixture(), envelope = appendCheckpointBenchmarks(null, f.checkpoint, f.target, Date.now(), f.publicationEvidence), envelope_json = JSON.stringify(envelope);
  const result = spawnSync('python3', ['-c', code, script], { input: JSON.stringify({ target: f.target, previous: null, envelope, envelope_json, envelope_sha256: sha(envelope_json) }), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'passed');
});


test('export requires immutable native publication bytes and the actual optimizer step', () => {
  const f = fixture();
  assert.throws(() => appendCheckpointBenchmarks(null, f.checkpoint, f.target), /publication evidence/);
  assert.equal(verifyCheckpointPublication(f.publicationEvidence, f.config).optimizer_step, 10);
  for (const mutate of [e => e.revision = 'b'.repeat(40), e => e.trainer_run_id = 'other', e => e.publication_source = e.publication_source.replace(e.revision, 'main'), e => e.profile_json += ' ', e => { const p = JSON.parse(e.profile_json); p.lr_schedule_step = 11; e.profile_json = JSON.stringify(p); e.profile_sha256 = sha(e.profile_json); }]) {
    const evidence = structuredClone(f.publicationEvidence); mutate(evidence);
    assert.throws(() => verifyCheckpointPublication(evidence, f.config));
  }
  assert.throws(() => verifyCheckpointPublication(f.publicationEvidence, { ...f.config, checkpoint_step: 7 }), /Optimizer step/);
});
