/**
 * Node helpers for batch orders: upload a local JSONL in parts, and write a delivered order's files to disk with
 * Range resume and sha256 verification. File contents never pass through the caller's memory as a whole.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
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

async function existing(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function regularFile(path: string, flags: number): Promise<FileHandle> {
  const before = await existing(path);
  if (before && !before.isFile()) throw new Error('Use a regular file, not a link or special file.');
  const handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (before && (info.dev !== before.dev || info.ino !== before.ino))) throw new Error('The file changed while it was opened.');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function readPart(source: Blob | FileHandle, start: number, end: number): Promise<Uint8Array> {
  if (source instanceof Blob) return new Uint8Array(await source.slice(start, end).arrayBuffer());
  const buffer = new Uint8Array(end - start);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await source.read(buffer, offset, buffer.length - offset, start + offset);
    if (bytesRead === 0) throw new Error('The upload source changed while it was read.');
    offset += bytesRead;
  }
  return buffer;
}

/** Upload a batch file (a local path or a Blob) in the parts the platform asks for, then complete it. */
export async function uploadFile(transport: BatchFileTransport, source: UploadSource, options: UploadOptions = {}): Promise<BatchFile> {
  const attempts = options.partAttempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('Part attempts must be an integer from 1 to 10.');
  const client = createBatchFileClient(transport);
  const handle = typeof source === 'string' ? await regularFile(source, constants.O_RDONLY) : undefined;
  try {
    const info = await handle?.stat();
    const bytes = info?.size ?? (source as Blob).size;
    const name = options.filename ?? (typeof source === 'string' ? basename(source) : (source as Blob & { name?: string }).name ?? 'batch.jsonl');
    if (bytes < 1 || bytes > MAX_BATCH_FILE_BYTES) throw new Error(`A batch file holds 1 to ${MAX_BATCH_FILE_BYTES} bytes.`);
    let file = options.fileId
      ? await client.get(options.fileId, options.signal)
      : await client.create({ filename: name, bytes, purpose: options.purpose ?? 'batch' }, options.signal);
    if (file.bytes !== bytes || file.filename !== name || file.purpose !== (options.purpose ?? 'batch')) throw new Error('This file id was started for other content.');
    if (file.status === 'processed') return file;
    if (!file.upload) throw new Error('This file id has no upload metadata.');
    const { part_size: size, parts } = file.upload;
    for (let part = 1; part <= parts; part++) {
      const start = (part - 1) * size;
      const chunk = await readPart(handle ?? (source as Blob), start, Math.min(bytes, start + size));
      for (let attempt = 1; ; attempt++) {
        try { await client.putPart(file.id, part, chunk, options.signal); break; }
        catch (error) {
          const ambiguous = error instanceof GenerationApiError && ['outcome_unknown', 'upstream_unavailable'].includes(error.code);
          if (!ambiguous || attempt >= attempts || options.signal?.aborted) throw error;
        }
      }
      options.onPart?.(part, parts);
    }
    if (handle && info) {
      const current = await handle.stat();
      if (current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) throw new Error('The upload source changed while it was read.');
    }
    file = await client.complete(file.id, options.signal);
    if (file.status !== 'processed' || file.bytes !== bytes || file.filename !== name || file.purpose !== (options.purpose ?? 'batch')) throw new Error('The platform did not accept the uploaded file.');
    return file;
  } finally { await handle?.close(); }
}

export type DownloadedFile = { deliveryId: string; name: string; path: string; size: number; sha256: string | null; verified: boolean };
export type StreamTransport = {
  stream(path: string, offset: number, signal?: AbortSignal): Promise<{ status: number; body: ReadableStream<Uint8Array> | null; total: number | null }>;
};

const safeName = (name: string) => {
  if (!name || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/.test(name)) throw new Error('A delivered file name is unsafe.');
  return name;
};

async function sha256Of(file: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function directoryAt(path: string, recursive = false): Promise<void> {
  const before = await existing(path);
  if (before && !before.isDirectory()) throw new Error('Use a real destination directory, not a link or special file.');
  if (!before) try { await mkdir(path, { recursive, mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!(await lstat(path)).isDirectory()) throw new Error('The destination directory changed.');
}

/**
 * Write every file of a delivered order under `directory/<delivery id>/`, resuming a partial file by Range and
 * checking each file's size and sha256 against the order. A finished file is written under a `.part` name first.
 */
export async function downloadDelivery(transport: StreamTransport, order: GenerationOrderDetail, directory: string,
  options: { signal?: AbortSignal } = {}): Promise<DownloadedFile[]> {
  if (!order.deliveries.length) throw new Error('This order has no delivered files yet.');
  await directoryAt(resolve(directory), true);
  const root = await realpath(resolve(directory));
  // shortcut: directories must not be replaced concurrently; hostile shared destinations need openat-based IO.
  const written: DownloadedFile[] = [];
  for (const delivery of order.deliveries) {
    const folder = join(root, safeName(delivery.delivery_id));
    if (!folder.startsWith(root === sep ? root : root + sep)) throw new Error('A delivery id is unsafe.');
    await directoryAt(folder);
    for (const file of delivery.files) {
      const target = join(folder, safeName(file.name));
      const partial = target + '.part';
      const done = await existing(target);
      if (done) {
        const handle = await regularFile(target, constants.O_RDONLY);
        try {
          if ((await handle.stat()).size !== file.size || (file.sha256 && await sha256Of(handle) !== file.sha256)) throw new Error('A destination file already exists with different content.');
        } finally { await handle.close(); }
        written.push({ deliveryId: delivery.delivery_id, name: file.name, path: target, size: file.size, sha256: file.sha256, verified: file.sha256 !== null });
        continue;
      }
      const handle = await regularFile(partial, constants.O_RDWR | constants.O_CREAT);
      try {
        const info = await handle.stat();
        if (info.nlink !== 1) throw new Error('A partial download must not have other hard links.');
        let offset = info.size;
        if (offset > file.size) throw new Error('The partial download is larger than the expected file.');
        if (offset < file.size) {
          const reply = await transport.stream(file.url, offset, options.signal);
          if (reply.total !== null && reply.total !== file.size) throw new GenerationApiError('invalid_file_range', undefined, undefined, 'A delivered file changed size.');
          if (reply.body) for await (const chunk of reply.body as unknown as AsyncIterable<Uint8Array>) {
            if (offset + chunk.byteLength > file.size) throw new GenerationApiError('response_too_large');
            let written = 0;
            while (written < chunk.byteLength) {
              const { bytesWritten } = await handle.write(chunk, written, chunk.byteLength - written, offset + written);
              if (!bytesWritten) throw new Error('The partial download could not be written.');
              written += bytesWritten;
            }
            offset += chunk.byteLength;
          }
        }
        if (offset !== file.size) throw new GenerationApiError('invalid_file_range', undefined, undefined, `${file.name} ended at ${offset} of ${file.size} bytes; run again to resume.`);
        const digest = await sha256Of(handle);
        const retained = await lstat(partial);
        if (!retained.isFile() || retained.dev !== info.dev || retained.ino !== info.ino) throw new Error('The partial download changed.');
        if (file.sha256 && digest !== file.sha256) {
          await link(partial, partial + '.rejected');
          await unlink(partial);
          throw new Error(`${file.name} does not match its sha256; the bytes are kept as ${basename(partial)}.rejected.`);
        }
        await handle.sync();
        await link(partial, target);
        await unlink(partial);
        written.push({ deliveryId: delivery.delivery_id, name: file.name, path: target, size: file.size, sha256: digest, verified: file.sha256 !== null });
      } finally { await handle.close(); }
    }
  }
  return written;
}
