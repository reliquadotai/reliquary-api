import { JobApiError } from './job-errors.js';
import { responseDiagnostics } from './error-diagnostics.js';

export type JobJsonTransport = (path: string, init?: RequestInit) => Promise<unknown>;
export type JobsTransportOptions = { origin?: string; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number };
const token = '[A-Za-z0-9_-]{1,100}';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const job = `cpu%3A${uuid}`;
const jobsRead = new RegExp(`^/api/v1/jobs(?:/capabilities|/${job}(?:/events|/artifacts/${token})?)?$`);
const jobsWrite = new RegExp(`^/api/v1/jobs(?:/${job}/(?:cancel|pause|resume))?$`);
const workersRead = /^\/api\/v1\/job-workers$/;
const workersWrite = new RegExp(`^/api/v1/job-workers(?:/${uuid}/revoke)?$`);

async function bytes(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('Content-Length')) > limit) { await response.body?.cancel(); throw new JobApiError('response_too_large'); }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new JobApiError('response_too_large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** Customer key routes only. Browser clients inject their session transport. */
export function createJobsTransport(options: JobsTransportOptions = {}) {
  let origin: URL;
  try { origin = new URL(options.origin ?? 'https://api.reliqua.ai'); } catch { throw new JobApiError('invalid_origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new JobApiError('invalid_origin');
  const key = options.apiKey;
  if (key !== undefined && (!key || key !== key.trim() || /[\x00-\x20\x7f]/.test(key) || key.length > 4096)) throw new JobApiError('invalid_credential');
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new JobApiError('invalid_timeout');
  const fetcher = options.fetch ?? fetch;
  const request: JobJsonTransport = async (path, init = {}) => {
    const url = new URL(path, origin);
    const method = init.method ?? 'GET';
    const mutation = method === 'POST';
    const query = url.searchParams;
    const canPage = url.pathname === '/api/v1/jobs' || new RegExp(`^/api/v1/jobs/${job}/events$`).test(url.pathname);
    if (url.origin !== origin.origin || !path.startsWith('/api/v1/') || path !== url.pathname + url.search || url.hash ||
        (method === 'GET' ? !(jobsRead.test(url.pathname) || workersRead.test(url.pathname)) : method !== 'POST' || !(jobsWrite.test(url.pathname) || workersWrite.test(url.pathname) || url.pathname === '/api/v1/job-inputs')) ||
        (url.search && (!canPage || method !== 'GET' || [...query.keys()].some(k => !['cursor', 'limit'].includes(k)) ||
          query.getAll('cursor').length > 1 || query.getAll('limit').length > 1 ||
          (query.has('cursor') && !/^[A-Za-z0-9_-]{1,512}$/.test(query.get('cursor')!)) ||
          (query.has('limit') && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(query.get('limit')!))))) throw new JobApiError('invalid_route');
    if (!key) throw new JobApiError('credential_required');
    const headers = new Headers(init.headers);
    for (const name of ['Cookie', 'Authorization', 'X-Action-Proof', 'X-XSRF-TOKEN']) headers.delete(name);
    headers.set('Authorization', `Bearer ${key}`);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string' || new TextEncoder().encode(init.body).length > (url.pathname === '/api/v1/job-inputs' ? 256 * 1024 : 32 * 1024)) throw new JobApiError('request_too_large');
      headers.set('Content-Type', 'application/json');
    }
    const requestKey = headers.get('Idempotency-Key') ?? undefined;
    const revision = headers.get('X-Resource-Revision') ?? undefined;
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let status: number | undefined;
    let diagnostics: ReturnType<typeof responseDiagnostics> = { requestId: undefined, retryAfterSeconds: undefined };
    const failure = (code: string) => new JobApiError(code, status, requestKey, revision, diagnostics.requestId, diagnostics.retryAfterSeconds);
    try {
      const response = await fetcher(url, { method, headers, ...(init.body == null ? {} : { body: init.body }), signal, redirect: 'manual', credentials: 'omit' });
      status = response.status;
      diagnostics = responseDiagnostics(response.headers);
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw failure(mutation ? 'outcome_unknown' : 'redirect_refused'); }
      const body = await bytes(response, 4 * 1024 * 1024);
      if (!response.ok) {
        if (mutation && (response.status >= 500 || response.status === 408)) throw failure('outcome_unknown');
        let code = `http_${response.status}`;
        try {
          const value: unknown = JSON.parse(new TextDecoder().decode(body));
          if (value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' && 'code' in value.error && typeof value.error.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value.error.code)) code = value.error.code;
        } catch { /* Definite server refusals can use plain text. */ }
        throw failure(code);
      }
      try {
        const value: unknown = JSON.parse(new TextDecoder().decode(body));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value;
      } catch { throw failure(mutation ? 'outcome_unknown' : 'invalid_response'); }
    } catch (error) {
      if (error instanceof JobApiError) {
        if (error.code === 'response_too_large') throw failure(mutation ? 'outcome_unknown' : error.code);
        throw error;
      }
      throw failure(mutation ? 'outcome_unknown' : signal.aborted ? 'request_aborted' : 'upstream_unavailable');
    }
  };
  return { request };
}
