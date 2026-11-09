import { parseEvaluationSummary, type EvaluationSummary } from './evaluation-summary.js';

export type BatchSampling = { temperature: number; top_p: number; top_k: number };
type BatchConfiguration = {
  model: string;
  prompt_count: number;
  samples_per_prompt: number;
  max_new_tokens: number;
  thinking: boolean;
};
export type BatchQuoteInput =
  | (BatchConfiguration & ({ source: string } | { revision: string; env: string; sampling?: Partial<BatchSampling> }))
  | FileQuoteInput;
export const BATCH_OUTPUT_FORMATS = ['parquet', 'openai_jsonl'] as const;
export type BatchOutputFormat = (typeof BATCH_OUTPUT_FORMATS)[number];
/** Reference graders of an evaluation on a customer's file: each line then carries a `reference`. */
export const FILE_GRADERS = ['boxed_math_v1', 'exact_match_v1'] as const;
export type FileGrader = (typeof FILE_GRADERS)[number];
/** A quote on an uploaded batch file: its lines carry their own messages and sampling. */
export type FileQuoteInput = {
  model: string;
  revision: string;
  input_file_id: string;
  max_new_tokens?: number;
  output_format?: BatchOutputFormat;
  /** Grade every completion against its line's `reference`: the order becomes an evaluation. */
  grader?: FileGrader;
};
/** The one sampling a file's lines asked for (OpenAI body fields, normalised by the platform). */
export type FileSampling = {
  temperature: number;
  top_p: number;
  top_k: number;
  min_p?: number;
  max_tokens?: number | null;
  seed?: number | null;
  n?: number;
};
export type FilePreviewLine = { custom_id: string; prompt_tokens: number; text: string };
/** Server pricing terms; an evaluation quote adds the grading fee before the margin. */
export type FilePricing = Record<string, unknown> & { grading_fee_usd?: number };
/** How the samples are checked: `draw` is the public seeded (forced) draw that every file order uses. */
export type BatchVerification = 'qualified' | 'draw';
export type FileBatchQuote = {
  quote_id: string;
  price_usd: number;
  est_price_usd: number;
  est_tokens: number;
  max_tokens: number;
  eta_hours: number;
  max_hours: number;
  expires_at: string;
  model: string;
  revision: string;
  input_file_id: string;
  prompt_count: number;
  samples_per_prompt: number;
  max_new_tokens: number;
  sampling: FileSampling;
  line_errors: number;
  preview: FilePreviewLine[];
  pricing: FilePricing;
  output_format?: BatchOutputFormat;
  /** The model's config.json architectures[0], one the subnet serves. */
  architecture?: string;
  /** GPUs of one verification node the model needs. */
  gpu_count?: number;
  thinking?: boolean;
  verification?: BatchVerification;
  /** The draw seed the file's lines asked for. */
  seed?: number;
  /** Present on evaluations only, with their grader. */
  purpose?: 'eval';
  grader?: FileGrader;
};
type FileIdentity = {
  revision: string;
  input_file_id: string;
  sampling: FileSampling;
  output_format?: BatchOutputFormat;
  gpu_count?: number;
  verification?: BatchVerification;
  seed?: number;
  purpose?: 'eval';
  evaluation?: FileEvaluation;
};
/** An evaluation on a file: `pending` until the order ends, then `graded` with its summary or `ungraded`. */
export type FileEvaluation = {
  grader: FileGrader;
  status: 'pending' | 'graded' | 'ungraded';
  /** null until graded; false when samples are missing from the report. */
  complete: boolean | null;
  /** envs holds one entry named after the grader; null unless graded. */
  summary: EvaluationSummary | null;
};
type CatalogIdentity = { source: string };
type PinnedIdentity = {
  revision: string;
  env: string;
  gpu_count: number;
  sampling: BatchSampling;
};
export type BatchQuote = FileBatchQuote | (BatchConfiguration & {
  quote_id: string;
  price_usd: number;
  est_tokens: number;
  eta_hours: number;
  expires_at: string;
} & (
    | CatalogIdentity
    | (PinnedIdentity & {
        architecture: string;
        est_price_usd: number;
        max_tokens: number;
        max_hours: number;
        pricing: Record<string, unknown>;
      })
  ));
export const BATCH_ORDER_STATUSES = [
  'reserved',
  'provisioning',
  'qualifying',
  'queued',
  'running',
  'draining',
  'exporting',
  'delivered',
  'cancelled',
  'failed',
] as const;
export type BatchOrderStatus = (typeof BATCH_ORDER_STATUSES)[number];
export type BatchBilling = {
  status: 'held' | 'settled';
  reserved_micro_usd: number;
  held_micro_usd: number;
  charged_micro_usd: number | null;
  released_micro_usd: number;
};
export type BatchOrderProgress = {
  state: 'open' | 'full' | 'retired' | 'drained';
  prompts_total: number;
  prompts_full: number;
  submissions_accepted: number;
  audited: number;
  passed: number;
  verified_tokens: number;
  settled: number;
  accepted_last_hour: number;
  counts_complete: boolean;
  observed_at: string;
};
type FileConfiguration = Omit<BatchConfiguration, 'thinking'> & { thinking?: boolean };
type OrderFields = {
  id: string;
  status: BatchOrderStatus;
  price_usd: number;
  cancel_requested: boolean;
  status_reason: string | null;
  needs_attention: boolean;
  progress: BatchOrderProgress | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  billing: BatchBilling;
};
export type BatchOrder = OrderFields &
  ((BatchConfiguration & (CatalogIdentity | PinnedIdentity)) | (FileConfiguration & FileIdentity));
export type BatchDeliveryFile = { name: string; size: number; sha256: string | null; url: string };
export type BatchOrderDetail = BatchOrder & {
  refunded_usd: number;
  deliveries: { delivery_id: string; files: BatchDeliveryFile[] }[];
};
export type BatchOrdersResponse = { orders: BatchOrder[] };
type WithoutBilling<T> = T extends unknown ? Omit<T, 'billing'> : never;
export type GenerationOrder = WithoutBilling<BatchOrder>;
export type GenerationOrderDetail = WithoutBilling<BatchOrderDetail>;
export type GenerationOrdersResponse = { orders: GenerationOrder[] };

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 512): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const id = (v: unknown): v is string => text(v, 80) && /^[\w-]+$/.test(v);
const number = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  number(v, min, max) && Number.isSafeInteger(v);
const micro = (v: unknown): v is number => integer(v, 0, 1_000_000_000_000);
const money = (v: unknown): v is number =>
  number(v, 0, 1_000_000) && v === Math.round(v * 1_000_000) / 1_000_000;
const time = (v: unknown): v is string => text(v, 40) && Number.isFinite(Date.parse(v));
const nullableTime = (v: unknown) => v === null || time(v);
function fail(): never {
  throw new Error('Training Data returned an unexpected response. Please try again.');
}

function configuration(v: Record<string, unknown>): BatchConfiguration {
  if (
    !text(v['model'], 200) ||
    !integer(v['prompt_count'], 1, 1_000_000) ||
    !integer(v['samples_per_prompt'], 1, 64) ||
    !integer(v['max_new_tokens'], 16, 131_072) ||
    typeof v['thinking'] !== 'boolean'
  )
    fail();
  return {
    model: v['model'] as string,
    prompt_count: v['prompt_count'] as number,
    samples_per_prompt: v['samples_per_prompt'] as number,
    max_new_tokens: v['max_new_tokens'] as number,
    thinking: v['thinking'] as boolean,
  };
}
const FILE_ID = /^file-[\w-]{1,80}$/;
const MODEL_REPO = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const nullableInteger = (v: unknown, min: number, max: number) => v === null || integer(v, min, max);
export function parseFileSampling(value: unknown): FileSampling {
  const keys = ['temperature', 'top_p', 'top_k', 'min_p', 'max_tokens', 'seed', 'n'];
  if (
    !record(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    !number(value['temperature'], Number.MIN_VALUE, 4) ||
    !number(value['top_p'], Number.MIN_VALUE, 1) ||
    !(value['top_k'] === -1 || integer(value['top_k'], 0, 1_000_000)) ||
    (value['min_p'] !== undefined && !(number(value['min_p'], 0, 1) && (value['min_p'] as number) < 1)) ||
    (value['max_tokens'] !== undefined && !nullableInteger(value['max_tokens'], 1, 131_072)) ||
    (value['seed'] !== undefined && !nullableInteger(value['seed'], 0, Number.MAX_SAFE_INTEGER)) ||
    (value['n'] !== undefined && !integer(value['n'], 1, 64))
  )
    fail();
  const sampling: FileSampling = {
    temperature: value['temperature'] as number,
    top_p: value['top_p'] as number,
    top_k: value['top_k'] as number,
  };
  for (const key of ['min_p', 'max_tokens', 'seed', 'n'] as const)
    if (value[key] !== undefined) (sampling as Record<string, unknown>)[key] = value[key];
  return sampling;
}
const outputFormat = (v: unknown): BatchOutputFormat | undefined => {
  if (v === undefined) return undefined;
  if (!BATCH_OUTPUT_FORMATS.includes(v as BatchOutputFormat)) fail();
  return v as BatchOutputFormat;
};
function fileIdentity(v: Record<string, unknown>): FileConfiguration & FileIdentity {
  if (
    !text(v['model'], 194) ||
    !MODEL_REPO.test(v['model']) ||
    v['model'].includes('..') ||
    typeof v['revision'] !== 'string' ||
    !/^[0-9a-f]{40}$/.test(v['revision']) ||
    typeof v['input_file_id'] !== 'string' ||
    !FILE_ID.test(v['input_file_id']) ||
    Object.hasOwn(v, 'source') ||
    Object.hasOwn(v, 'env') ||
    !integer(v['prompt_count'], 1, 1_000_000) ||
    !integer(v['samples_per_prompt'], 1, 64) ||
    !integer(v['max_new_tokens'], 1, 131_072) ||
    (v['thinking'] !== undefined && typeof v['thinking'] !== 'boolean')
  )
    fail();
  const format = outputFormat(v['output_format']);
  if (
    (v['gpu_count'] !== undefined && !integer(v['gpu_count'], 1, 8)) ||
    (v['verification'] !== undefined && !['qualified', 'draw'].includes(v['verification'] as string)) ||
    (v['seed'] !== undefined && !integer(v['seed'])) ||
    (v['purpose'] !== undefined && v['purpose'] !== 'eval' && v['purpose'] !== 'batch')
  )
    fail();
  return {
    model: v['model'] as string,
    prompt_count: v['prompt_count'] as number,
    samples_per_prompt: v['samples_per_prompt'] as number,
    max_new_tokens: v['max_new_tokens'] as number,
    ...(v['thinking'] !== undefined ? { thinking: v['thinking'] as boolean } : {}),
    revision: v['revision'] as string,
    input_file_id: v['input_file_id'] as string,
    sampling: parseFileSampling(v['sampling']),
    ...(format ? { output_format: format } : {}),
    ...(v['gpu_count'] !== undefined ? { gpu_count: v['gpu_count'] as number } : {}),
    ...(v['verification'] !== undefined ? { verification: v['verification'] as BatchVerification } : {}),
    ...(v['seed'] !== undefined ? { seed: v['seed'] as number } : {}),
  };
}
const grader = (v: unknown): FileGrader => {
  if (!FILE_GRADERS.includes(v as FileGrader)) fail();
  return v as FileGrader;
};
/** order.evaluation of an evaluation on a file. */
export function parseFileEvaluation(value: unknown): FileEvaluation {
  if (
    !record(value) ||
    !['pending', 'graded', 'ungraded'].includes(value['status'] as string) ||
    !(value['complete'] === null || typeof value['complete'] === 'boolean') ||
    (value['status'] === 'graded') !== (value['summary'] !== null && value['summary'] !== undefined)
  )
    fail();
  let summary: EvaluationSummary | null = null;
  if (value['summary'] != null) {
    try {
      summary = parseEvaluationSummary(value['summary']);
    } catch {
      fail();
    }
  }
  return {
    grader: grader(value['grader']),
    status: value['status'] as FileEvaluation['status'],
    complete: value['complete'] as boolean | null,
    summary,
  };
}
// purpose "eval" names its grader on a quote and its evaluation on an order; "batch" is never sent.
function fileQuoteEvaluation(v: Record<string, unknown>): Pick<FileBatchQuote, 'purpose' | 'grader'> {
  if (v['purpose'] === undefined || v['purpose'] === 'batch') {
    if (v['grader'] !== undefined && v['grader'] !== null) fail();
    return {};
  }
  if (v['purpose'] !== 'eval') fail();
  return { purpose: 'eval', grader: grader(v['grader']) };
}
function fileOrderEvaluation(v: Record<string, unknown>): Pick<FileIdentity, 'purpose' | 'evaluation'> {
  if (v['purpose'] === undefined || v['purpose'] === 'batch') {
    if (v['evaluation'] !== undefined && v['evaluation'] !== null) fail();
    return {};
  }
  return { purpose: 'eval', evaluation: parseFileEvaluation(v['evaluation']) };
}
function preview(value: unknown): FilePreviewLine[] {
  if (!Array.isArray(value) || value.length > 10) fail();
  return value.map((line: unknown) => {
    if (
      !record(line) ||
      !text(line['custom_id'], 64) ||
      !integer(line['prompt_tokens'], 0, 1_000_000) ||
      typeof line['text'] !== 'string' ||
      line['text'].length > 65_536
    )
      fail();
    return {
      custom_id: line['custom_id'] as string,
      prompt_tokens: line['prompt_tokens'] as number,
      text: line['text'] as string,
    };
  });
}
function parseFileQuote(value: Record<string, unknown>): FileBatchQuote {
  if (
    !id(value['quote_id']) ||
    !money(value['price_usd']) ||
    value['price_usd'] < 0.01 ||
    !money(value['est_price_usd']) ||
    !integer(value['est_tokens']) ||
    !integer(value['max_tokens'], value['est_tokens'] as number) ||
    !number(value['eta_hours']) ||
    !number(value['max_hours']) ||
    !time(value['expires_at']) ||
    !integer(value['line_errors']) ||
    !record(value['pricing']) ||
    (value['pricing']['grading_fee_usd'] !== undefined && !number(value['pricing']['grading_fee_usd'])) ||
    (value['architecture'] !== undefined && !text(value['architecture'], 200)) ||
    Object.hasOwn(value, 'evaluation')
  )
    fail();
  const identity = fileIdentity(value);
  const { thinking, ...fields } = identity;
  const evaluation = fileQuoteEvaluation(value);
  if (evaluation.purpose === 'eval' && value['pricing']['grading_fee_usd'] === undefined) fail();
  return {
    ...fields,
    ...(value['architecture'] !== undefined ? { architecture: value['architecture'] as string } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...evaluation,
    quote_id: value['quote_id'] as string,
    price_usd: value['price_usd'] as number,
    est_price_usd: value['est_price_usd'] as number,
    est_tokens: value['est_tokens'] as number,
    max_tokens: value['max_tokens'] as number,
    eta_hours: value['eta_hours'] as number,
    max_hours: value['max_hours'] as number,
    expires_at: value['expires_at'] as string,
    line_errors: value['line_errors'] as number,
    preview: preview(value['preview']),
    pricing: value['pricing'] as FilePricing,
  };
}
export const isFileQuote = (quote: BatchQuote): quote is FileBatchQuote => 'input_file_id' in quote;
function identity(v: Record<string, unknown>): CatalogIdentity | PinnedIdentity {
  if (Object.hasOwn(v, 'source')) {
    if (
      !text(v['source'], 200) ||
      Object.hasOwn(v, 'revision') ||
      Object.hasOwn(v, 'env') ||
      Number(v['max_new_tokens']) > 32768
    )
      fail();
    return { source: v['source'] as string };
  }
  const sampling = v['sampling'];
  if (
    !text(v['model'], 194) ||
    !/^[\w.-]+\/[\w.-]+$/.test(v['model']) ||
    v['model'].includes('..') ||
    typeof v['revision'] !== 'string' ||
    !/^[0-9a-f]{40}$/.test(v['revision']) ||
    !text(v['env'], 64) ||
    !/^[\w.-]+$/.test(v['env']) ||
    !integer(v['gpu_count'], 1, 8) ||
    !record(sampling) ||
    Object.keys(sampling).length !== 3 ||
    !number(sampling['temperature'], Number.MIN_VALUE, 2) ||
    !number(sampling['top_p'], 0.01, 1) ||
    !(sampling['top_k'] === -1 || integer(sampling['top_k'], 1, 1000))
  )
    fail();
  return {
    revision: v['revision'] as string,
    env: v['env'] as string,
    gpu_count: v['gpu_count'] as number,
    sampling: {
      temperature: sampling['temperature'] as number,
      top_p: sampling['top_p'] as number,
      top_k: sampling['top_k'] as number,
    },
  };
}
export function parseBatchQuote(value: unknown): BatchQuote {
  if (record(value) && Object.hasOwn(value, 'input_file_id')) return parseFileQuote(value);
  if (
    !record(value) ||
    !id(value['quote_id']) ||
    !money(value['price_usd']) ||
    value['price_usd'] < 0.01 ||
    !integer(value['est_tokens']) ||
    !number(value['eta_hours']) ||
    !time(value['expires_at'])
  )
    fail();
  const common = {
    ...configuration(value),
    ...identity(value),
    quote_id: value['quote_id'] as string,
    price_usd: value['price_usd'] as number,
    est_tokens: value['est_tokens'] as number,
    eta_hours: value['eta_hours'] as number,
    expires_at: value['expires_at'] as string,
  };
  if ('source' in common) return common;
  if (
    !text(value['architecture'], 200) ||
    !money(value['est_price_usd']) ||
    !integer(value['max_tokens'], common.est_tokens) ||
    !number(value['max_hours']) ||
    !record(value['pricing'])
  )
    fail();
  return {
    ...common,
    architecture: value['architecture'] as string,
    est_price_usd: value['est_price_usd'] as number,
    max_tokens: value['max_tokens'] as number,
    max_hours: value['max_hours'] as number,
    pricing: value['pricing'] as Record<string, unknown>,
  };
}
function billing(value: unknown): BatchBilling {
  if (
    !record(value) ||
    !['held', 'settled'].includes(String(value['status'])) ||
    !micro(value['reserved_micro_usd']) ||
    !micro(value['held_micro_usd']) ||
    !micro(value['released_micro_usd']) ||
    !(value['charged_micro_usd'] === null || micro(value['charged_micro_usd']))
  )
    fail();
  const reserved = value['reserved_micro_usd'] as number,
    held = value['held_micro_usd'] as number,
    released = value['released_micro_usd'] as number,
    charged = value['charged_micro_usd'] as number | null;
  if (
    value['status'] === 'held'
      ? charged !== null || held + released !== reserved
      : charged === null || held !== 0 || charged + released !== reserved
  )
    fail();
  return {
    status: value['status'] as BatchBilling['status'],
    reserved_micro_usd: reserved,
    held_micro_usd: held,
    charged_micro_usd: charged,
    released_micro_usd: released,
  };
}
export function parseGenerationOrder(value: unknown): GenerationOrder {
  if (
    !record(value) ||
    !id(value['id']) ||
    !BATCH_ORDER_STATUSES.includes(value['status'] as BatchOrderStatus) ||
    !money(value['price_usd']) ||
    typeof value['cancel_requested'] !== 'boolean' ||
    !(value['status_reason'] === null || text(value['status_reason'], 1000)) ||
    typeof value['needs_attention'] !== 'boolean' ||
    !(value['progress'] === null || record(value['progress'])) ||
    !time(value['created_at']) ||
    !time(value['updated_at']) ||
    !nullableTime(value['finished_at'])
  )
    fail();
  return {
    ...(Object.hasOwn(value, 'input_file_id')
      ? { ...fileIdentity(value), ...fileOrderEvaluation(value) }
      : { ...configuration(value), ...identity(value) }),
    id: value['id'] as string,
    status: value['status'] as BatchOrderStatus,
    price_usd: value['price_usd'] as number,
    cancel_requested: value['cancel_requested'] as boolean,
    status_reason: value['status_reason'] as string | null,
    needs_attention: value['needs_attention'] as boolean,
    progress: progress(value['progress']),
    created_at: value['created_at'] as string,
    updated_at: value['updated_at'] as string,
    finished_at: value['finished_at'] as string | null,
  };
}
export function parseBatchOrder(value: unknown): BatchOrder {
  const order = parseGenerationOrder(value);
  if (order.price_usd < 0.01) fail();
  if (!record(value)) fail();
  const receipt = billing(value['billing']);
  if (receipt.reserved_micro_usd !== Math.round(order.price_usd * 1_000_000)) fail();
  return { ...order, billing: receipt };
}
function progress(value: unknown): BatchOrderProgress | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !['open', 'full', 'retired', 'drained'].includes(String(value['state'])) ||
    ![
      'prompts_total',
      'prompts_full',
      'submissions_accepted',
      'audited',
      'passed',
      'verified_tokens',
      'settled',
      'accepted_last_hour',
    ].every((key) => integer(value[key])) ||
    typeof value['counts_complete'] !== 'boolean' ||
    !time(value['observed_at'])
  )
    fail();
  return {
    state: value['state'] as BatchOrderProgress['state'],
    prompts_total: value['prompts_total'] as number,
    prompts_full: value['prompts_full'] as number,
    submissions_accepted: value['submissions_accepted'] as number,
    audited: value['audited'] as number,
    passed: value['passed'] as number,
    verified_tokens: value['verified_tokens'] as number,
    settled: value['settled'] as number,
    accepted_last_hour: value['accepted_last_hour'] as number,
    counts_complete: value['counts_complete'] as boolean,
    observed_at: value['observed_at'] as string,
  };
}
function orderDetail(value: unknown, audience: 'browser'): BatchOrderDetail;
function orderDetail(value: unknown, audience: 'key'): GenerationOrderDetail;
function orderDetail(value: unknown, audience: 'browser' | 'key'): BatchOrderDetail | GenerationOrderDetail {
  const order = audience === 'browser' ? parseBatchOrder(value) : parseGenerationOrder(value);
  if (
    !record(value) ||
    !money(value['refunded_usd']) ||
    !Array.isArray(value['deliveries']) ||
    value['deliveries'].length > 100
  )
    fail();
  const deliveryIds = new Set<string>();
  const deliveries = value['deliveries'].map((delivery: unknown) => {
    if (
      !record(delivery) ||
      !id(delivery['delivery_id']) ||
      deliveryIds.has(delivery['delivery_id']) ||
      !Array.isArray(delivery['files']) ||
      delivery['files'].length > 1000
    )
      fail();
    deliveryIds.add(delivery['delivery_id'] as string);
    const names = new Set<string>();
    const files = delivery['files'].map((file: unknown) => {
      if (
        !record(file) ||
        !text(file['name'], 200) ||
        names.has(file['name']) ||
        !integer(file['size']) ||
        !(
          file['sha256'] === null ||
          (typeof file['sha256'] === 'string' && /^[0-9a-f]{64}$/.test(file['sha256']))
        ) ||
        file['url'] !==
          (audience === 'browser' ? '/api/batch/orders/' : '/api/v1/dataset-orders/') +
            order.id +
            '/deliveries/' +
            delivery['delivery_id'] +
            '/files/' +
            encodeURIComponent(file['name'] as string)
      )
        fail();
      names.add(file['name'] as string);
      return {
        name: file['name'] as string,
        size: file['size'] as number,
        sha256: file['sha256'] as string | null,
        url: file['url'] as string,
      };
    });
    return { delivery_id: delivery['delivery_id'] as string, files };
  });
  return { ...order, refunded_usd: value['refunded_usd'] as number, deliveries };
}
export function parseBatchOrders(value: unknown): BatchOrdersResponse {
  if (!record(value) || !Array.isArray(value['orders']) || value['orders'].length > 100) fail();
  const orders = value['orders'].map(parseBatchOrder);
  if (new Set(orders.map((order) => order.id)).size !== orders.length) fail();
  return { orders };
}
export function parseBatchOrderResponse(value: unknown): BatchOrderDetail {
  if (!record(value)) fail();
  return parseBatchOrderDetail(value['order']);
}

export function parseBatchOrderDetail(value: unknown): BatchOrderDetail {
  return orderDetail(value, 'browser');
}
export function parseGenerationOrderDetail(value: unknown): GenerationOrderDetail {
  return orderDetail(value, 'key');
}
export function parseGenerationOrders(value: unknown): GenerationOrdersResponse {
  if (!record(value) || !Array.isArray(value['orders']) || value['orders'].length > 100) fail();
  const orders = value['orders'].map(parseGenerationOrder);
  if (new Set(orders.map(order => order.id)).size !== orders.length) fail();
  return { orders };
}
export function parseGenerationOrderResponse(value: unknown): GenerationOrderDetail {
  if (!record(value)) fail();
  return parseGenerationOrderDetail(value['order']);
}
