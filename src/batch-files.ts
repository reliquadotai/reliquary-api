/**
 * Batch input files: a customer's OpenAI Batch JSONL, uploaded in parts and then quoted as a dataset order
 * (`input_file_id`). Browser-safe: no filesystem access here (see `./node` for path uploads and downloads).
 */
import { GenerationApiError } from './generation.js';

export const BATCH_FILE_PURPOSES = ['batch'] as const;
export type BatchFilePurpose = (typeof BATCH_FILE_PURPOSES)[number];
/** The largest batch file the native upload accepts. */
export const MAX_BATCH_FILE_BYTES = 200 * 1024 * 1024;
/** The largest part the platform may ask for. */
export const MAX_BATCH_PART_BYTES = 64 * 1024 * 1024;
export const BATCH_FILE_STATUSES = ['uploading', 'processed'] as const;
export type BatchFileStatus = (typeof BATCH_FILE_STATUSES)[number];
export type BatchFileUpload = { part_size: number; parts: number };
export type BatchFile = {
  id: string;
  object: 'file';
  bytes: number;
  filename: string;
  purpose: BatchFilePurpose;
  status: BatchFileStatus;
  created_at: string;
  upload?: BatchFileUpload;
  /** SHA-256 of the whole file once processed; null until the platform has read a file uploaded in parts. */
  sha256?: string | null;
};
export type BatchFileList = { object: 'list'; data: BatchFile[] };
export type BatchFilePart = { part: number; etag: string };
export type BatchFileInput = { filename: string; bytes: number; purpose: BatchFilePurpose };

const FILE_ID = /^file-[\w-]{1,80}$/;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const filename = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(v) && v !== '.' && v !== '..';
function fail(): never {
  throw new Error('Batch files returned an unexpected response. Please try again.');
}

export function parseBatchFile(value: unknown): BatchFile {
  if (
    !record(value) ||
    typeof value['id'] !== 'string' || !FILE_ID.test(value['id']) ||
    value['object'] !== 'file' ||
    !integer(value['bytes'], 0, MAX_BATCH_FILE_BYTES) ||
    !filename(value['filename']) ||
    !BATCH_FILE_PURPOSES.includes(value['purpose'] as BatchFilePurpose) ||
    !BATCH_FILE_STATUSES.includes(value['status'] as BatchFileStatus) ||
    typeof value['created_at'] !== 'string' || !Number.isFinite(Date.parse(value['created_at']))
  )
    fail();
  const file: BatchFile = {
    id: value['id'] as string,
    object: 'file',
    bytes: value['bytes'] as number,
    filename: value['filename'] as string,
    purpose: value['purpose'] as BatchFilePurpose,
    status: value['status'] as BatchFileStatus,
    created_at: value['created_at'] as string,
  };
  const upload = value['upload'];
  if (upload !== undefined) {
    if (!record(upload) || !integer(upload['part_size'], 1, MAX_BATCH_PART_BYTES) || !integer(upload['parts'], 1, 10_000) ||
        upload['parts'] !== Math.max(1, Math.ceil(file.bytes / (upload['part_size'] as number))))
      fail();
    file.upload = { part_size: upload['part_size'] as number, parts: upload['parts'] as number };
  }
  const sha256 = value['sha256'];
  if (sha256 !== undefined) {
    if (!(sha256 === null || (typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256))) ||
        (file.status === 'uploading' && sha256 !== null))
      fail();
    file.sha256 = sha256;
  }
  return file;
}

export function parseBatchFileList(value: unknown): BatchFileList {
  if (!record(value) || (value['object'] !== undefined && value['object'] !== 'list') ||
      !Array.isArray(value['data']) || value['data'].length > 100) fail();
  const data = value['data'].map(parseBatchFile);
  if (new Set(data.map(file => file.id)).size !== data.length) fail();
  return { object: 'list', data };
}

export function parseBatchFilePart(value: unknown, part: number): BatchFilePart {
  if (!record(value) || value['part'] !== part || typeof value['etag'] !== 'string' || !value['etag'] || value['etag'].length > 256)
    fail();
  return { part, etag: value['etag'] as string };
}

const fileId = (id: string) => {
  if (!FILE_ID.test(id)) throw new Error('This file id is invalid.');
  return encodeURIComponent(id);
};

export function parseBatchFileInput(value: unknown): BatchFileInput {
  if (!record(value) || Object.keys(value).some(k => !['filename', 'bytes', 'purpose'].includes(k)) ||
      !filename(value['filename']) || !integer(value['bytes'], 1, MAX_BATCH_FILE_BYTES) ||
      !BATCH_FILE_PURPOSES.includes(value['purpose'] as BatchFilePurpose))
    throw new Error('Invalid batch file request.');
  return value as BatchFileInput;
}

export type BatchFileRequest = { path: string; method?: 'GET' | 'POST' | 'PUT'; json?: unknown; download?: boolean };
/** The native file routes, for a scoped workspace key. */
export function batchFileRequests() {
  const root = '/api/v1/files';
  return {
    create: (input: BatchFileInput): BatchFileRequest => ({ path: root, method: 'POST', json: parseBatchFileInput(input) }),
    part: (id: string, part: number): BatchFileRequest => {
      if (!integer(part, 1, 10_000)) throw new Error('Invalid part number.');
      return { path: `${root}/${fileId(id)}/parts/${part}`, method: 'PUT' };
    },
    complete: (id: string): BatchFileRequest => ({ path: `${root}/${fileId(id)}/complete`, method: 'POST', json: {} }),
    get: (id: string): BatchFileRequest => ({ path: `${root}/${fileId(id)}` }),
    list: (purpose: BatchFilePurpose = 'batch'): BatchFileRequest => {
      if (!BATCH_FILE_PURPOSES.includes(purpose)) throw new Error('Invalid purpose.');
      return { path: `${root}?purpose=${purpose}` };
    },
    content: (id: string): BatchFileRequest => ({ path: `${root}/${fileId(id)}/content`, download: true }),
  };
}

/** What the file client needs of a transport: JSON calls and raw part uploads. */
export type BatchFileTransport = {
  request(path: string, init?: RequestInit): Promise<unknown>;
  putPart(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<unknown>;
};

export function createBatchFileClient(transport: BatchFileTransport) {
  const requests = batchFileRequests();
  const json = (r: BatchFileRequest, signal?: AbortSignal) => transport.request(r.path, {
    ...(r.method ? { method: r.method } : {}), ...(r.json !== undefined ? { body: JSON.stringify(r.json) } : {}), ...(signal ? { signal } : {}),
  });
  const owned = (value: unknown, id: string) => {
    const file = parseBatchFile(value);
    if (file.id !== id) throw new GenerationApiError('invalid_response', undefined, undefined, 'The file response did not match this request.');
    return file;
  };
  return {
    create: async (input: BatchFileInput, signal?: AbortSignal) => {
      const file = parseBatchFile(await json(requests.create(input), signal));
      if (file.status !== 'uploading' || !file.upload || file.bytes !== input.bytes || file.filename !== input.filename)
        throw new GenerationApiError('invalid_response', undefined, undefined, 'The new file does not match the declared upload.');
      return file;
    },
    putPart: async (id: string, part: number, bytes: Uint8Array, signal?: AbortSignal) =>
      parseBatchFilePart(await transport.putPart(requests.part(id, part).path, bytes, signal), part),
    complete: async (id: string, signal?: AbortSignal) => owned(await json(requests.complete(id), signal), id),
    get: async (id: string, signal?: AbortSignal) => owned(await json(requests.get(id), signal), id),
    list: async (purpose: BatchFilePurpose = 'batch', signal?: AbortSignal) => parseBatchFileList(await json(requests.list(purpose), signal)),
    contentPath: (id: string) => requests.content(id).path,
  };
}
export type BatchFileClient = ReturnType<typeof createBatchFileClient>;
