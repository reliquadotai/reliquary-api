import { GenerationApiError, generationRequests, MAX_FILE_CHUNK_BYTES, type FileRange, type GenerationJsonTransport } from './generation.js';
import { responseDiagnostics } from './error-diagnostics.js';

export type GenerationFileChunk = { bytes: Uint8Array; contentType: string; contentRange: string | null };
export type GenerationTransportOptions = {
  origin?: string; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number;
};
async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('Content-Length')) > limit) {
    await response.body?.cancel(); throw new GenerationApiError('response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new GenerationApiError('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Scoped customer key transport. Browser callers inject their existing session transport instead. */
export function createGenerationTransport(options: GenerationTransportOptions = {}) {
  let origin: URL;
  try { origin = new URL(options.origin ?? 'https://api.reliqua.ai'); } catch { throw new GenerationApiError('invalid_origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new GenerationApiError('invalid_origin');
  const key = options.apiKey;
  if (key !== undefined && (!key || key !== key.trim() || /[\x00-\x20\x7f]/.test(key) || key.length > 4096)) throw new GenerationApiError('invalid_credential');
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new GenerationApiError('invalid_timeout');
  const fetcher = options.fetch ?? fetch;
  const exchange = async (path: string, init: RequestInit, fileLimit?: number) => {
    const url = new URL(path, origin);
    const method = init.method ?? 'GET';
    const mutating = method !== 'GET';
    const allowed = /^\/api\/v1\/dataset-orders(?:\/quotes|\/[\w-]{1,64}(?:\/cancel|\/deliveries\/[\w-]{1,80}\/files\/[^/]{1,200})?)?$/.test(url.pathname);
    const publicRead = url.pathname === '/api/v1/generation/catalog' && method === 'GET';
    if (!path.startsWith('/api/v1/') || path !== url.pathname || url.origin !== origin.origin || url.hash || url.search ||
        (!allowed && !publicRead) || !['GET', 'POST'].includes(method)) throw new GenerationApiError('invalid_route');
    if (!publicRead && !key) throw new GenerationApiError('credential_required');
    const headers = new Headers(init.headers);
    headers.delete('Cookie'); headers.delete('Authorization');
    headers.set('Accept', fileLimit === undefined ? 'application/json' : '*/*');
    if (!publicRead) headers.set('Authorization', `Bearer ${key}`);
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string' || new TextEncoder().encode(init.body).length > 32 * 1024) throw new GenerationApiError('request_too_large');
      headers.set('Content-Type', 'application/json');
    }
    const retryKey = headers.get('Idempotency-Key') ?? undefined;
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let status: number | undefined;
    let diagnostics: ReturnType<typeof responseDiagnostics> = { requestId: undefined, retryAfterSeconds: undefined };
    const failure = (code: string) => new GenerationApiError(code, status, retryKey, undefined, diagnostics.requestId, diagnostics.retryAfterSeconds);
    try {
      const response = await fetcher(url, { method, headers, ...(init.body == null ? {} : { body: init.body }), signal, redirect: 'manual', credentials: 'omit' });
      status = response.status;
      diagnostics = responseDiagnostics(response.headers);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel(); throw failure(mutating ? 'outcome_unknown' : 'redirect_refused');
      }
      const bytes = await boundedBody(response, response.ok && fileLimit !== undefined ? fileLimit : 4 * 1024 * 1024);
      if (!response.ok) {
        if (mutating && response.status >= 500) throw failure('outcome_unknown');
        let code = `http_${response.status}`;
        try {
          const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' && 'code' in value.error &&
              typeof value.error.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value.error.code)) code = value.error.code;
        } catch { /* A refusal may use a plain-text body. */ }
        throw failure(code);
      }
      return { response, bytes };
    } catch (error) {
      if (error instanceof GenerationApiError) {
        if (error.code === 'response_too_large') throw failure(mutating ? 'outcome_unknown' : error.code);
        throw error;
      }
      throw failure(mutating ? 'outcome_unknown' : signal.aborted ? 'request_aborted' : 'upstream_unavailable');
    }
  };
  const request: GenerationJsonTransport = async (path, init = {}) => {
    const { response, bytes } = await exchange(path, init);
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      const diagnostics = responseDiagnostics(response.headers);
      throw new GenerationApiError(init.method === 'POST' ? 'outcome_unknown' : 'invalid_response', response.status, new Headers(init.headers).get('Idempotency-Key') ?? undefined, undefined, diagnostics.requestId, diagnostics.retryAfterSeconds);
    }
  };
  return {
    request,
    download: async (orderId: string, deliveryId: string, name: string, range: FileRange = { offset: 0, maxBytes: MAX_FILE_CHUNK_BYTES }, signal?: AbortSignal): Promise<GenerationFileChunk> => {
      const descriptor = generationRequests().download(orderId, deliveryId, name, range);
      const { response, bytes } = await exchange(descriptor.path, { headers: descriptor.headers, ...(signal ? { signal } : {}) }, range.maxBytes);
      if (response.status === 206) {
        const contentRange = response.headers.get('Content-Range');
        const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!match || !match.slice(1).every(value => Number.isSafeInteger(Number(value))) || Number(match[1]) !== range.offset || Number(match[2]) < range.offset ||
            Number(match[2]) >= range.offset + range.maxBytes || Number(match[2]) >= Number(match[3]) ||
            bytes.length !== Number(match[2]) - Number(match[1]) + 1) throw new GenerationApiError('invalid_file_range');
      } else if (response.status !== 200 || range.offset !== 0) throw new GenerationApiError('invalid_file_range');
      return { bytes, contentType: response.headers.get('Content-Type') ?? 'application/octet-stream', contentRange: response.headers.get('Content-Range') };
    },
  };
}
