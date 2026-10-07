import { parseSubnetManifest, type SubnetTaskManifest } from './subnet-tasks.js';

export const JOB_KINDS = ['dataset_validation', 'corpus_generation'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_STATES = ['queued', 'running', 'paused', 'cancelling', 'succeeded', 'failed', 'cancelled', 'needs_attention'] as const;
export type JobState = (typeof JOB_STATES)[number];
export const DATASET_FORMATS = ['instruction', 'preference', 'corpus'] as const;
export type DatasetFormat = (typeof DATASET_FORMATS)[number];
/** Stable metadata for implemented adapters; it does not register economic subnet tasks. */
export type WorkloadDefinition = {
  schema_version: 1; kind: JobKind; version: 1; execution: 'cpu' | 'subnet';
  recovery_mode: 'restart_safe' | 'native_managed'; attempts_supported: boolean;
  input_schema_ref: '#/components/schemas/ValidationSpec' | '#/components/schemas/CorpusSpec';
  result_schema_ref: '#/components/schemas/ValidationReport' | null;
};
export const WORKLOAD_DEFINITIONS: readonly Readonly<WorkloadDefinition>[] = Object.freeze([
  Object.freeze({ schema_version: 1, kind: 'dataset_validation', version: 1, execution: 'cpu', recovery_mode: 'restart_safe', attempts_supported: true,
    input_schema_ref: '#/components/schemas/ValidationSpec', result_schema_ref: '#/components/schemas/ValidationReport' } as const),
  Object.freeze({ schema_version: 1, kind: 'corpus_generation', version: 1, execution: 'subnet', recovery_mode: 'native_managed', attempts_supported: false,
    input_schema_ref: '#/components/schemas/CorpusSpec', result_schema_ref: null } as const),
]);
export type JobInputRef = { dataset_id: string; sha256: string; format: DatasetFormat; size_bytes: number };
export type DatasetValidationSpec = { kind: 'dataset_validation'; input: JobInputRef; limits: { deadline_seconds: number; max_attempts: number } };
export type CorpusGenerationSpec = { kind: 'corpus_generation'; manifest: SubnetTaskManifest };
export type JobSpec = DatasetValidationSpec | CorpusGenerationSpec;
export type JobArtifact = {
  id: string; job_id: string; work_unit_id: string | null; attempt_id: string | null;
  kind: 'validation_report' | 'dataset'; name: string; size_bytes: number; sha256: string; content_type: string; created_at: number;
};
export type JobAttempt = {
  id: string; job_id: string; work_unit_id: string; attempt_number: number; worker_id: string; fence: number;
  state: 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled'; lease_expires_at: number; heartbeat_at: number;
  started_at: number; finished_at: number | null; error_code: string | null;
};
export type JobWorkUnit = { id: string; job_id: string; state: JobState; attempt_ids: string[]; artifact_ids: string[] };
export type JobView = {
  schema_version: 1; id: string; kind: JobKind; source_ref: { type: 'subnet_task' | 'dataset_validation'; id: string };
  state: JobState; native_phase: string | null; revision: string; spec_sha256: string; spec: JobSpec;
  current_attempt_id: string | null; work_units: JobWorkUnit[]; attempts: JobAttempt[]; artifacts: JobArtifact[];
  created_at: number; updated_at: number; finished_at: number | null;
};
export type WorkloadCapability = {
  kind: JobKind; input_formats: DatasetFormat[]; execution: 'cpu' | 'subnet'; attempts_supported: boolean;
  controls: ('pause' | 'resume' | 'cancel')[]; can_submit: boolean; reason: string | null;
  enrolled_workers: number; live_workers: number; qualified_workers: number;
  queued_jobs: number; running_jobs: number; oldest_queued_at: number | null;
};
export type JobCapabilities = { schema_version: 1; workloads: WorkloadCapability[] };
export type JobEvent = { id: string; job_id: string; sequence: number; state: JobState; native_phase: string | null; code: string | null; created_at: number };
export type JobWorker = { id: string; name: string; expires_at: number; revoked_at: number | null; last_seen_at: number | null; qualified_at: number | null };
export type JobsPage = { schema_version: 1; jobs: JobView[]; next_cursor: string | null };
export type JobEventsPage = { schema_version: 1; events: JobEvent[]; next_cursor: string | null };
export type JobWorkersPage = { schema_version: 1; workers: JobWorker[]; next_cursor: string | null };
export type JobCreateInput = { schema_version: 1; spec: DatasetValidationSpec };
export type JobControlInput = { schema_version: 1; revision: string; reason: string };
export type JobInputUpload = { schema_version: 1; format: DatasetFormat; content: string };
export type JobWorkerEnrollInput = { schema_version: 1; name: string; ttl_seconds: number };
export const DATASET_ERROR_CODES = ['too_large', 'invalid_utf8', 'too_many_rows', 'empty', 'invalid_json', 'invalid_fields'] as const;
export type DatasetValidationReport = { schema_version: 1; input_sha256: string; format: DatasetFormat; rows: number; valid: boolean; errors: { line: number; code: string }[] };

const fail = (): never => { throw new Error('The job API returned an invalid contract. Refresh and review the job.'); };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => { if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail(); };
const text = (v: unknown, max = 200): string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : fail();
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
const nullableTime = (v: unknown) => v === null ? null : integer(v);
const digest = (v: unknown): string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : fail();
const choice = <T extends string>(v: unknown, values: readonly T[]): T => typeof v === 'string' && values.includes(v as T) ? v as T : fail();
const list = (v: unknown, max = 100): unknown[] => Array.isArray(v) && v.length <= max ? v : fail();
const nullableText = (v: unknown, max = 200) => v === null ? null : text(v, max);
const unique = <T>(values: T[], key: (v: T) => string): T[] => new Set(values.map(key)).size === values.length ? values : fail();
export const jobUuid = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v) ? v : fail();
export const jobId = (v: unknown): string => {
  const id = text(v, 44);
  if (!/^(?:cpu|subnet):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) fail();
  return id;
};
export const jobRevision = (v: unknown): string => typeof v === 'string' && /^(?:[1-9][0-9]{0,15}|[a-f0-9]{64})$/.test(v) && (/^[a-f0-9]{64}$/.test(v) || Number.isSafeInteger(Number(v))) ? v : fail();
export const jobCursor = (v: unknown): string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(v) ? v : fail();
const cursor = (v: unknown) => v === null ? null : jobCursor(v);
const code = (v: unknown): string => typeof v === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(v) ? v : fail();

export function parseJobInputRef(value: unknown): JobInputRef {
  const v = object(value); exact(v, ['dataset_id', 'sha256', 'format', 'size_bytes']);
  return { dataset_id: jobUuid(v['dataset_id']), sha256: digest(v['sha256']), format: choice(v['format'], DATASET_FORMATS), size_bytes: integer(v['size_bytes'], 1, 32768) };
}
export function parseJobSpec(value: unknown): JobSpec {
  const v = object(value);
  if (v['kind'] === 'corpus_generation') {
    exact(v, ['kind', 'manifest']);
    return { kind: 'corpus_generation', manifest: parseSubnetManifest(v['manifest']) };
  }
  if (v['kind'] !== 'dataset_validation') fail();
  exact(v, ['kind', 'input', 'limits']);
  const limits = object(v['limits']); exact(limits, ['deadline_seconds', 'max_attempts']);
  return { kind: 'dataset_validation', input: parseJobInputRef(v['input']), limits: { deadline_seconds: integer(limits['deadline_seconds'], 60, 3600), max_attempts: integer(limits['max_attempts'], 1, 3) } };
}
export function parseJobCreateInput(value: unknown): JobCreateInput {
  const v = object(value); exact(v, ['schema_version', 'spec']);
  if (v['schema_version'] !== 1) fail();
  const spec = parseJobSpec(v['spec']);
  if (spec.kind === 'dataset_validation') return { schema_version: 1, spec };
  return fail();
}
export function parseJobControlInput(value: unknown): JobControlInput {
  const v = object(value); exact(v, ['schema_version', 'revision', 'reason']);
  const reason = text(v['reason'], 500).trim();
  if (v['schema_version'] !== 1 || reason.length < 3) fail();
  return { schema_version: 1, revision: jobRevision(v['revision']), reason };
}
export function parseJobInputUpload(value: unknown): JobInputUpload {
  const v = object(value); exact(v, ['schema_version', 'format', 'content']);
  if (v['schema_version'] !== 1 || typeof v['content'] !== 'string' || new TextEncoder().encode(v['content']).length < 1 || new TextEncoder().encode(v['content']).length > 32768) fail();
  return { schema_version: 1, format: choice(v['format'], DATASET_FORMATS), content: v['content'] as string };
}
export function parseJobWorkerEnrollInput(value: unknown): JobWorkerEnrollInput {
  const v = object(value); exact(v, ['schema_version', 'name', 'ttl_seconds']);
  if (v['schema_version'] !== 1) fail();
  const name = text(v['name'], 80).trim();
  if (!name) fail();
  return { schema_version: 1, name, ttl_seconds: integer(v['ttl_seconds'], 300, 86400) };
}
export function parseDatasetValidationReport(value: unknown): DatasetValidationReport {
  const v = object(value); exact(v, ['schema_version', 'input_sha256', 'format', 'rows', 'valid', 'errors']);
  if (v['schema_version'] !== 1 || typeof v['valid'] !== 'boolean') fail();
  const errors = list(v['errors'], 20).map(item => { const e = object(item); exact(e, ['line', 'code']); return { line: integer(e['line'], 0, 10000), code: choice(e['code'], DATASET_ERROR_CODES) }; });
  const rows = integer(v['rows'], 0, 10000);
  if ((v['valid'] === true) !== (errors.length === 0) || (v['valid'] === true && rows === 0) || errors.some(e => e.line > rows)) fail();
  return { schema_version: 1, input_sha256: digest(v['input_sha256']), format: choice(v['format'], DATASET_FORMATS), rows, valid: v['valid'] as boolean, errors };
}
export function parseJobArtifact(value: unknown): JobArtifact {
  const v = object(value);
  const name = text(v['name'], 100);
  if (!/^[\w.()-]+$/.test(name) || name === '.' || name === '..') fail();
  return { id: text(v['id'], 100), job_id: jobId(v['job_id']), work_unit_id: v['work_unit_id'] === null ? null : jobUuid(v['work_unit_id']), attempt_id: v['attempt_id'] === null ? null : jobUuid(v['attempt_id']), kind: choice(v['kind'], ['validation_report', 'dataset']), name,
    size_bytes: integer(v['size_bytes'], 1, 10 * 1024 ** 3), sha256: digest(v['sha256']), content_type: text(v['content_type'], 100), created_at: integer(v['created_at']) };
}
export function parseJobAttempt(value: unknown): JobAttempt {
  const v = object(value);
  const parsed: JobAttempt = { id: jobUuid(v['id']), job_id: jobId(v['job_id']), work_unit_id: jobUuid(v['work_unit_id']), attempt_number: integer(v['attempt_number'], 1, 3), worker_id: jobUuid(v['worker_id']), fence: integer(v['fence'], 1), state: choice(v['state'], ['running', 'succeeded', 'failed', 'expired', 'cancelled']),
    lease_expires_at: integer(v['lease_expires_at']), heartbeat_at: integer(v['heartbeat_at']), started_at: integer(v['started_at']), finished_at: nullableTime(v['finished_at']), error_code: v['error_code'] === null ? null : code(v['error_code']) };
  if (parsed.heartbeat_at < parsed.started_at || parsed.lease_expires_at < parsed.heartbeat_at || (parsed.finished_at !== null && parsed.finished_at < parsed.started_at) || (parsed.state === 'running') !== (parsed.finished_at === null)) fail();
  return parsed;
}
export function parseJob(value: unknown): JobView {
  const v = object(value), source = object(v['source_ref']);
  if (v['schema_version'] !== 1) fail();
  const spec = parseJobSpec(v['spec']);
  const parsed: JobView = {
    schema_version: 1, id: jobId(v['id']), kind: choice(v['kind'], JOB_KINDS), source_ref: { type: choice(source['type'], ['subnet_task', 'dataset_validation']), id: text(source['id'], 80) },
    state: choice(v['state'], JOB_STATES), native_phase: nullableText(v['native_phase'], 80), revision: jobRevision(v['revision']), spec_sha256: digest(v['spec_sha256']), spec,
    current_attempt_id: v['current_attempt_id'] === null ? null : jobUuid(v['current_attempt_id']),
    work_units: unique(list(v['work_units'], 1).map(item => {
      const u = object(item);
      return { id: jobUuid(u['id']), job_id: jobId(u['job_id']), state: choice(u['state'], JOB_STATES), attempt_ids: unique(list(u['attempt_ids'], 3).map(jobUuid), x => x), artifact_ids: unique(list(u['artifact_ids'], 1000).map(x => text(x, 100)), x => x) };
    }), u => u.id),
    attempts: unique(list(v['attempts'], 3).map(parseJobAttempt), a => a.id), artifacts: unique(list(v['artifacts'], 1000).map(parseJobArtifact), a => a.id),
    created_at: integer(v['created_at']), updated_at: integer(v['updated_at']), finished_at: nullableTime(v['finished_at']),
  };
  if (parsed.kind !== spec.kind || parsed.updated_at < parsed.created_at || (parsed.finished_at !== null && (parsed.finished_at < parsed.created_at || parsed.finished_at > parsed.updated_at)) ||
      (['succeeded', 'failed', 'cancelled'].includes(parsed.state)) !== (parsed.finished_at !== null)) fail();
  const cpu = parsed.kind === 'dataset_validation';
  const definition = WORKLOAD_DEFINITIONS.find(w => w.kind === parsed.kind)!;
  if (!definition.attempts_supported && parsed.attempts.length) fail();
  if ((cpu ? !parsed.id.startsWith('cpu:') || parsed.source_ref.type !== 'dataset_validation' || parsed.native_phase !== null || !/^[1-9][0-9]*$/.test(parsed.revision) || parsed.work_units.length !== 1 :
       !parsed.id.startsWith('subnet:') || parsed.source_ref.type !== 'subnet_task' || parsed.native_phase === null || !/^[a-f0-9]{64}$/.test(parsed.revision) || parsed.work_units.length !== 0 || parsed.attempts.length !== 0 || parsed.current_attempt_id !== null) || parsed.source_ref.id !== parsed.id.slice(parsed.id.indexOf(':') + 1)) fail();
  if (parsed.work_units.some(u => u.job_id !== parsed.id) || parsed.attempts.some(a => a.job_id !== parsed.id || !parsed.work_units.some(u => u.id === a.work_unit_id && u.attempt_ids.includes(a.id))) ||
      parsed.artifacts.some(a => a.job_id !== parsed.id || (a.work_unit_id !== null && !parsed.work_units.some(u => u.id === a.work_unit_id && u.artifact_ids.includes(a.id))) || (a.attempt_id !== null && !parsed.attempts.some(t => t.id === a.attempt_id && t.work_unit_id === a.work_unit_id))) ||
      parsed.work_units.some(u => u.attempt_ids.some(id => !parsed.attempts.some(a => a.id === id)) || u.artifact_ids.some(id => !parsed.artifacts.some(a => a.id === id))) ||
      (parsed.current_attempt_id !== null && !parsed.attempts.some(a => a.id === parsed.current_attempt_id && a.state === 'running')) ||
      (cpu && parsed.attempts.some(a => a.attempt_number > (spec as DatasetValidationSpec).limits.max_attempts))) fail();
  return parsed;
}
export function parseJobResponse(value: unknown, expectedId?: string): JobView {
  const result = parseJob(object(value)['job']);
  if (expectedId !== undefined && result.id !== expectedId) fail();
  return result;
}
export function parseJobsPage(value: unknown, audience: 'browser' | 'key' = 'key'): JobsPage {
  const v = object(value); if (v['schema_version'] !== 1) fail();
  const jobs = unique(list(v['jobs']).map(parseJob), j => j.id);
  if (audience === 'key' && jobs.some(j => j.kind !== 'dataset_validation')) fail();
  return { schema_version: 1, jobs, next_cursor: cursor(v['next_cursor']) };
}
export function parseJobEventsPage(value: unknown, expectedId: string): JobEventsPage {
  const v = object(value); if (v['schema_version'] !== 1) fail();
  const events = unique(list(v['events']).map(item => {
    const e = object(item);
    return { id: text(e['id'], 100), job_id: jobId(e['job_id']), sequence: integer(e['sequence'], 1), state: choice(e['state'], JOB_STATES), native_phase: nullableText(e['native_phase'], 80), code: e['code'] === null ? null : code(e['code']), created_at: integer(e['created_at']) };
  }), e => e.id);
  if (events.some(e => e.job_id !== expectedId) || new Set(events.map(e => e.sequence)).size !== events.length) fail();
  return { schema_version: 1, events, next_cursor: cursor(v['next_cursor']) };
}
export function parseJobWorker(value: unknown): JobWorker {
  const v = object(value);
  return { id: jobUuid(v['id']), name: text(v['name'], 80), expires_at: integer(v['expires_at']), revoked_at: nullableTime(v['revoked_at']), last_seen_at: nullableTime(v['last_seen_at']), qualified_at: nullableTime(v['qualified_at']) };
}
export function parseJobWorkersPage(value: unknown): JobWorkersPage {
  const v = object(value); if (v['schema_version'] !== 1) fail();
  return { schema_version: 1, workers: unique(list(v['workers']).map(parseJobWorker), w => w.id), next_cursor: cursor(v['next_cursor']) };
}
export function parseJobCapabilities(value: unknown): JobCapabilities {
  const v = object(value); if (v['schema_version'] !== 1) fail();
  const workloads = unique(list(v['workloads'], 2).map(item => {
    const w = object(item);
    if (typeof w['attempts_supported'] !== 'boolean' || typeof w['can_submit'] !== 'boolean') fail();
    const result: WorkloadCapability = { kind: choice(w['kind'], JOB_KINDS), input_formats: unique(list(w['input_formats'], 3).map(f => choice(f, DATASET_FORMATS)), f => f), execution: choice(w['execution'], ['cpu', 'subnet']), attempts_supported: w['attempts_supported'] as boolean, controls: unique(list(w['controls'], 3).map(c => choice(c, ['pause', 'resume', 'cancel'])), c => c), can_submit: w['can_submit'] as boolean, reason: nullableText(w['reason'], 500), enrolled_workers: integer(w['enrolled_workers'], 0, 8), live_workers: integer(w['live_workers'], 0, 8), qualified_workers: integer(w['qualified_workers'], 0, 8), queued_jobs: integer(w['queued_jobs'], 0, 8), running_jobs: integer(w['running_jobs'], 0, 8), oldest_queued_at: nullableTime(w['oldest_queued_at']) };
    const definition = WORKLOAD_DEFINITIONS.find(d => d.kind === result.kind)!;
    if (result.execution !== definition.execution || result.attempts_supported !== definition.attempts_supported) fail();
    if (result.qualified_workers > result.live_workers || result.live_workers > result.enrolled_workers || result.queued_jobs + result.running_jobs > 8 || (result.queued_jobs > 0) !== (result.oldest_queued_at !== null) || (result.kind === 'dataset_validation' ? result.execution !== 'cpu' || !result.attempts_supported : result.execution !== 'subnet' || result.attempts_supported || result.input_formats.length > 0 || result.can_submit || result.queued_jobs !== 0 || result.running_jobs !== 0)) fail();
    return result;
  }), w => w.kind);
  return { schema_version: 1, workloads };
}
