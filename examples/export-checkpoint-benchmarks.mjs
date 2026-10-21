import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { canonicalEvaluationJson, parseEvaluationReport, parseEvaluationProtocolJson } from '../dist/index.js';
import { withJournalLock, writeJournal, parseCheckpointConfig } from './evaluate-checkpoint.mjs';

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (a, b) => canonicalEvaluationJson(a) === canonicalEvaluationJson(b);
const digest = value => createHash('sha256').update(value).digest('hex');
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

export function parseExportTarget(value) {
  requireValue(value && typeof value === 'object' && Object.keys(value).every(k => ['schema_version', 'entity', 'project', 'evaluation_run_id', 'trainer_run_id', 'approved', 'baseline_checkpoint'].includes(k)), 'Invalid export target.');
  requireValue(value.schema_version === 1 && value.approved === true && ['entity', 'project', 'evaluation_run_id', 'trainer_run_id'].every(k => safe(value[k])), 'Approve an explicit dedicated evaluation run and its trainer source.');
  requireValue(value.evaluation_run_id !== value.trainer_run_id, 'The exporter must never write the trainer run.');
  requireValue(value.baseline_checkpoint === undefined || typeof value.baseline_checkpoint === 'string', 'Baseline must be an explicit checkpoint identity.');
  return structuredClone(value);
}

/** Reviewed copies of the native immutable publication receipt and embedded profile. */
export function verifyCheckpointPublication(evidence, config, target) {
  requireValue(evidence && evidence.approved === true && evidence.trainer_run_id === config.trainer_run_id, 'Export needs reviewed checkpoint publication evidence for the actual trainer.');
  const request = config.requests[0];
  requireValue(evidence.repo_id === request.model && evidence.revision === request.revision, 'Checkpoint publication repository or immutable revision differs.');
  if (config.checkpoint_step === null) {
    requireValue(target?.baseline_checkpoint === `${request.model}@${request.revision}`, 'An unknown optimizer step may only be exported as the explicitly approved baseline.');
    requireValue(evidence.checkpoint_source === `https://huggingface.co/api/models/${request.model}/revision/${request.revision}?blobs=true`, 'Review the exact immutable baseline snapshot metadata.');
    const raw = evidence.checkpoint_json;
    requireValue(typeof raw === 'string' && Buffer.byteLength(raw) <= 1024 * 1024 && /^[a-f0-9]{64}$/.test(evidence.checkpoint_sha256) && digest(raw) === evidence.checkpoint_sha256, 'Baseline snapshot bytes or source digest changed.');
    const snapshot = parseEvaluationProtocolJson(raw);
    requireValue(snapshot.id === request.model && snapshot.sha === request.revision && Array.isArray(snapshot.siblings) && snapshot.siblings.some(file => typeof file.rfilename === 'string' && file.rfilename.endsWith('.safetensors') && /^[a-f0-9]{64}$/.test(file.lfs?.sha256) && Number.isSafeInteger(file.size) && file.size > 0), 'Baseline metadata must pin the model snapshot and weight artifact.');
    return { repo_id: request.model, revision: request.revision, trainer_run_id: config.trainer_run_id, optimizer_step: null, checkpoint_sha256: evidence.checkpoint_sha256 };
  }
  const base = `https://huggingface.co/${request.model}/resolve/${request.revision}/`;
  requireValue(evidence.publication_source === base + 'reliquary_publication.json' && evidence.profile_source === base + 'reliquary_protocol_profile.json', 'Review the exact immutable checkpoint publication sources.');
  const read = name => {
    const raw = evidence[`${name}_json`], hash = evidence[`${name}_sha256`];
    requireValue(typeof raw === 'string' && Buffer.byteLength(raw) <= 1024 * 1024 && /^[a-f0-9]{64}$/.test(hash) && digest(raw) === hash, 'Checkpoint publication bytes or source digest changed.');
    return parseEvaluationProtocolJson(raw);
  };
  const publication = read('publication'), profile = read('profile');
  if (publication.manifest?.publication_kind === 'async_hf_backup') {
    for (const field of ['async_checkpoint_run', 'async_task_id'])
      requireValue(typeof publication.manifest[field] === 'string' && publication.manifest[field].length > 0 && profile[field] === publication.manifest[field], 'Async publication and profile do not bind the same run and task.');
  }
  const validParent = publication.parent_revision === null
    ? publication.manifest?.publication_kind === 'async_hf_backup'
    : /^[a-f0-9]{40}$/.test(publication.parent_revision);
  requireValue(/^[a-f0-9]{32}$/.test(publication.publication_id) && validParent && publication.manifest?.repo_id === request.model && typeof publication.manifest.training_run_id === 'string' && publication.manifest.training_run_id.length > 0 && profile.training_run_id === publication.manifest.training_run_id, 'Native publication and profile do not bind the same training run.');
  requireValue(Number.isSafeInteger(profile.lr_schedule_step) && profile.lr_schedule_step >= 0 && profile.lr_schedule_step === config.checkpoint_step, 'Optimizer step differs from the native checkpoint profile.');
  const file = publication.files?.['reliquary_protocol_profile.json'];
  requireValue(file?.sha256 === evidence.profile_sha256 && file.size === Buffer.byteLength(evidence.profile_json), 'The native publication receipt does not pin the checkpoint profile.');
  return { repo_id: request.model, revision: request.revision, trainer_run_id: config.trainer_run_id, training_run_id: profile.training_run_id, optimizer_step: profile.lr_schedule_step, publication_sha256: evidence.publication_sha256, profile_sha256: evidence.profile_sha256 };
}

function reviewedHeldOut(set) {
  const d = set?.protocol?.disjointness;
  return d?.disjoint === true && /^[a-f0-9]{64}$/.test(d.evidence_sha256) &&
    !d.note && !['overlap', 'contaminated', 'training_overlap', 'train', 'rl', 'corpus'].some(k => d[k] === true) && d.held_out !== false;
}

function sanitizeEnvelope(value, runId, now) {
  requireValue(value.schema === 'reliquary.run-benchmarks.v1' && value.run_id === runId && value.scope === 'held_out' && Array.isArray(value.benchmarks) && value.benchmarks.length <= 24, 'Invalid retained benchmark envelope.');
  requireValue(Number.isFinite(value.observed_at) && value.observed_at >= 0 && value.observed_at <= now + 5000, 'Invalid retained producer clock.');
  const label = (text, max = 160) => { requireValue(typeof text === 'string' && text.trim() && text.length <= max && !/[\x00-\x1f\x7f]/.test(text), 'Invalid retained benchmark label.'); return text; };
  const point = (p, baseline = false) => {
    requireValue(p && (baseline && p.step === null || Number.isSafeInteger(p.step) && p.step >= 0 && p.step <= 1e12) && Number.isFinite(p.at) && p.at >= 0 && p.at <= value.observed_at && Number.isSafeInteger(p.samples) && p.samples >= 0 && (p.score === null || Number.isFinite(p.score) && p.score >= 0 && p.score <= 1 && p.samples >= 1) && p.cost_usd == null && p.gpu_hours == null, 'Invalid retained benchmark point.');
    return { checkpoint: label(p.checkpoint), step: p.step, at: p.at, score: p.score, samples: p.samples, cost_usd: null, gpu_hours: null };
  };
  const benchmarks = value.benchmarks.map(b => {
    requireValue(b.metric === 'accuracy' && Array.isArray(b.checkpoints) && b.checkpoints.length <= 120 && Number.isSafeInteger(b.protocol?.attempts) && b.protocol.attempts >= 1 && b.protocol.attempts <= 1024 && Number.isSafeInteger(b.protocol.max_output_tokens) && b.protocol.max_output_tokens >= 1 && b.protocol.max_output_tokens <= 10000000, 'Invalid retained benchmark series.');
    const checkpoints = b.checkpoints.map(p => point(p));
    requireValue(checkpoints.every((p, i) => !i || p.step > checkpoints[i - 1].step && p.at >= checkpoints[i - 1].at) && new Set(checkpoints.map(p => p.checkpoint)).size === checkpoints.length, 'Retained checkpoints are not ordered or unique.');
    return { id: label(b.id, 96), label: label(b.label), metric: b.metric, protocol: { id: label(b.protocol.id), dataset: label(b.protocol.dataset), revision: label(b.protocol.revision), harness: label(b.protocol.harness), attempts: b.protocol.attempts, max_output_tokens: b.protocol.max_output_tokens }, baseline: b.baseline == null ? null : point(b.baseline, true), checkpoints };
  });
  requireValue(new Set(benchmarks.map(b => b.id)).size === benchmarks.length, 'Duplicate retained benchmark protocols.');
  return { schema: value.schema, run_id: runId, observed_at: value.observed_at, scope: 'held_out', benchmarks };
}

/** Scores come only from verified, complete native per-problem reports. */
export function appendCheckpointBenchmarks(previous, checkpoint, targetValue, now = Date.now(), publicationEvidence) {
  const target = parseExportTarget(targetValue), config = parseCheckpointConfig(checkpoint.config);
  verifyCheckpointPublication(publicationEvidence, config, target);
  requireValue(config.trainer_run_id === target.trainer_run_id && Array.isArray(checkpoint.entries) && checkpoint.entries.length === config.requests.length, 'Checkpoint belongs to another trainer or is incomplete.');
  const envelope = previous ? sanitizeEnvelope(previous, target.trainer_run_id, now) : { schema: 'reliquary.run-benchmarks.v1', run_id: target.trainer_run_id, observed_at: 0, scope: 'held_out', benchmarks: [] };
  requireValue(envelope.schema === 'reliquary.run-benchmarks.v1' && envelope.run_id === target.trainer_run_id && envelope.scope === 'held_out' && Array.isArray(envelope.benchmarks), 'Existing export belongs to another run or scope.');
  for (const [index, entry] of checkpoint.entries.entries()) {
    requireValue(equal(entry.input, config.requests[index]) && entry.result && entry.phase === 'delivered', 'Only a verified delivered checkpoint can be exported.');
    requireValue(entry.set?.qualified_support === true && typeof entry.set.protocol_json === 'string' && digest(entry.set.protocol_json) === entry.set.protocol_sha256 && equal(parseEvaluationProtocolJson(entry.set.protocol_json), entry.set.protocol), 'The retained set protocol bytes changed.');
    requireValue(reviewedHeldOut(entry.set), 'Held-out export needs explicit reviewed disjointness evidence; unknown or training overlap cannot be exported.');
    const { order } = entry.result;
    requireValue(order.files?.find(f => f.name === 'report.json')?.sha256 === entry.result.report_sha256, 'The report digest differs from its retained delivery receipt.');
    requireValue(typeof entry.result.report_json === 'string' && digest(entry.result.report_json) === entry.result.report_sha256, 'The retained native report bytes changed.');
    const report = parseEvaluationReport(JSON.parse(entry.result.report_json), order);
    const request = config.requests[index], selected = request.envs[0], metrics = report.envs[selected.env];
    requireValue(order.model.repo === request.model && order.model.revision === request.revision && order.complete === true && report.complete === true && metrics?.complete === true, 'Checkpoint identity or completion is not verified.');
    requireValue(report.counts.malformed_rows === 0 && report.counts.unexpected_rows === 0 && metrics.n_problems === selected.problems && metrics.n_problems_graded === selected.problems && metrics.expected_rows === selected.problems * selected.samples && metrics.graded_rows === metrics.expected_rows && metrics.missing_rows === 0 && metrics.ungraded_rows === 0, 'Complete unique-problem and completion-row counts are required.');
    requireValue(metrics.mean_score !== null && Number.isFinite(metrics.mean_score) && metrics.mean_score >= 0 && metrics.mean_score <= 1, 'A measured fractional per-problem mean_score is required.');
    requireValue(entry.quote.protocol_sha256 === order.protocol_sha256 && entry.set.protocol_sha256 === order.protocol_bindings[selected.set_id], 'The result protocol differs from the retained frozen set.');
    const raw = order.protocol_json;
    requireValue(typeof raw === 'string' && digest(raw) === order.protocol_sha256, 'The exact protocol bytes do not match their digest.');
    const checkpointId = `${request.model}@${request.revision}`, at = report.created_at === null ? NaN : report.created_at * 1000;
    requireValue(checkpointId.length <= 160 && Number.isFinite(at) && at >= 0 && at <= now + 5000, 'Checkpoint identity or actual report producer clock is unavailable or exceeds the feed contract.');
    const point = { checkpoint: checkpointId, step: config.checkpoint_step, at, score: metrics.mean_score, samples: metrics.n_problems_graded, cost_usd: null, gpu_hours: null };
    const protocol = { id: order.protocol_sha256, dataset: selected.set_id, revision: entry.set.protocol_sha256, harness: order.harness, attempts: selected.samples, max_output_tokens: order.max_new_tokens };
    let series = envelope.benchmarks.find(b => b.id === order.protocol_sha256);
    if (!series) {
      series = { id: order.protocol_sha256, label: entry.set.name.length <= 160 ? entry.set.name : selected.set_id, metric: 'accuracy', protocol, baseline: null, checkpoints: [] };
      envelope.benchmarks.push(series);
    }
    requireValue(equal(series.protocol, protocol) && series.metric === 'accuracy', 'An immutable protocol or metric was reused with different values.');
    const isBaseline = target.baseline_checkpoint === checkpointId;
    requireValue(isBaseline || config.checkpoint_step !== null, 'Trajectory checkpoints require a verified optimizer step.');
    const existing = isBaseline ? series.baseline : series.checkpoints.find(p => p.checkpoint === checkpointId || p.step === point.step);
    if (existing) requireValue(equal(existing, point), 'A checkpoint or optimizer step already has a different approved result.');
    else if (isBaseline) series.baseline = point;
    else {
      const last = series.checkpoints.at(-1);
      requireValue(!last || point.step > last.step && point.at >= last.at, 'Checkpoint optimizer steps and source clocks must increase.');
      series.checkpoints.push(point);
    }
    envelope.observed_at = Math.max(envelope.observed_at, at);
  }
  requireValue(envelope.benchmarks.length <= 24 && envelope.benchmarks.every(b => b.checkpoints.length <= 120 && typeof b.protocol.harness === 'string' && b.protocol.harness.length <= 160), 'Benchmark series exceed the published feed bounds.');
  requireValue(Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= 512 * 1024, 'Benchmark envelope exceeds512KiB.');
  return envelope;
}

function publish(payload) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.EVALUATIONS_WANDB_PYTHON ?? 'python3', [fileURLToPath(new URL('./export-checkpoint-benchmarks.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Export acknowledgement timed out; retained journal must be reconciled before another publication.')); }, 90000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 32768) child.kill('SIGTERM'); else chunks.push(chunk); });
    // Remote exceptions can contain URLs and credentials: expose only the safe exit status.
    child.stderr.resume();
    child.on('close', code => { clearTimeout(timer); if (code !== 0 || size > 32768) reject(new Error('Export not verified; preserve the pending envelope and reconcile the dedicated evaluation run.')); else { try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Export acknowledgement is invalid.')); } } });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function exportCheckpointBenchmarks(targetValue, checkpoint, { journalPath, publisher = publish, now = Date.now(), publicationEvidence }) {
  const target = parseExportTarget(targetValue);
  return withJournalLock(journalPath, async () => {
    let state;
    try {
      const info = await stat(journalPath);
      requireValue(info.isFile() && (info.mode & 0o077) === 0 && info.size <= 2 * 1024 * 1024, 'Export journal must be a bounded owner-only file.');
      state = JSON.parse(await readFile(journalPath, 'utf8'));
      requireValue(state.schema_version === 1 && equal(state.target, target), 'The export journal belongs to another dedicated run or approval.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; state = { schema_version: 1, target, published: null, pending: null }; }
    const lineage = verifyCheckpointPublication(publicationEvidence, parseCheckpointConfig(checkpoint.config), target);
    state.checkpoint_sources ??= {};
    const sourceId = `${lineage.repo_id}@${lineage.revision}`;
    requireValue(!state.checkpoint_sources[sourceId] || equal(state.checkpoint_sources[sourceId], lineage), 'Retained checkpoint publication evidence changed.');
    const envelope = appendCheckpointBenchmarks(state.pending ?? state.published, checkpoint, target, now, publicationEvidence);
    state.checkpoint_sources[sourceId] = lineage;
    if (state.pending) requireValue(equal(envelope.benchmarks, state.pending.benchmarks), 'Reconcile the previous pending export before appending another checkpoint.');
    state.pending ??= envelope;
    await writeJournal(journalPath, state);
    const ack = await publisher({ target, previous: state.published, envelope: state.pending, envelope_json: JSON.stringify(state.pending), envelope_sha256: digest(JSON.stringify(state.pending)) });
    requireValue(ack?.verified === true && ack.evaluation_run_id === target.evaluation_run_id && ack.envelope_sha256 === digest(JSON.stringify(state.pending)), 'Export acknowledgement does not match the pending envelope.');
    state.published = state.pending; state.pending = null;
    await writeJournal(journalPath, state);
    return state.published;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    requireValue(process.argv.length === 6, 'Usage: node examples/export-checkpoint-benchmarks.mjs TARGET.json EXPORT-STATE.private.json CHECKPOINT-STATE.private.json PUBLICATION.private.json');
    const targetInfo = await stat(process.argv[2]);
    requireValue(targetInfo.isFile() && targetInfo.size >= 1 && targetInfo.size <= 65536, 'Target must be a bounded JSON file.');
    const target = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const sourceInfo = await stat(process.argv[4]);
    requireValue(sourceInfo.isFile() && (sourceInfo.mode & 0o077) === 0 && sourceInfo.size <= 80 * 1024 * 1024, 'Checkpoint journal must be bounded and owner-only.');
    const checkpoint = JSON.parse(await readFile(process.argv[4], 'utf8'));
    const evidenceInfo = await stat(process.argv[5]);
    requireValue(evidenceInfo.isFile() && (evidenceInfo.mode & 0o077) === 0 && evidenceInfo.size <= 3 * 1024 * 1024, 'Publication evidence must be bounded and owner-only.');
    const publicationEvidence = JSON.parse(await readFile(process.argv[5], 'utf8'));
    const envelope = await exportCheckpointBenchmarks(target, checkpoint, { journalPath: resolve(process.argv[3]), publicationEvidence });
    process.stdout.write(JSON.stringify({ verified: true, benchmarks: envelope.benchmarks.length, trainer_run_id: envelope.run_id, evaluation_run_id: target.evaluation_run_id }) + '\n');
  } catch { process.stderr.write('Export not verified. Retain the owner-only journal; inspect approved lineage and reconcile the dedicated run before retrying.\n'); process.exitCode = 1; }
}
