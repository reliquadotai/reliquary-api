import {
  jobId, jobUuid, jobCursor, parseJobCreateInput, parseJobControlInput, parseJobInputUpload, parseJobWorkerEnrollInput,
  parseJobResponse, parseJobsPage, parseJobEventsPage, parseJobCapabilities, parseJobInputRef, parseJobWorker, parseJobWorkersPage,
  parseJobArtifact, parseDatasetValidationReport,
  type JobCreateInput, type JobControlInput, type JobInputUpload, type JobWorkerEnrollInput,
} from './jobs.js';
import { JobApiError } from './job-errors.js';
import type { JobJsonTransport } from './job-transport.js';

export type JobAudience = 'browser' | 'key';
export type JobRequest = { path: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; json?: unknown };
export type JobPageInput = { cursor?: string; limit?: number };
const envelope = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('schema_version' in value) || value.schema_version !== 1) throw new Error('Invalid job API envelope.');
  return value as Record<string, unknown>;
};
const page = (input: JobPageInput = {}) => {
  if (Object.keys(input).some(k => !['cursor', 'limit'].includes(k))) throw new Error('Invalid job pagination.');
  const query = new URLSearchParams();
  if (input.cursor !== undefined) query.set('cursor', jobCursor(input.cursor));
  if (input.limit !== undefined) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('Invalid job page size.');
    query.set('limit', String(input.limit));
  }
  return query.size ? '?' + query.toString() : '';
};
export function jobRequests(audience: JobAudience = 'key') {
  const prefix = audience === 'browser' ? '/api' : '/api/v1';
  const root = prefix + '/jobs';
  const ownedPath = (id: string) => {
    jobId(id);
    if (audience === 'key' && !id.startsWith('cpu:')) throw new JobApiError('unsupported_workload');
    return root + '/' + encodeURIComponent(id);
  };
  const mutation = (path: string, json: unknown, requestKey: string, revision?: string): JobRequest => ({ path, method: 'POST', json, headers: { 'Idempotency-Key': jobUuid(requestKey), ...(revision !== undefined ? { 'X-Resource-Revision': revision } : {}) } });
  return {
    capabilities: (): JobRequest => ({ path: root + '/capabilities' }),
    list: (input?: JobPageInput): JobRequest => ({ path: root + page(input) }),
    detail: (id: string): JobRequest => ({ path: ownedPath(id) }),
    events: (id: string, input?: JobPageInput): JobRequest => ({ path: ownedPath(id) + '/events' + page(input) }),
    create: (input: JobCreateInput, key: string): JobRequest => mutation(root, parseJobCreateInput(input), key),
    control: (id: string, action: 'pause' | 'resume' | 'cancel', input: JobControlInput, key: string): JobRequest => {
      if (!id.startsWith('cpu:') || !['pause', 'resume', 'cancel'].includes(action)) throw new JobApiError('unsupported_workload');
      const parsed = parseJobControlInput(input);
      return mutation(ownedPath(id) + '/' + action, parsed, key, parsed.revision);
    },
    uploadInput: (input: JobInputUpload, key: string): JobRequest => mutation(prefix + '/job-inputs', parseJobInputUpload(input), key),
    artifact: (id: string, artifactId: string): JobRequest => {
      if (!id.startsWith('cpu:') || !/^[A-Za-z0-9_-]{1,100}$/.test(artifactId)) throw new JobApiError('unsupported_artifact');
      return { path: ownedPath(id) + '/artifacts/' + encodeURIComponent(artifactId) };
    },
    workers: (): JobRequest => ({ path: prefix + '/job-workers' }),
    enrollWorker: (input: JobWorkerEnrollInput, key: string): JobRequest => mutation(prefix + '/job-workers', parseJobWorkerEnrollInput(input), key),
    revokeWorker: (id: string, reason: string, key: string): JobRequest => {
      const parsed = parseJobControlInput({ schema_version: 1, revision: '1', reason });
      return mutation(prefix + '/job-workers/' + jobUuid(id) + '/revoke', { schema_version: 1, reason: parsed.reason }, key);
    },
  };
}

export function createJobsClient(request: JobJsonTransport, options: { audience?: JobAudience } = {}) {
  const audience = options.audience ?? 'key';
  const descriptors = jobRequests(audience);
  const call = async <T>(descriptor: JobRequest, parse: (value: unknown) => T, signal?: AbortSignal): Promise<Awaited<T>> => {
    const mutation = descriptor.method === 'POST';
    const key = descriptor.headers?.['Idempotency-Key'];
    const revision = descriptor.headers?.['X-Resource-Revision'];
    let value;
    try {
      value = await request(descriptor.path, { ...(descriptor.method ? { method: descriptor.method } : {}), ...(descriptor.headers ? { headers: descriptor.headers } : {}), ...(descriptor.json !== undefined ? { body: JSON.stringify(descriptor.json) } : {}), ...(signal ? { signal } : {}) });
    } catch (error) {
      if (!mutation) throw error;
      if (error instanceof JobApiError && ['outcome_unknown', 'credential_required', 'invalid_origin', 'invalid_route', 'invalid_credential', 'invalid_timeout', 'request_too_large', 'writes_disabled'].includes(error.code)) throw error;
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) throw error;
      throw new JobApiError('outcome_unknown', typeof status === 'number' ? status : undefined, key, revision);
    }
    try { return await parse(value); }
    catch (error) { if (mutation) throw new JobApiError('outcome_unknown', undefined, key, revision); throw error; }
  };
  const owned = (value: unknown, id?: string) => {
    const job = parseJobResponse(envelope(value), id);
    if (audience === 'key' && job.kind !== 'dataset_validation') throw new Error('Unexpected native job in customer API response.');
    return job;
  };
  return {
    capabilities: (signal?: AbortSignal) => call(descriptors.capabilities(), parseJobCapabilities, signal),
    list: (input?: JobPageInput, signal?: AbortSignal) => call(descriptors.list(input), value => parseJobsPage(value, audience), signal),
    detail: (id: string, signal?: AbortSignal) => call(descriptors.detail(id), value => owned(value, id), signal),
    events: (id: string, input?: JobPageInput, signal?: AbortSignal) => call(descriptors.events(id, input), value => parseJobEventsPage(value, id), signal),
    create: (input: JobCreateInput, key: string) => {
      const parsed = parseJobCreateInput(input);
      return call(descriptors.create(parsed, key), value => {
        const job = owned(value);
        if (JSON.stringify(job.spec) !== JSON.stringify(parsed.spec)) throw new Error('The created job did not match the reviewed input.');
        return job;
      });
    },
    control: (id: string, action: 'pause' | 'resume' | 'cancel', input: JobControlInput, key: string) => call(descriptors.control(id, action, input, key), value => owned(value, id)),
    uploadInput: (input: JobInputUpload, key: string) => {
      const parsed = parseJobInputUpload(input);
      return call(descriptors.uploadInput(parsed, key), async value => {
        const ref = parseJobInputRef(envelope(value)['input']);
        const content = new TextEncoder().encode(parsed.content);
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), n => n.toString(16).padStart(2, '0')).join('');
        if (ref.format !== parsed.format || ref.size_bytes !== content.length || ref.sha256 !== sha256) throw new Error('The input receipt did not match the upload.');
        return ref;
      });
    },
    artifact: (id: string, artifactId: string, signal?: AbortSignal) => call(descriptors.artifact(id, artifactId), async value => {
      const v = envelope(value), artifact = parseJobArtifact(v['artifact']), report = parseDatasetValidationReport(v['report']);
      if (artifact.job_id !== id || artifact.id !== artifactId || artifact.kind !== 'validation_report') throw new Error('The artifact did not match this job.');
      const bytes = new TextEncoder().encode(JSON.stringify(report));
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      if (artifact.size_bytes !== bytes.length || artifact.sha256 !== sha256) throw new Error('The report did not match its frozen artifact digest.');
      return { artifact, report };
    }, signal),
    workers: (signal?: AbortSignal) => call(descriptors.workers(), parseJobWorkersPage, signal),
    enrollWorker: (input: JobWorkerEnrollInput, key: string) => {
      const parsed = parseJobWorkerEnrollInput(input);
      return call(descriptors.enrollWorker(parsed, key), value => {
        const v = envelope(value), worker = parseJobWorker(v['worker']);
        const token = v['token'];
        if (worker.id !== key || worker.name !== parsed.name || (token !== null && (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)))) throw new Error('Invalid worker enrollment receipt.');
        return { worker, token: token as string | null };
      });
    },
    revokeWorker: (id: string, reason: string, key: string) => call(descriptors.revokeWorker(id, reason, key), value => {
      const worker = parseJobWorker(envelope(value)['worker']);
      if (worker.id !== id || worker.revoked_at === null) throw new Error('Invalid worker revocation receipt.');
      return worker;
    }),
  };
}
