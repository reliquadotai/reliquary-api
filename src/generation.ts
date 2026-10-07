import {
  parseBatchOrderResponse, parseBatchOrders, parseBatchQuote,
  parseGenerationOrderResponse, parseGenerationOrders,
  type BatchOrderDetail, type BatchOrdersResponse, type BatchQuote, type BatchQuoteInput,
  type GenerationOrderDetail, type GenerationOrdersResponse,
} from './batch-orders.js';
import { parseGenerationCatalog, type GenerationCatalog } from './product-inventory.js';

export type GenerationAudience = 'browser' | 'key';
export type GenerationOperation = 'catalog' | 'quote' | 'orders' | 'order';
export type GenerationRequest = {
  path: string; method?: 'GET' | 'POST'; headers?: Record<string, string>;
  json?: unknown; download?: boolean;
};
export type FileRange = { offset: number; maxBytes: number };
export const MAX_FILE_CHUNK_BYTES = 262_144;
export class GenerationApiError extends Error {
  constructor(public readonly code: string, public readonly status?: number, public readonly retryKey?: string, message?: string) {
    super(message ?? `API request failed: ${code}.`);
  }
}
const orderId = (id: string) => {
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error('This order link is invalid.');
  return encodeURIComponent(id);
};
const deliveryId = (id: string) => {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error('This delivery link is invalid.');
  return encodeURIComponent(id);
};
const fileName = (name: string) => {
  if (!name || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/.test(name) ||
      encodeURIComponent(name).length > 200) throw new Error('This file link is invalid.');
  return encodeURIComponent(name);
};

export function parseGenerationQuoteInput(value: unknown): BatchQuoteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid quote request.');
  const input = value as Record<string, unknown>;
  const pinned = Object.hasOwn(input, 'revision') || Object.hasOwn(input, 'env');
  const fields = ['model', 'prompt_count', 'samples_per_prompt', 'max_new_tokens', 'thinking',
    ...(pinned ? ['revision', 'env', 'sampling'] : ['source'])];
  const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
  if (Object.keys(input).some(k => !fields.includes(k)) || !text(input['model'], 200) ||
      !int(input['prompt_count'], 1, 1_000_000) || !int(input['samples_per_prompt'], 1, 64) ||
      !int(input['max_new_tokens'], 16, pinned ? 131_072 : 32_768) || typeof input['thinking'] !== 'boolean')
    throw new Error('Invalid quote request.');
  if (pinned) {
    if (!/^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/.test(input['model']) || input['model'].includes('..') ||
        typeof input['revision'] !== 'string' || !/^[a-f0-9]{40}$/.test(input['revision']) ||
        typeof input['env'] !== 'string' || !/^[\w.-]{1,64}$/.test(input['env'])) throw new Error('Invalid pinned quote request.');
    const sampling = input['sampling'];
    if (sampling !== undefined) {
      if (!sampling || typeof sampling !== 'object' || Array.isArray(sampling)) throw new Error('Invalid sampling.');
      const values = sampling as Record<string, unknown>;
      if (Object.keys(values).some(k => !['temperature', 'top_p', 'top_k'].includes(k)) ||
          (values['temperature'] !== undefined && !(typeof values['temperature'] === 'number' && values['temperature'] > 0 && values['temperature'] <= 2)) ||
          (values['top_p'] !== undefined && !(typeof values['top_p'] === 'number' && values['top_p'] >= 0.01 && values['top_p'] <= 1)) ||
          (values['top_k'] !== undefined && values['top_k'] !== -1 && !int(values['top_k'], 1, 1000))) throw new Error('Invalid sampling.');
    }
  } else if (!text(input['source'], 200)) throw new Error('Invalid catalogue quote request.');
  return value as BatchQuoteInput;
}

export function generationRequests(audience: GenerationAudience = 'key') {
  const root = audience === 'browser' ? '/api/batch/orders' : '/api/v1/dataset-orders';
  const path = (id: string) => root + '/' + orderId(id);
  return {
    catalog: (): GenerationRequest => ({ path: audience === 'browser' ? '/api/batch/catalog' : '/api/v1/generation/catalog' }),
    quote: (input: BatchQuoteInput): GenerationRequest => ({ path: audience === 'browser' ? '/api/batch/quotes' : root + '/quotes', method: 'POST', json: parseGenerationQuoteInput(input) }),
    create: (quoteId: string, requestKey: string): GenerationRequest => {
      if (!/^[\w-]{1,64}$/.test(quoteId) || !/^[\w-]{16,80}$/.test(requestKey)) throw new Error('This confirmation could not be verified. Request a new quote.');
      return { path: root, method: 'POST', headers: { 'Idempotency-Key': requestKey }, json: { quote_id: quoteId } };
    },
    orders: (): GenerationRequest => ({ path: root }),
    detail: (id: string): GenerationRequest => ({ path: path(id) }),
    cancel: (id: string): GenerationRequest => ({ path: path(id) + '/cancel', method: 'POST', json: {} }),
    download: (id: string, delivery: string, name: string, range?: FileRange): GenerationRequest => {
      if (range && (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.maxBytes) ||
          range.maxBytes < 1 || range.maxBytes > MAX_FILE_CHUNK_BYTES || range.offset > Number.MAX_SAFE_INTEGER - range.maxBytes)) throw new Error('Invalid file range.');
      return { path: path(id) + '/deliveries/' + deliveryId(delivery) + '/files/' + fileName(name), download: true,
        ...(range ? { headers: { Range: `bytes=${range.offset}-${range.offset + range.maxBytes - 1}` } } : {}) };
    },
  };
}

export function assertGenerationQuoteMatches(quote: BatchQuote, input: BatchQuoteInput): void {
  if (quote.model !== input.model || quote.prompt_count !== input.prompt_count || quote.samples_per_prompt !== input.samples_per_prompt ||
      quote.max_new_tokens !== input.max_new_tokens || quote.thinking !== input.thinking ||
      ('source' in input ? !('source' in quote) || quote.source !== input.source : !('revision' in quote) ||
        quote.revision !== input.revision || quote.env !== input.env ||
        (input.sampling && Object.entries(input.sampling).some(([key, value]) => quote.sampling[key as keyof typeof quote.sampling] !== value))))
    throw new Error('The quoted configuration changed. Request a new quote.');
}
export function parseGenerationResponse(operation: GenerationOperation, value: unknown, audience: GenerationAudience = 'key', expected: { input?: BatchQuoteInput; id?: string } = {}) {
  switch (operation) {
    case 'catalog': return parseGenerationCatalog(value);
    case 'quote': {
      const quote = parseBatchQuote(value);
      if (expected.input) assertGenerationQuoteMatches(quote, expected.input);
      return quote;
    }
    case 'orders': return audience === 'browser' ? parseBatchOrders(value) : parseGenerationOrders(value);
    case 'order': {
      const order = audience === 'browser' ? parseBatchOrderResponse(value) : parseGenerationOrderResponse(value);
      if (expected.id !== undefined && order.id !== expected.id) throw new Error('The order response did not match this request.');
      return { order };
    }
  }
}
export type GenerationJsonTransport = (path: string, init?: RequestInit) => Promise<unknown>;
type GenerationClient<Order, Orders> = {
  catalog(signal?: AbortSignal): Promise<GenerationCatalog>;
  quote(input: BatchQuoteInput, signal?: AbortSignal): Promise<BatchQuote>;
  create(quoteId: string, requestKey: string): Promise<Order>;
  orders(signal?: AbortSignal): Promise<Orders>;
  detail(id: string, signal?: AbortSignal): Promise<Order>;
  cancel(id: string): Promise<Order>;
  downloadPath(id: string, deliveryId: string, name: string): string;
};
export function createGenerationClient(request: GenerationJsonTransport, options: { audience: 'browser' }): GenerationClient<BatchOrderDetail, BatchOrdersResponse>;
export function createGenerationClient(request: GenerationJsonTransport, options?: { audience: 'key' }): GenerationClient<GenerationOrderDetail, GenerationOrdersResponse>;
export function createGenerationClient(request: GenerationJsonTransport, options: { audience: GenerationAudience } = { audience: 'key' }) {
  const audience = options.audience;
  const requests = generationRequests(audience);
  const call = async (r: GenerationRequest, signal?: AbortSignal) => {
    try {
      return await request(r.path, {
        ...(r.method ? { method: r.method } : {}), ...(r.headers ? { headers: r.headers } : {}),
        ...(r.json !== undefined ? { body: JSON.stringify(r.json) } : {}), ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (r.method !== 'POST') throw error;
      if (error instanceof GenerationApiError && ['outcome_unknown', 'credential_required', 'invalid_origin', 'invalid_route', 'invalid_credential', 'invalid_timeout', 'request_too_large', 'writes_disabled'].includes(error.code)) throw error;
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) throw error;
      throw new GenerationApiError('outcome_unknown', typeof status === 'number' ? status : undefined, r.headers?.['Idempotency-Key']);
    }
  };
  const parseOrder = (v: unknown) => audience === 'browser' ? parseBatchOrderResponse(v) : parseGenerationOrderResponse(v);
  const owned = (v: unknown, id: string) => {
    const order = parseOrder(v);
    if (order.id !== id) throw new Error('The order response did not match this request.');
    return order;
  };
  return {
    catalog: async (signal?: AbortSignal) => parseGenerationCatalog(await call(requests.catalog(), signal)),
    quote: async (input: BatchQuoteInput, signal?: AbortSignal) => {
      const quote = parseBatchQuote(await call(requests.quote(input), signal));
      assertGenerationQuoteMatches(quote, input);
      return quote;
    },
    create: async (quoteId: string, requestKey: string) => {
      const value = await call(requests.create(quoteId, requestKey));
      try { return parseOrder(value); }
      catch { throw new GenerationApiError('outcome_unknown', undefined, requestKey); }
    },
    orders: async (signal?: AbortSignal) => {
      const value = await call(requests.orders(), signal);
      return audience === 'browser' ? parseBatchOrders(value) : parseGenerationOrders(value);
    },
    detail: async (id: string, signal?: AbortSignal) => owned(await call(requests.detail(id), signal), id),
    cancel: async (id: string) => {
      const value = await call(requests.cancel(id));
      let order;
      try { order = parseOrder(value); }
      catch { throw new GenerationApiError('outcome_unknown'); }
      if (order.id !== id) throw new GenerationApiError('outcome_unknown', undefined, undefined, 'The cancellation response did not match this order.');
      return order;
    },
    downloadPath: (id: string, delivery: string, name: string) => requests.download(id, delivery, name).path,
  };
}
