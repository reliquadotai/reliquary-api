import { responseDiagnostics } from './error-diagnostics.js';
import { parseProductInventory, parseGenerationCatalog } from './product-inventory.js';
import { GenerationApiError } from './generation.js';

const paths = {
  health: '/api/health', readiness: '/api/ready', inventory: '/api/inventory',
  compute: '/api/compute/catalog', network: '/api/network',
  generation: '/api/v1/generation/catalog', evaluations: '/api/v1/evaluations/catalog',
} as const;
export type PublicRead = keyof typeof paths;
export type PublicClientOptions = { origin?: string; timeoutMs?: number; fetch?: typeof fetch };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Public GETs never attach credentials, follow redirects or retry. */
export function createPublicClient(options: PublicClientOptions = {}) {
  let origin: URL;
  try { origin = new URL(options.origin ?? 'https://api.reliqua.ai'); }
  catch { throw new GenerationApiError('invalid_origin'); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))))
    throw new GenerationApiError('invalid_origin');
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new GenerationApiError('invalid_timeout');
  const read = async (name: PublicRead, callerSignal?: AbortSignal): Promise<Record<string, unknown>> => {
    if (!Object.hasOwn(paths, name)) throw new GenerationApiError('invalid_route');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let status: number | undefined;
    let diagnostics: ReturnType<typeof responseDiagnostics> = { requestId: undefined, retryAfterSeconds: undefined };
    const failure = (code: string) => new GenerationApiError(code, status, undefined, undefined, diagnostics.requestId, diagnostics.retryAfterSeconds);
    try {
      const response = await (options.fetch ?? fetch)(new URL(paths[name], origin), {
        method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'manual', signal,
      });
      status = response.status;
      diagnostics = responseDiagnostics(response.headers);
      if (status >= 300 && status < 400) { await response.body?.cancel(); throw failure('redirect_refused'); }
      const limit = 4 * 1024 * 1024;
      if (Number(response.headers.get('Content-Length')) > limit) { await response.body?.cancel(); throw failure('response_too_large'); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); throw failure('response_too_large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw failure(response.ok ? 'invalid_response' : `http_${status}`); }
      if (!response.ok) {
        const code = record(value) && record(value['error']) ? value['error']['code'] : undefined;
        throw failure(typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : `http_${status}`);
      }
      if (!record(value)) throw failure('invalid_response');
      return value;
    } catch (error) {
      if (error instanceof GenerationApiError) throw error;
      throw failure(signal.aborted ? 'request_aborted' : 'upstream_unavailable');
    }
  };
  return {
    read,
    inventory: async (signal?: AbortSignal) => parseProductInventory(await read('inventory', signal)),
    generation: async (signal?: AbortSignal) => parseGenerationCatalog(await read('generation', signal)),
    compute: async (signal?: AbortSignal) => {
      const data = await read('compute', signal);
      if (!Array.isArray(data['offers']) || !Array.isArray(data['sources']) || data['offers'].length > 20_000 ||
          !data['offers'].every((offer: unknown) => record(offer) && typeof offer['gpu'] === 'string' &&
            typeof offer['provider'] === 'string' && Number.isSafeInteger(offer['gpuCount']) && Number(offer['gpuCount']) > 0 &&
            Number.isSafeInteger(offer['priceMicroUsdPerHour']) && Number(offer['priceMicroUsdPerHour']) >= 0))
        throw new GenerationApiError('invalid_response');
      return data as Record<string, unknown> & { offers: Record<string, unknown>[]; sources: unknown[] };
    },
  };
}
