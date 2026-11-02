/**
 * Node helpers for batch orders: upload a local JSONL in parts, and write a delivered order's files to disk with
 * Range resume and sha256 verification. File contents never pass through the caller's memory as a whole.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { GenerationOrderDetail } from './batch-orders.js';
import { createBatchFileClient, MAX_BATCH_FILE_BYTES, type BatchFile, type BatchFilePurpose, type BatchFileTransport } from './batch-files.js';
import { GenerationApiError } from './generation.js';

export type UploadSource = string | Blob;
export type UploadOptions = {
  purpose?: BatchFilePurpose;
  filename?: string;
  /** Resume an upload this file id started: its parts are sent again (they are idempotent), then completed. */
  fileId?: string;
  signal?: AbortSignal;
  onPart?: (part: number, parts: number) => void;
  /** Attempts per part on an ambiguous failure (parts are idempotent). */
  partAttempts?: number;
};

async function sourceSize(source: UploadSource): Promise<{ bytes: number; name: string }> {
  if (typeof source === 'string') {
    const info = await stat(source);
    if (!info.isFile()) throw new Error('The upload source is not a file.');
    return { bytes: info.size, name: basename(source) };
  }
  return { bytes: source.size, name: (source as Blob & { name?: string }).name ?? 'batch.jsonl' };
}

async function readPart(source: UploadSource, start: number, end: number): Promise<Uint8Array> {
  if (typeof source !== 'string') return new Uint8Array(await source.slice(start, end).arrayBuffer());
  const handle = await open(source, 'r');
  try {
    const buffer = new Uint8Array(end - start);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) throw new Error('The upload source changed while it was read.');
      offset += bytesRead;
    }
    return buffer;
  } finally { await handle.close(); }
}

/** Upload a batch file (a local path or a Blob) in the parts the platform asks for, then complete it. */
export async function uploadFile(transport: BatchFileTransport, source: UploadSource, options: UploadOptions = {}): Promise<BatchFile> {
  const client = createBatchFileClient(transport);
  const { bytes, name } = await sourceSize(source);
  if (bytes < 1 || bytes > MAX_BATCH_FILE_BYTES) throw new Error(`A batch file holds 1 to ${MAX_BATCH_FILE_BYTES} bytes.`);
  let file = options.fileId
    ? await client.get(options.fileId, options.signal)
    : await client.create({ filename: options.filename ?? name, bytes, purpose: options.purpose ?? 'batch' }, options.signal);
  if (file.status === 'processed') return file;
  if (file.bytes !== bytes || !file.upload) throw new Error('This file id was started for other content.');
  const { part_size: size, parts } = file.upload;
  const attempts = Math.max(1, Math.min(options.partAttempts ?? 3, 10));
  for (let part = 1; part <= parts; part++) {
    const start = (part - 1) * size;
    const chunk = await readPart(source, start, Math.min(bytes, start + size));
    for (let attempt = 1; ; attempt++) {
      try { await client.putPart(file.id, part, chunk, options.signal); break; }
      catch (error) {
        const ambiguous = error instanceof GenerationApiError && ['outcome_unknown', 'upstream_unavailable'].includes(error.code);
        if (!ambiguous || attempt >= attempts || options.signal?.aborted) throw error;
      }
    }
    options.onPart?.(part, parts);
  }
  file = await client.complete(file.id, options.signal);
  if (file.status !== 'processed' || file.bytes !== bytes) throw new Error('The platform did not accept the uploaded file.');
  return file;
}

export type DownloadedFile = { deliveryId: string; name: string; path: string; size: number; sha256: string | null; verified: boolean };
export type StreamTransport = {
  stream(path: string, offset: number, signal?: AbortSignal): Promise<{ status: number; body: ReadableStream<Uint8Array> | null; total: number | null }>;
};

const safeName = (name: string) => {
  if (!name || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/.test(name)) throw new Error('A delivered file name is unsafe.');
  return name;
};

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Write every file of a delivered order under `directory/<delivery id>/`, resuming a partial file by Range and
 * checking each file's size and sha256 against the order. A finished file is written under a `.part` name first.
 */
export async function downloadDelivery(transport: StreamTransport, order: GenerationOrderDetail, directory: string,
  options: { signal?: AbortSignal } = {}): Promise<DownloadedFile[]> {
  if (!order.deliveries.length) throw new Error('This order has no delivered files yet.');
  const root = resolve(directory);
  const written: DownloadedFile[] = [];
  for (const delivery of order.deliveries) {
    const folder = join(root, safeName(delivery.delivery_id));
    if (!folder.startsWith(root + sep)) throw new Error('A delivery id is unsafe.');
    await mkdir(folder, { recursive: true });
    for (const file of delivery.files) {
      const target = join(folder, safeName(file.name));
      const partial = target + '.part';
      const done = await stat(target).catch(() => null);
      if (done && done.size === file.size && (!file.sha256 || await sha256Of(target) === file.sha256)) {
        written.push({ deliveryId: delivery.delivery_id, name: file.name, path: target, size: file.size, sha256: file.sha256, verified: file.sha256 !== null });
        continue;
      }
      let offset = (await stat(partial).catch(() => null))?.size ?? 0;
      if (offset > file.size) offset = 0;
      if (offset < file.size) {
        const reply = await transport.stream(file.url, offset, options.signal);
        if (reply.total !== null && reply.total !== file.size) throw new GenerationApiError('invalid_file_range', undefined, undefined, 'A delivered file changed size.');
        const handle = await open(partial, offset ? 'a' : 'w');
        try {
          if (reply.body) for await (const chunk of reply.body as unknown as AsyncIterable<Uint8Array>) {
            offset += chunk.byteLength;
            if (offset > file.size) throw new GenerationApiError('response_too_large');
            await handle.write(chunk);
          }
        } finally { await handle.close(); }
      }
      if (offset !== file.size) throw new GenerationApiError('invalid_file_range', undefined, undefined, `${file.name} ended at ${offset} of ${file.size} bytes; run again to resume.`);
      const digest = await sha256Of(partial);
      if (file.sha256 && digest !== file.sha256) {
        await rename(partial, partial + '.rejected');
        throw new Error(`${file.name} does not match its sha256; the bytes are kept as ${basename(partial)}.rejected.`);
      }
      await rename(partial, target);
      written.push({ deliveryId: delivery.delivery_id, name: file.name, path: target, size: file.size, sha256: digest, verified: file.sha256 !== null });
    }
  }
  return written;
}
