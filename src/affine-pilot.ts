import { GenerationApiError } from './generation.js';
import { responseDiagnostics } from './error-diagnostics.js';

export const NATIVE_PREPARATION_POLICY = 'mimo-diagnostic4-v1';
export const NATIVE_PREPARATION_MAX_BYTES = 20 * 1024 ** 3;
export const NATIVE_PREPARATION_MAX_SECONDS = 900;
export const NATIVE_PREPARATION_MIN_WINDOW_SECONDS = 4200;
export const NATIVE_PREPARATION_FINAL_RESERVE_SECONDS = 1425;
export const NATIVE_PREPARATION_MAX_COST_MICRO_USD = 5_100_000;
export const NATIVE_PREPARATION_ARCHITECTURE = 'Qwen3_5ForConditionalGeneration';
export type NativePreparationState = 'queued' | 'preparing' | 'qualifying' | 'ready' | 'failed';
export type NativePreparationReview = {
  sessionId: string;
  repository: string;
  revision: string;
  weightBytes: number;
  architecture: typeof NATIVE_PREPARATION_ARCHITECTURE;
  policyId: typeof NATIVE_PREPARATION_POLICY;
  policyDigest: string;
  maxSeconds: typeof NATIVE_PREPARATION_MAX_SECONDS;
  maxCostMicroUsd: number;
  expiresAt: number;
};
export type NativePreparation = NativePreparationReview & {
  id: string;
  state: NativePreparationState;
  profileDigest: string | null;
  runId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
export type NativePreparationCatalog = {
  available: boolean;
  reason: string | null;
  sessionId: string | null;
  windowEndsAt: number | null;
  preparations: NativePreparation[];
};
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function nativeRepository(value: string): string | null {
  const input = value.trim();
  const repository = input.startsWith('https://huggingface.co/')
    ? input.slice('https://huggingface.co/'.length).replace(/\/$/, '')
    : input;
  return /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/.test(repository) &&
    !repository.includes('..')
    ? repository
    : null;
}
export function parseNativePreparationReview(value: unknown): NativePreparationReview {
  if (
    !record(value) ||
    typeof value['sessionId'] !== 'string' ||
    !/^[\w-]{1,64}$/.test(value['sessionId']) ||
    typeof value['repository'] !== 'string' ||
    nativeRepository(value['repository']) !== value['repository'] ||
    typeof value['revision'] !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value['revision']) ||
    !integer(value['weightBytes'], 1, NATIVE_PREPARATION_MAX_BYTES) ||
    value['architecture'] !== NATIVE_PREPARATION_ARCHITECTURE ||
    value['policyId'] !== NATIVE_PREPARATION_POLICY ||
    !hash(value['policyDigest']) ||
    value['maxSeconds'] !== NATIVE_PREPARATION_MAX_SECONDS ||
    !integer(value['maxCostMicroUsd'], 1, NATIVE_PREPARATION_MAX_COST_MICRO_USD) ||
    !integer(value['expiresAt'], 1)
  )
    throw new Error('Unexpected native checkpoint preparation.');
  return {
    sessionId: value['sessionId'],
    repository: value['repository'],
    revision: value['revision'],
    weightBytes: value['weightBytes'],
    architecture: NATIVE_PREPARATION_ARCHITECTURE,
    policyId: NATIVE_PREPARATION_POLICY,
    policyDigest: value['policyDigest'],
    maxSeconds: NATIVE_PREPARATION_MAX_SECONDS,
    maxCostMicroUsd: value['maxCostMicroUsd'],
    expiresAt: value['expiresAt'],
  };
}
export function parseNativePreparation(value: unknown): NativePreparation {
  const review = parseNativePreparationReview(value);
  if (
    !record(value) ||
    typeof value['id'] !== 'string' ||
    !/^[\w-]{1,64}$/.test(value['id']) ||
    !['queued', 'preparing', 'qualifying', 'ready', 'failed'].includes(String(value['state'])) ||
    !(value['profileDigest'] === null || hash(value['profileDigest'])) ||
    !(
      value['runId'] === null ||
      (typeof value['runId'] === 'string' && /^[\w-]{1,64}$/.test(value['runId']))
    ) ||
    !(
      value['error'] === null ||
      (typeof value['error'] === 'string' && value['error'].length <= 500)
    ) ||
    !integer(value['createdAt'], 1) ||
    !integer(value['updatedAt'], 1) ||
    (value['state'] === 'ready' && !hash(value['profileDigest']))
  )
    throw new Error('Unexpected native checkpoint preparation status.');
  return {
    ...review,
    id: value['id'],
    state: value['state'] as NativePreparationState,
    profileDigest: value['profileDigest'] as string | null,
    runId: value['runId'] as string | null,
    error: value['error'] as string | null,
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
  };
}
export function parseNativePreparationCatalog(value: unknown): NativePreparationCatalog {
  if (
    !record(value) ||
    typeof value['available'] !== 'boolean' ||
    !(value['reason'] === null || typeof value['reason'] === 'string') ||
    !(value['sessionId'] === null || typeof value['sessionId'] === 'string') ||
    !(value['windowEndsAt'] === null || integer(value['windowEndsAt'], 1)) ||
    !Array.isArray(value['preparations']) ||
    value['preparations'].length > 20 ||
    (value['available'] &&
      (typeof value['sessionId'] !== 'string' ||
        !integer(value['windowEndsAt'], 1) ||
        value['reason'] !== null))
  )
    throw new Error('Unexpected native preparation availability.');
  return {
    available: value['available'],
    reason: value['reason'] as string | null,
    sessionId: value['sessionId'] as string | null,
    windowEndsAt: value['windowEndsAt'] as number | null,
    preparations: value['preparations'].map(parseNativePreparation),
  };
}

export type AffineEvaluationRequest = {
  schema: 'affine-native-evaluation-request/v1'; profileDigest: string; jobDigest: string;
  maxHours: number; maxCostMicroUsd: number; nativeJobExpiresAt: number;
};
export function parseAffineEvaluationRequest(value: unknown): AffineEvaluationRequest {
  const keys = ['schema', 'profileDigest', 'jobDigest', 'maxHours', 'maxCostMicroUsd', 'nativeJobExpiresAt'];
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k)) ||
      value['schema'] !== 'affine-native-evaluation-request/v1' || !hash(value['profileDigest']) || !hash(value['jobDigest']) ||
      !integer(value['maxHours'], 1, 168) || !integer(value['maxCostMicroUsd'], 1, 1_000_000_000_000) || !integer(value['nativeJobExpiresAt'], 1))
    throw new Error('Unexpected native evaluation request.');
  return value as AffineEvaluationRequest;
}
export function parseAffineEvaluationPrepared(value: unknown) {
  if (!record(value) || !record(value['configuration']) || !['service-credits', 'operator-funded-pilot'].includes(String(value['mode']))) throw new Error('Unexpected evaluation preparation.');
  const request = parseAffineEvaluationRequest(value['request']);
  const configuration = value['configuration'];
  if (configuration['profileDigest'] !== request.profileDigest ||
      !record(configuration['affineNativeEvaluationRequest']) ||
      Object.entries(request).some(([k, v]) => (configuration['affineNativeEvaluationRequest'] as Record<string, unknown>)[k] !== v) ||
      !record(configuration['optimization']) || configuration['optimization']['method'] !== 'affine_native_evaluation' ||
      !record(configuration['compute']) || configuration['compute']['maxHours'] !== request.maxHours ||
      configuration['submissionMode'] !== (value['mode'] === 'service-credits' ? 'service_credits' : 'operator_funded_pilot')) throw new Error('Evaluation configuration does not match its request.');
  return { request, configuration, mode: value['mode'] as 'service-credits' | 'operator-funded-pilot' };
}
const root = '/api/v1/training/affine-native-evaluation';
const identifier = (v: string) => { if (!/^[\w-]{1,64}$/.test(v)) throw new Error('Invalid identifier.'); return v; };
const key = (v: string) => { if (!/^[\w-]{16,80}$/.test(v)) throw new Error('Use a stable request key.'); return v; };
const uuid = (v: string) => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)) throw new Error('Use a stable UUID request key.'); return v; };
const exact = (v: Record<string, unknown>, names: string[]) => { if (Object.keys(v).length !== names.length || !names.every(k => Object.hasOwn(v, k))) throw new Error('Unexpected request fields.'); };
export type AffinePilotRequestDescriptor = { path: string; init: RequestInit };
const get = (path: string): AffinePilotRequestDescriptor => ({ path, init: { method: 'GET' } });
const post = (path: string, body: unknown, requestKey?: string): AffinePilotRequestDescriptor => ({ path, init: { method: 'POST', headers: { 'Content-Type': 'application/json', ...(requestKey ? { 'Idempotency-Key': key(requestKey) } : {}) }, body: JSON.stringify(body) } });
export type AffineCheckpointReviewInput = { repository: string; reference: string; sessionId: string; maxCostMicroUsd: number };
export type AffineCheckpointPrepareInput = { repository: string; revision: string; sessionId: string; maxCostMicroUsd: number; policyDigest: string; approvePreparation: true; requestId: string };
export type AffineEvaluationPrepareInput = { profileDigest: string; maxHours: number; maxCostMicroUsd: number };
export type AffineTrainingInput = { draftId: string; revision: number; datasetId: string };
function trainingInput(v: AffineTrainingInput) {
  identifier(v.draftId); identifier(v.datasetId);
  if (!integer(v.revision, 1)) throw new Error('Use the saved draft revision.');
  return { draftId: v.draftId, revision: v.revision, datasetId: v.datasetId };
}
export const affinePilotRequests = {
  status: () => get(root + '/preparations'),
  preparation: (id: string) => get(root + '/preparations/' + identifier(id)),
  review: (v: AffineCheckpointReviewInput) => {
    exact(v, ['repository', 'reference', 'sessionId', 'maxCostMicroUsd']); identifier(v.sessionId);
    if (!nativeRepository(v.repository) || !/^[A-Za-z0-9][\w./-]{0,199}$/.test(v.reference) || v.reference.includes('..') || !integer(v.maxCostMicroUsd, 1, NATIVE_PREPARATION_MAX_COST_MICRO_USD)) throw new Error('Review a public checkpoint and bounded cost.');
    return post(root + '/preparations/review', v);
  },
  prepare: (v: AffineCheckpointPrepareInput) => {
    exact(v, ['repository', 'revision', 'sessionId', 'maxCostMicroUsd', 'policyDigest', 'approvePreparation', 'requestId']);
    affinePilotRequests.review({ repository: v.repository, reference: v.revision, sessionId: v.sessionId, maxCostMicroUsd: v.maxCostMicroUsd });
    if (!/^[a-f0-9]{40}$/.test(v.revision) || !hash(v.policyDigest) || v.approvePreparation !== true) throw new Error('Approve the exact reviewed checkpoint.');
    uuid(v.requestId); return post(root + '/preparations', v, v.requestId);
  },
  evaluationPrepare: (v: AffineEvaluationPrepareInput) => {
    exact(v, ['profileDigest', 'maxHours', 'maxCostMicroUsd']);
    if (!hash(v.profileDigest) || !integer(v.maxHours, 1, 168) || !integer(v.maxCostMicroUsd, 1, 1_000_000_000_000)) throw new Error('Select bounded evaluation inputs.');
    return post(root + '/prepare', v);
  },
  uploadRequest: (request: AffineEvaluationRequest, filename: string, rightsConfirmed: true) => {
    const parsed = parseAffineEvaluationRequest(request);
    if (rightsConfirmed !== true || !/^[\w .()-]{1,100}\.jsonl$/i.test(filename)) throw new Error('Confirm rights and use a simple .jsonl filename.');
    return { path: '/api/v1/training/files', init: { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson', 'X-Dataset-Format': 'affine_native_evaluation_request', 'X-Filename': encodeURIComponent(filename), 'X-Data-Authorized': 'true' }, body: JSON.stringify(parsed) + '\n' } } satisfies AffinePilotRequestDescriptor;
  },
  saveDraft: (prepared: ReturnType<typeof parseAffineEvaluationPrepared>, name: string, requestKey: string) => {
    const value = parseAffineEvaluationPrepared(prepared);
    if (!name.trim() || name.length > 80) throw new Error('Use a draft name of 1..80 characters.');
    return post('/api/resources', { kind: 'training', name: name.trim(), config: value.configuration }, requestKey);
  },
  quote: (v: AffineTrainingInput) => { exact(v, ['draftId', 'revision', 'datasetId']); return post('/api/v1/training/quotes', trainingInput(v)); },
  start: (v: AffineTrainingInput & { approveExecution: true; quoteId?: string }, requestKey: string) => {
    exact(v, ['draftId', 'revision', 'datasetId', 'approveExecution', ...(v.quoteId === undefined ? [] : ['quoteId'])]);
    if (v.approveExecution !== true) throw new Error('Explicit execution approval is required.');
    return post('/api/v1/training/tasks', { ...trainingInput(v), approveExecution: true, ...(v.quoteId === undefined ? {} : { quoteId: identifier(v.quoteId) }) }, requestKey);
  },
  task: (taskId: string) => get('/api/v1/training/tasks/' + identifier(taskId)),
  artifact: (taskId: string, artifactId: string, range: { offset: number; maxBytes: number }) => {
    if (!integer(range.offset, 0) || !integer(range.maxBytes, 1, 262144) || !Number.isSafeInteger(range.offset + range.maxBytes)) throw new Error('Use a bounded artifact range.');
    return { path: '/api/v1/training/tasks/' + identifier(taskId) + '/artifacts/' + identifier(artifactId), init: { method: 'GET', headers: { Range: `bytes=${range.offset}-${range.offset + range.maxBytes - 1}` } } } satisfies AffinePilotRequestDescriptor;
  },
};
export type AffinePilotTransport = (path: string, init?: RequestInit) => Promise<unknown>;
/** All calls are single attempts. Preserve the descriptor and original keys on unknown outcomes. */
export function createAffinePilotClient(request: AffinePilotTransport) {
  const send = async (d: AffinePilotRequestDescriptor, parse: (v: unknown) => unknown = object) => {
    const mutation = d.init.method === 'POST';
    let received = false;
    try { const response = await request(d.path, d.init); received = true; return parse(response); }
    catch (error) {
      const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
      if (error instanceof GenerationApiError && (error.code === 'outcome_unknown' || (!received && ['credential_required', 'invalid_route', 'invalid_credential', 'invalid_origin', 'invalid_timeout', 'invalid_range', 'request_too_large'].includes(error.code)))) throw error;
      if (mutation && !(status !== undefined && status >= 400 && status < 500 && status !== 408))
        throw new GenerationApiError('outcome_unknown', status, new Headers(d.init.headers).get('Idempotency-Key') ?? undefined);
      throw error;
    }
  };
  return {
    status: () => send(affinePilotRequests.status(), parseNativePreparationCatalog) as Promise<NativePreparationCatalog>,
    preparation: async (id: string) => {
      const value = await send(affinePilotRequests.preparation(id), parseNativePreparation) as NativePreparation;
      if (value.id !== id) throw new Error('Preparation identity changed.'); return value;
    },
    review: (v: AffineCheckpointReviewInput) => send(affinePilotRequests.review(v), value => {
      const review = parseNativePreparationReview(value);
      if (review.repository !== nativeRepository(v.repository) || review.sessionId !== v.sessionId || review.maxCostMicroUsd !== v.maxCostMicroUsd || (/^[a-f0-9]{40}$/.test(v.reference) && review.revision !== v.reference)) throw new Error('Checkpoint review inputs changed.');
      return review;
    }) as Promise<NativePreparationReview>,
    prepare: (v: AffineCheckpointPrepareInput) => send(affinePilotRequests.prepare(v), value => {
      const prepared = parseNativePreparation(value);
      if (prepared.repository !== nativeRepository(v.repository) || ['revision', 'sessionId', 'maxCostMicroUsd', 'policyDigest'].some(k => prepared[k as keyof NativePreparation] !== v[k as keyof AffineCheckpointPrepareInput])) throw new Error('Checkpoint preparation inputs changed.');
      return prepared;
    }) as Promise<NativePreparation>,
    evaluationPrepare: (v: AffineEvaluationPrepareInput) => send(affinePilotRequests.evaluationPrepare(v), value => {
      const prepared = parseAffineEvaluationPrepared(value);
      if (Object.entries(v).some(([k, expected]) => prepared.request[k as keyof AffineEvaluationRequest] !== expected)) throw new Error('Evaluation preparation inputs changed.');
      return prepared;
    }) as Promise<ReturnType<typeof parseAffineEvaluationPrepared>>,
    uploadRequest: (r: AffineEvaluationRequest, filename: string, rightsConfirmed: true) => send(affinePilotRequests.uploadRequest(r, filename, rightsConfirmed), value => envelope(value, 'file')),
    saveDraft: (p: ReturnType<typeof parseAffineEvaluationPrepared>, name: string, requestKey: string) => send(affinePilotRequests.saveDraft(p, name, requestKey), value => {
      const result = envelope(value, 'resource'), resource = result['resource'] as Record<string, unknown>;
      if (!integer(resource['revision'], 1) || resource['kind'] !== 'training' || resource['name'] !== name.trim()) throw new Error('Saved draft differs from requested identity.');
      return result;
    }),
    quote: (v: AffineTrainingInput) => send(affinePilotRequests.quote(v), value => {
      const result = envelope(value, 'quote'), quote = result['quote'] as Record<string, unknown>;
      if (Object.entries(v).some(([k, expected]) => quote[k] !== expected) || !integer(quote['expiresAt'], 1) || !integer(quote['maxCostMicroUsd'], 1)) throw new Error('Quote differs from saved inputs.');
      return result;
    }),
    start: (v: AffineTrainingInput & { approveExecution: true; quoteId?: string }, requestKey: string) => send(affinePilotRequests.start(v, requestKey), value => {
      const result = envelope(value, 'task'), task = result['task'] as Record<string, unknown>;
      if (task['resourceId'] !== v.draftId || task['resourceRevision'] !== v.revision || task['datasetId'] !== v.datasetId) throw new Error('Task differs from approved inputs.');
      return result;
    }),
    task: (id: string) => send(affinePilotRequests.task(id), value => {
      const result = envelope(value, 'task');
      if ((result['task'] as Record<string, unknown>)['id'] !== id) throw new Error('Task identity changed.');
      return result;
    }),
    artifact: (taskId: string, artifactId: string, range: { offset: number; maxBytes: number }) => send(affinePilotRequests.artifact(taskId, artifactId, range), v => { if (!(v instanceof Uint8Array)) throw new Error('Unexpected artifact bytes.'); return v; }) as Promise<Uint8Array>,
  };
}
function envelope(v: unknown, name: string): Record<string, unknown> {
  const result = object(v), child = object(result[name]);
  if (typeof child['id'] !== 'string') throw new Error('Missing response identity.');
  identifier(child['id']); return result;
}
function object(v: unknown): Record<string, unknown> { if (!record(v)) throw new Error('Unexpected API response.'); return v; }

export type AffinePilotTransportOptions = { apiKey: string; resourcesApiKey?: string; origin?: string; fetch?: typeof fetch; timeoutMs?: number };
/** Narrow customer-key transport; resources:write and training:write are distinct credentials. */
export function createAffinePilotTransport(options: AffinePilotTransportOptions) {
  let origin: URL;
  try { origin = new URL(options.origin ?? 'https://api.reliqua.ai'); } catch { throw new GenerationApiError('invalid_origin'); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new GenerationApiError('invalid_origin');
  for (const credential of [options.apiKey, options.resourcesApiKey]) if (credential !== undefined && (!credential || credential.length > 4096 || /[\x00-\x20\x7f]/.test(credential))) throw new GenerationApiError('invalid_credential');
  const timeout = options.timeoutMs ?? 15_000;
  if (!integer(timeout, 1, 60_000)) throw new GenerationApiError('invalid_timeout');
  const request: AffinePilotTransport = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    const artifact = /^\/api\/v1\/training\/tasks\/[\w-]{1,64}\/artifacts\/[\w-]{1,64}$/.test(path);
    const read = path === root + '/preparations' || new RegExp('^' + root + '/preparations/[\\w-]{1,64}$').test(path) || /^\/api\/v1\/training\/tasks\/[\w-]{1,64}$/.test(path) || artifact;
    const write = [root + '/preparations/review', root + '/preparations', root + '/prepare', '/api/v1/training/files', '/api/resources', '/api/v1/training/quotes', '/api/v1/training/tasks'].includes(path);
    if (!(method === 'GET' ? read : method === 'POST' && write)) throw new GenerationApiError('invalid_route');
    const credential = path === '/api/resources' ? options.resourcesApiKey : options.apiKey;
    if (!credential) throw new GenerationApiError('credential_required');
    const supplied = new Headers(init.headers), headers = new Headers({ Authorization: `Bearer ${credential}`, Accept: artifact ? 'application/octet-stream' : 'application/json' });
    for (const name of ['Content-Type', 'Idempotency-Key', 'X-Dataset-Format', 'X-Filename', 'X-Data-Authorized']) if (supplied.has(name)) headers.set(name, supplied.get(name)!);
    let limit = 4 * 1024 * 1024;
    if (artifact) {
      const range = supplied.get('Range')?.match(/^bytes=(\d+)-(\d+)$/);
      if (!range || !integer(Number(range[1]), 0) || !integer(Number(range[2]), Number(range[1])) || Number(range[2]) - Number(range[1]) + 1 > 262144) throw new GenerationApiError('invalid_range');
      headers.set('Range', supplied.get('Range')!); limit = Number(range[2]) - Number(range[1]) + 1;
    }
    if (init.body != null && (method !== 'POST' || typeof init.body !== 'string' || new TextEncoder().encode(init.body).byteLength > 32768)) throw new GenerationApiError('request_too_large');
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const mutation = method === 'POST';
    let status: number | undefined, diagnostics: ReturnType<typeof responseDiagnostics> = { requestId: undefined, retryAfterSeconds: undefined };
    const fail = (code: string) => new GenerationApiError(code, status, headers.get('Idempotency-Key') ?? undefined, undefined, diagnostics.requestId, diagnostics.retryAfterSeconds);
    try {
      const response = await (options.fetch ?? fetch)(new URL(path, origin), { method, headers, ...(init.body == null ? {} : { body: init.body }), credentials: 'omit', redirect: 'manual', signal });
      status = response.status; diagnostics = responseDiagnostics(response.headers);
      if (status >= 300 && status < 400) { await response.body?.cancel(); throw fail(mutation ? 'outcome_unknown' : 'redirect_refused'); }
      if (Number(response.headers.get('Content-Length')) > limit) { await response.body?.cancel(); throw fail(mutation ? 'outcome_unknown' : 'response_too_large'); }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      if (reader) try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) { await reader.cancel(); throw fail(mutation ? 'outcome_unknown' : 'response_too_large'); } chunks.push(next.value); } } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (!response.ok) {
        if (mutation && (status >= 500 || status === 408)) throw fail('outcome_unknown');
        let code = `http_${status}`; try { const v = JSON.parse(new TextDecoder().decode(bytes)); if (record(v.error) && /^[a-z][a-z0-9_]{0,79}$/.test(v.error.code)) code = v.error.code; } catch { /* Keep definite HTTP refusal. */ }
        throw fail(code);
      }
      if (artifact) {
        const match = response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        const requested = headers.get('Range')!.match(/^bytes=(\d+)-(\d+)$/)!;
        if (status === 200 && Number(requested[1]) === 0 && size <= limit && !response.headers.has('Content-Range')) return bytes;
        if (status !== 206 || !match || match[1] !== requested[1] || Number(match[2]) > Number(requested[2]) || Number(match[2]) - Number(match[1]) + 1 !== size || Number(match[3]) <= Number(match[2])) throw fail('invalid_response');
        return bytes;
      }
      try { return object(JSON.parse(new TextDecoder().decode(bytes))); } catch { throw fail(mutation ? 'outcome_unknown' : 'invalid_response'); }
    } catch (error) { if (error instanceof GenerationApiError) throw error; throw fail(mutation ? 'outcome_unknown' : signal.aborted ? 'request_aborted' : 'upstream_unavailable'); }
  };
  return { request };
}
