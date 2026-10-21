import { GenerationApiError, type FileRange, type GenerationJsonTransport, type GenerationRequest, MAX_FILE_CHUNK_BYTES } from './generation.js';

export type EvaluationSampling = { temperature: number; top_p: number; top_k: number; seed: number };
export type EvaluationSetInput = { env: string; set_id: string; problems: number; samples: number };
export type EvaluationQuoteInput = {
  model: string; revision: string; envs: EvaluationSetInput[]; max_new_tokens: number;
  thinking?: boolean; sampling?: Partial<EvaluationSampling>; mode?: 'subnet' | 'direct';
  model_access?: 'public' | 'private'; harness?: string; max_turns?: number;
  max_episode_tokens?: number; episode_timeout_seconds?: number;
};
export type EvaluationProtocol = Record<string, unknown>;
export type EvaluationCatalog = {
  ordering: 'pilot' | 'disabled'; modes: ('subnet' | 'direct')[]; default_mode: 'subnet' | 'direct';
  max_problems_per_env: number; max_problems: number; gpu_counts: number[];
  envs: { env: string; sets: { set_id: string; name: string; description: string; count: number;
    default_max_new_tokens: number; thinking: boolean; qualified_support: boolean; protocol: EvaluationProtocol | null; protocol_json: string | null; protocol_sha256: string | null }[] }[];
};
type EvaluationConfiguration = {
  mode: 'subnet' | 'direct'; model: { repo: string; revision: string }; envs: EvaluationSetInput[];
  max_new_tokens: number; thinking: boolean; sampling: EvaluationSampling; model_access: 'public' | 'private';
  harness: string | null; max_turns: number | null; max_episode_tokens: number | null; episode_timeout_seconds: number | null;
  protocol: EvaluationProtocol | null; protocol_json: string | null; protocol_sha256: string | null; protocol_bindings: Record<string, string> | null;
};
export type EvaluationQuote = EvaluationConfiguration & {
  quote_id: string; price_usd: number; est_price_usd: number; est_tokens: number; max_tokens: number;
  eta_hours: number; max_hours: number; expires_at: string; gpu_count: number; weight_bytes: number;
  pricing: Record<string, unknown>;
};
export const EVALUATION_STATES = ['reserved', 'provisioning', 'generating', 'qualifying', 'queued', 'running', 'draining', 'grading', 'delivered', 'cancelled', 'failed'] as const;
export type EvaluationState = (typeof EVALUATION_STATES)[number];
export type EvaluationMetrics = {
  n_problems: number; samples: number; complete: boolean;
  n_problems_graded: number | null; missing_problems: number | null; expected_rows: number | null; graded_rows: number | null;
  ungraded_rows: number | null; missing_rows: number | null;
  requested_samples: number | null; attempted_samples: number | null; completed_samples: number | null; graded_samples: number | null;
  mean_score: number | null; truncation_rate: number | null;
  format_failure_rate: number | null; mean_completion_tokens: number | null; mean_turns: number | null;
  tool_calls_total: number | null; stop_reasons: Record<string, number> | null;
  'pass@1': { value: number; ci95: [number, number] }; 'pass@k': Record<string, number>;
};
export type EvaluationSummary = { complete: boolean; envs: Record<string, EvaluationMetrics>; macro: { 'pass@1': number; 'pass@k': Record<string, number> } };
export type EvaluationOrder = EvaluationConfiguration & {
  id: string; eval_id: string | null; quote_id: string | null; client_ref: string | null; status: EvaluationState;
  cancel_requested: boolean; gpu_count: number; price_usd: number; status_reason: string | null;
  needs_attention: boolean; complete: boolean | null; progress: unknown; created_at: string; updated_at: string; finished_at: string | null;
  refunded_usd?: number; summary?: EvaluationSummary | null; generation?: Record<string, unknown> | null;
  files?: { name: string; size: number; sha256: string | null; url: string }[];
};
export type EvaluationReport = {
  schema: 'reliquary/eval-report/v2'; eval_id: string; created_at: number | null; complete: boolean;
  envs: Record<string, EvaluationMetrics>; counts: { malformed_rows: number; unexpected_rows: number };
  provenance: Record<string, unknown>; protocol: EvaluationProtocol | null; protocol_json: string | null; protocol_sha256: string | null;
  protocol_bindings: Record<string, string> | null; macro: { 'pass@1': number; 'pass@k': Record<string, number> };
};
const fail = (): never => { throw new Error('Invalid evaluation response.'); };
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const text = (v: unknown, max = 200): string => typeof v === 'string' && v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : fail();
const bool = (v: unknown): boolean => typeof v === 'boolean' ? v : fail();
const number = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail();
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => Number.isSafeInteger(v) ? number(v, min, max) : fail();
const choice = <T extends string>(v: unknown, values: readonly T[]): T => values.includes(v as T) ? v as T : fail();
const list = (v: unknown, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : fail();
const nullable = <T>(v: unknown, parse: (value: unknown) => T): T | null => v == null ? null : parse(v);
const id = (v: unknown): string => /^[\w-]{1,64}$/.test(text(v, 64)) ? v as string : fail();
const setId = (v: unknown): string => /^[\w.-]{1,128}$/.test(text(v, 128)) ? v as string : fail();
const digest = (v: unknown): string => /^[a-f0-9]{64}$/.test(text(v, 64)) ? v as string : fail();
const time = (v: unknown): string => Number.isFinite(Date.parse(text(v, 40))) ? v as string : fail();
const unique = <T>(items: T[], key: (item: T) => string): T[] => new Set(items.map(key)).size === items.length ? items : fail();
const clientRef = (v: unknown): string => /^[A-Za-z0-9][A-Za-z0-9._:/+=@-]{0,127}$/.test(text(v, 128)) ? v as string : fail();
const model = (v: unknown): EvaluationConfiguration['model'] => {
  const m = record(v), repo = text(m['repo'], 194), revision = text(m['revision'], 40);
  if (!/^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/.test(repo) || repo.includes('..') || !/^[a-f0-9]{40}$/.test(revision)) fail();
  return { repo, revision };
};
export function canonicalEvaluationJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(normalize);
    const object = record(v);
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, normalize(object[key])]));
  };
  return JSON.stringify(normalize(value));
}
const protocol = (v: unknown): EvaluationProtocol => {
  const p = record(v);
  if (new TextEncoder().encode(canonicalEvaluationJson(p)).length > 64 * 1024) fail();
  return p;
};
export function parseEvaluationProtocolJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  const stack: { object: boolean; keys: Set<string>; expectingKey: boolean }[] = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g)) {
    const token = match[0], current = stack.at(-1);
    if (token === '{' || token === '[') {
      if (stack.length >= 32) fail();
      stack.push({ object: token === '{', keys: new Set(), expectingKey: token === '{' });
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && current?.object) current.expectingKey = true;
    else if (token[0] === '"' && current?.expectingKey) {
      const key: string = JSON.parse(token);
      if (current.keys.has(key)) throw new Error('Duplicate evaluation protocol key.');
      current.keys.add(key); current.expectingKey = false;
    }
  }
  return parsed;
}
const protocolJson = (raw: unknown, object: unknown): string | null => {
  if (raw == null) return null;
  const value = text(raw, 131072);
  if (new TextEncoder().encode(value).length > 65536 || canonicalEvaluationJson(parseEvaluationProtocolJson(value)) !== canonicalEvaluationJson(object)) fail();
  return value;
};
export async function verifyEvaluationProtocol(value: { protocol: EvaluationProtocol | null; protocol_json: string | null; protocol_sha256: string | null }): Promise<void> {
  if (value.protocol === null && value.protocol_json === null && value.protocol_sha256 === null) return;
  if (!value.protocol || !value.protocol_json || !value.protocol_sha256) fail();
  protocolJson(value.protocol_json, value.protocol);
  const bytes = new TextEncoder().encode(value.protocol_json!);
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== value.protocol_sha256) throw new Error('Frozen evaluation protocol digest changed.');
}
const bindings = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(record(v)).map(([key, value]) => [setId(key), digest(value)]));
const envs = (v: unknown): EvaluationSetInput[] => unique(list(v, 8).map(raw => {
  const e = record(raw);
  return { env: setId(e['env']), set_id: setId(e['set_id']), problems: integer(e['problems'], 1, 5000), samples: integer(e['samples'], 1, 64) };
}), e => e.set_id);
const sampling = (v: unknown): EvaluationSampling => {
  const s = record(v);
  return { temperature: number(s['temperature'], 0, 2), top_p: number(s['top_p'], 0.01, 1), top_k: s['top_k'] === -1 ? -1 : integer(s['top_k'], 1, 1000), seed: integer(s['seed'], 0, 2 ** 31 - 1) };
};
const configuration = (v: Record<string, unknown>): EvaluationConfiguration => ({
  mode: choice(v['mode'], ['subnet', 'direct']), model: model(v['model']), envs: envs(v['envs']),
  max_new_tokens: integer(v['max_new_tokens'], 16, 131072), thinking: bool(v['thinking']), sampling: sampling(v['sampling']),
  model_access: v['model_access'] === undefined ? 'public' : choice(v['model_access'], ['public', 'private']),
  harness: nullable(v['harness'], x => text(x, 200)), max_turns: nullable(v['max_turns'], x => integer(x, 1, 48)),
  max_episode_tokens: nullable(v['max_episode_tokens'], x => integer(x, 1, 65536)),
  episode_timeout_seconds: nullable(v['episode_timeout_seconds'], x => integer(x, 1, 3600)),
  protocol: nullable(v['protocol'], protocol), protocol_json: protocolJson(v['protocol_json'], v['protocol']), protocol_sha256: nullable(v['protocol_sha256'], digest), protocol_bindings: nullable(v['protocol_bindings'], bindings),
});
export function parseEvaluationQuoteInput(value: unknown): EvaluationQuoteInput {
  const v = record(value);
  const fields = ['model', 'revision', 'envs', 'max_new_tokens', 'thinking', 'sampling', 'mode', 'model_access', 'harness', 'max_turns', 'max_episode_tokens', 'episode_timeout_seconds'];
  if (Object.keys(v).some(key => !fields.includes(key))) fail();
  model({ repo: v['model'], revision: v['revision'] });
  const selected = envs(v['envs']);
  if (!selected.length || selected.reduce((n, e) => n + e.problems, 0) > 10000) fail();
  integer(v['max_new_tokens'], 16, 131072);
  if (v['thinking'] !== undefined) bool(v['thinking']);
  const mode = v['mode'] === undefined ? 'subnet' : choice(v['mode'], ['subnet', 'direct']);
  if (mode === 'subnet' && selected.length !== 1) fail();
  if (v['model_access'] !== undefined && choice(v['model_access'], ['public', 'private']) === 'private' && mode !== 'direct') fail();
  if (v['sampling'] !== undefined) {
    const s = record(v['sampling']);
    if (Object.keys(s).some(k => !['temperature', 'top_p', 'top_k', 'seed'].includes(k))) fail();
    const parsed = sampling({ temperature: 0.6, top_p: 0.95, top_k: 20, seed: 0, ...s });
    if (mode === 'subnet' && parsed.temperature <= 0) fail();
  }
  if (v['harness'] !== undefined) text(v['harness'], 200);
  if (v['harness'] === 'telecom-episode-v1' && v['thinking'] !== true) fail();
  if (v['max_turns'] !== undefined) integer(v['max_turns'], 1, 48);
  if (v['max_episode_tokens'] !== undefined) integer(v['max_episode_tokens'], 1, 65536);
  if (typeof v['max_episode_tokens'] === 'number' && v['max_episode_tokens'] < Number(v['max_new_tokens'])) fail();
  if (v['episode_timeout_seconds'] !== undefined) integer(v['episode_timeout_seconds'], 1, 3600);
  return value as EvaluationQuoteInput;
}
export function parseEvaluationCatalog(value: unknown): EvaluationCatalog {
  const v = record(value);
  const entries = unique(list(v['envs'], 128).map(raw => {
    const e = record(raw);
    return { env: setId(e['env']), sets: unique(list(e['sets'], 256).map(raw => {
      const s = record(raw);
      return { set_id: setId(s['set_id']), name: text(s['name']), description: typeof s['description'] === 'string' && s['description'].length <= 4000 ? s['description'] : fail(), count: integer(s['count'], 1), default_max_new_tokens: integer(s['default_max_new_tokens'], 16, 131072), thinking: bool(s['thinking']), qualified_support: s['qualified_support'] === undefined ? false : bool(s['qualified_support']), protocol: nullable(s['protocol'], protocol), protocol_json: protocolJson(s['protocol_json'], s['protocol']), protocol_sha256: nullable(s['protocol_sha256'], digest) };
    }), s => s.set_id) };
  }), e => e.env);
  return { ordering: choice(v['ordering'], ['pilot', 'disabled']), modes: unique(list(v['modes'], 2).map(x => choice(x, ['subnet', 'direct'])), x => x), default_mode: choice(v['default_mode'], ['subnet', 'direct']), gpu_counts: list(v['gpu_counts'], 4).map(x => integer(x, 1, 8)), max_problems_per_env: integer(v['max_problems_per_env'], 1, 5000), max_problems: integer(v['max_problems'], 1, 10000), envs: entries };
}
export function parseEvaluationQuote(value: unknown): EvaluationQuote {
  const v = record(value);
  return { ...configuration(v), quote_id: id(v['quote_id']), price_usd: number(v['price_usd'], 0.01), est_price_usd: number(v['est_price_usd']), est_tokens: integer(v['est_tokens']), max_tokens: integer(v['max_tokens']), eta_hours: number(v['eta_hours']), max_hours: number(v['max_hours']), expires_at: time(v['expires_at']), gpu_count: integer(v['gpu_count'], 1, 8), weight_bytes: integer(v['weight_bytes'], 1), pricing: record(v['pricing']) };
}
const rates = (value: unknown, report = false): Record<string, number> => Object.fromEntries(Object.entries(record(value)).map(([key, raw]) => {
  if (!/^[1-9][0-9]*$/.test(key)) fail();
  return [key, number(report ? record(raw)['value'] : raw, 0, 1)];
}));
function metrics(value: unknown, report = false): EvaluationMetrics {
  const v = record(value), pass = record(v['pass@1']), ci = list(pass['ci95'], 2).map(x => number(x, 0, 1));
  if (ci.length !== 2 || ci[0]! > ci[1]!) fail();
  const result = { n_problems: integer(v['n_problems']), samples: integer(v['samples'], 1, 64), complete: bool(v['complete']), 'pass@1': { value: number(pass['value'], 0, 1), ci95: ci as [number, number] }, 'pass@k': rates(v['pass@k'], report) } as EvaluationMetrics;
  for (const key of ['n_problems_graded', 'missing_problems', 'expected_rows', 'graded_rows', 'ungraded_rows', 'missing_rows', 'requested_samples', 'attempted_samples', 'completed_samples', 'graded_samples', 'tool_calls_total'] as const) result[key] = nullable(v[key], x => integer(x));
  for (const key of ['mean_score', 'truncation_rate', 'format_failure_rate', 'mean_completion_tokens', 'mean_turns'] as const) result[key] = nullable(v[key], x => number(x, 0, key.endsWith('_rate') ? 1 : Number.MAX_SAFE_INTEGER));
  result.stop_reasons = nullable(v['stop_reasons'], x => Object.fromEntries(Object.entries(record(x)).map(([k, n]) => [text(k, 100), integer(n)])));
  if (result.n_problems_graded !== null && result.n_problems_graded > result.n_problems) fail();
  if (result.expected_rows !== null && result.graded_rows !== null && result.ungraded_rows !== null && result.missing_rows !== null && result.expected_rows !== result.graded_rows + result.ungraded_rows + result.missing_rows) fail();
  return result;
}
function summary(value: unknown, report = false): EvaluationSummary {
  const v = record(value), macro = record(v['macro']);
  return { complete: bool(v['complete']), envs: Object.fromEntries(Object.entries(record(v['envs'])).map(([env, raw]) => [setId(env), metrics(raw, report)])), macro: { 'pass@1': number(macro['pass@1'], 0, 1), 'pass@k': rates(macro['pass@k']) } };
}
export function parseEvaluationOrder(value: unknown): EvaluationOrder {
  const v = record(record(value)['evaluation']), orderId = id(v['id']);
  const order: EvaluationOrder = { ...configuration(v), id: orderId, eval_id: nullable(v['eval_id'], x => text(x, 128)), quote_id: nullable(v['quote_id'], id), client_ref: nullable(v['client_ref'], clientRef), status: choice(v['status'], EVALUATION_STATES), cancel_requested: bool(v['cancel_requested']), gpu_count: integer(v['gpu_count'], 1, 8), price_usd: number(v['price_usd']), status_reason: nullable(v['status_reason'], x => text(x, 200)), needs_attention: bool(v['needs_attention']), complete: nullable(v['complete'], bool), progress: v['progress'] ?? null, created_at: time(v['created_at']), updated_at: time(v['updated_at']), finished_at: nullable(v['finished_at'], time) };
  if (v['refunded_usd'] !== undefined) order.refunded_usd = number(v['refunded_usd']);
  if (v['summary'] !== undefined) order.summary = nullable(v['summary'], x => summary(x));
  if (v['generation'] !== undefined) order.generation = nullable(v['generation'], record);
  if (v['files'] !== undefined) order.files = unique(list(v['files'], 1000).map(raw => {
    const f = record(raw), name = evaluationFileName(f['name']);
    if (f['url'] !== `/api/v1/evaluations/${orderId}/files/${encodeURIComponent(name)}`) fail();
    return { name, size: integer(f['size']), sha256: nullable(f['sha256'], digest), url: f['url'] as string };
  }), f => f.name);
  return order;
}
export function parseEvaluationOrders(value: unknown): { evaluations: EvaluationOrder[] } {
  return { evaluations: unique(list(record(value)['evaluations'], 100).map(evaluation => parseEvaluationOrder({ evaluation })), e => e.id) };
}
export function parseEvaluationReport(value: unknown, order: EvaluationOrder): EvaluationReport {
  const v = record(value), provenance = record(v['provenance']), counts = record(v['counts']);
  if (v['schema'] !== 'reliquary/eval-report/v2' || !order.eval_id || v['eval_id'] !== order.eval_id || provenance['model'] !== order.model.repo || provenance['revision'] !== order.model.revision) fail();
  const pinned = order.protocol !== null || order.protocol_json !== null || order.protocol_sha256 !== null || order.protocol_bindings !== null;
  const sets = list(provenance['sets'], 8).map(record);
  if (sets.length !== order.envs.length || order.envs.some(e => !sets.some(s => s['set_id'] === e.set_id && s['env'] === e.env && s['problems'] === e.problems && s['samples'] === e.samples && (!pinned || s['protocol_sha256'] === order.protocol_bindings?.[e.set_id])))) fail();
  if ((pinned || order.model_access === 'private') && provenance['model_sha'] !== order.model.revision) fail();
  if ((provenance['model_access'] !== undefined && provenance['model_access'] !== order.model_access) || order.model_access === 'private' && provenance['model_access'] !== 'private') fail();
  const parsed = summary(v, true), p = nullable(v['protocol'], protocol), sha = nullable(v['protocol_sha256'], digest), pins = nullable(v['protocol_bindings'], bindings);
  const names = [...new Set(order.envs.map(e => e.env))].sort();
  if (!equalKeys(parsed.envs, names)) fail();
  for (const name of names) {
    const selected = order.envs.filter(e => e.env === name), measured = parsed.envs[name]!;
    if (measured.n_problems !== selected.reduce((n, e) => n + e.problems, 0) || measured.samples !== Math.max(...selected.map(e => e.samples)) || measured.expected_rows !== selected.reduce((n, e) => n + e.problems * e.samples, 0) || measured.graded_rows === null || measured.ungraded_rows === null || measured.missing_rows === null || measured.complete !== (measured.missing_rows === 0 && measured.ungraded_rows === 0)) fail();
  }
  if (parsed.complete !== (Object.values(parsed.envs).every(e => e.complete) && counts['malformed_rows'] === 0)) fail();
  if (pinned && (!order.protocol || !order.protocol_json || !order.protocol_sha256 || !order.protocol_bindings)) fail();
  if (canonicalEvaluationJson(p) !== canonicalEvaluationJson(order.protocol) || sha !== order.protocol_sha256 || canonicalEvaluationJson(pins) !== canonicalEvaluationJson(order.protocol_bindings)) fail();
  const rawProtocol = protocolJson(v['protocol_json'], p);
  if (rawProtocol !== order.protocol_json) fail();
  return { schema: 'reliquary/eval-report/v2', eval_id: text(order.eval_id, 128), created_at: nullable(v['created_at'], x => number(x)), ...parsed, counts: { malformed_rows: integer(counts['malformed_rows']), unexpected_rows: integer(counts['unexpected_rows']) }, provenance, protocol: p, protocol_json: rawProtocol, protocol_sha256: sha, protocol_bindings: pins };
}
const equalKeys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).sort().join('\0') === names.join('\0');
export function assertEvaluationQuoteMatches(quote: EvaluationQuote, input: EvaluationQuoteInput): void {
  if (quote.model.repo !== input.model || quote.model.revision !== input.revision || quote.mode !== (input.mode ?? 'subnet') || quote.model_access !== (input.model_access ?? 'public') || canonicalEvaluationJson(quote.envs) !== canonicalEvaluationJson(input.envs) || quote.max_new_tokens !== input.max_new_tokens || quote.thinking !== (input.thinking ?? false) || canonicalEvaluationJson(quote.sampling) !== canonicalEvaluationJson({ temperature: 0.6, top_p: 0.95, top_k: 20, seed: 0, ...input.sampling }) || (['harness', 'max_turns', 'max_episode_tokens', 'episode_timeout_seconds'] as const).some(k => input[k] !== undefined && quote[k] !== input[k])) throw new Error('The evaluation quote does not match the reviewed request.');
}
export function evaluationFileName(value: unknown): string {
  const name = text(value, 200);
  return /^[\w.()-]{1,200}$/.test(name) && name !== '.' && name !== '..' ? name : fail();
}
export function evaluationRequests() {
  const root = '/api/v1/evaluations', path = (value: string) => `${root}/${id(value)}`;
  return {
    catalog: (): GenerationRequest => ({ path: `${root}/catalog` }),
    quote: (input: EvaluationQuoteInput): GenerationRequest => ({ path: `${root}/quotes`, method: 'POST', json: parseEvaluationQuoteInput(input) }),
    create: (quoteId: string, requestKey: string, client_ref?: string): GenerationRequest => {
      if (!/^[\w-]{16,80}$/.test(requestKey)) fail();
      return { path: root, method: 'POST', headers: { 'Idempotency-Key': requestKey }, json: { quote_id: id(quoteId), ...(client_ref === undefined ? {} : { client_ref: clientRef(client_ref) }) } };
    },
    orders: (filters: { quote_id?: string; client_ref?: string } = {}): GenerationRequest => {
      const query = new URLSearchParams();
      if (filters.quote_id !== undefined) query.set('quote_id', id(filters.quote_id));
      if (filters.client_ref !== undefined) query.set('client_ref', clientRef(filters.client_ref));
      return { path: root + (query.size ? `?${query}` : '') };
    },
    detail: (value: string): GenerationRequest => ({ path: path(value) }),
    cancel: (value: string): GenerationRequest => ({ path: `${path(value)}/cancel`, method: 'POST', json: {} }),
    download: (value: string, name: string, range?: FileRange): GenerationRequest => {
      if (range && (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.maxBytes) || range.maxBytes < 1 || range.maxBytes > MAX_FILE_CHUNK_BYTES || !Number.isSafeInteger(range.offset + range.maxBytes))) fail();
      return { path: `${path(value)}/files/${encodeURIComponent(evaluationFileName(name))}`, download: true, ...(range ? { headers: { Range: `bytes=${range.offset}-${range.offset + range.maxBytes - 1}` } } : {}) };
    },
  };
}
export function createEvaluationClient(request: GenerationJsonTransport) {
  const requests = evaluationRequests();
  const call = async (r: GenerationRequest, signal?: AbortSignal): Promise<unknown> => {
    try { return await request(r.path, { ...(r.method ? { method: r.method } : {}), ...(r.headers ? { headers: r.headers } : {}), ...(r.json === undefined ? {} : { body: JSON.stringify(r.json) }), ...(signal ? { signal } : {}) }); }
    catch (error) {
      if (r.method !== 'POST') throw error;
      if (error instanceof GenerationApiError && ['outcome_unknown', 'credential_required', 'invalid_origin', 'invalid_route', 'invalid_credential', 'invalid_timeout', 'request_too_large', 'writes_disabled'].includes(error.code)) throw error;
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) throw error;
      throw new GenerationApiError('outcome_unknown', typeof status === 'number' ? status : undefined, r.headers?.['Idempotency-Key'], undefined, error instanceof GenerationApiError ? error.requestId : undefined, error instanceof GenerationApiError ? error.retryAfterSeconds : undefined);
    }
  };
  return {
    catalog: async (signal?: AbortSignal) => { const catalog = parseEvaluationCatalog(await call(requests.catalog(), signal)); for (const env of catalog.envs) for (const set of env.sets) await verifyEvaluationProtocol(set); return catalog; },
    quote: async (input: EvaluationQuoteInput, signal?: AbortSignal) => { const quote = parseEvaluationQuote(await call(requests.quote(input), signal)); await verifyEvaluationProtocol(quote); assertEvaluationQuoteMatches(quote, input); return quote; },
    create: async (quoteId: string, key: string, client_ref?: string) => {
      const value = await call(requests.create(quoteId, key, client_ref));
      try { const order = parseEvaluationOrder(value); await verifyEvaluationProtocol(order); if (order.quote_id !== quoteId || order.client_ref !== (client_ref ?? null)) fail(); return order; }
      catch { throw new GenerationApiError('outcome_unknown', undefined, key); }
    },
    orders: async (filters: { quote_id?: string; client_ref?: string } = {}, signal?: AbortSignal) => {
      const result = parseEvaluationOrders(await call(requests.orders(filters), signal));
      for (const order of result.evaluations) await verifyEvaluationProtocol(order);
      if (result.evaluations.some(e => (filters.quote_id !== undefined && e.quote_id !== filters.quote_id) || (filters.client_ref !== undefined && e.client_ref !== filters.client_ref))) fail();
      return result;
    },
    detail: async (value: string, signal?: AbortSignal) => { const order = parseEvaluationOrder(await call(requests.detail(value), signal)); await verifyEvaluationProtocol(order); if (order.id !== value) fail(); return order; },
    cancel: async (value: string) => {
      const raw = await call(requests.cancel(value));
      try { const order = parseEvaluationOrder(raw); await verifyEvaluationProtocol(order); if (order.id !== value) fail(); return order; }
      catch { throw new GenerationApiError('outcome_unknown'); }
    },
    downloadPath: (value: string, name: string) => requests.download(value, name).path,
  };
}
