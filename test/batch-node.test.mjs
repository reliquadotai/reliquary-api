import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadDelivery, uploadFile } from '../dist/batch-node.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('abcdef');
const order = { deliveries: [{ delivery_id: 'delivery', files: [
  { name: 'output.jsonl', size: bytes.length, sha256: sha(bytes), url: '/owned-output' },
] }] };
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'batch-files-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const stream = content => ({ async *[Symbol.asyncIterator]() { yield content; } });
const noRequest = { stream() { throw new Error('No request expected.'); } };

test('an existing completed file with different content is preserved without a request', async t => {
  const root = await directory(t);
  await mkdir(join(root, 'delivery'));
  const target = join(root, 'delivery', 'output.jsonl');
  await writeFile(target, 'previous contents');
  await assert.rejects(downloadDelivery(noRequest, order, root), /different content/);
  assert.equal(await readFile(target, 'utf8'), 'previous contents');
});

test('download destinations reject links and non-regular files without modifying other paths', async t => {
  for (const kind of ['root-link', 'folder-link', 'target-link', 'partial-link', 'target-directory', 'partial-directory', 'partial-hardlink']) {
    const base = await directory(t), root = join(base, 'downloads'), outside = join(base, 'original');
    await writeFile(outside, 'keep this file');
    if (kind === 'root-link') await symlink(base, root);
    else {
      await mkdir(root);
      const folder = join(root, 'delivery');
      if (kind === 'folder-link') await symlink(base, folder);
      else {
        await mkdir(folder);
        const target = join(folder, 'output.jsonl' + (kind.startsWith('partial-') ? '.part' : ''));
        if (kind.endsWith('-directory')) await mkdir(target);
        else if (kind.endsWith('-hardlink')) await link(outside, target);
        else await symlink(outside, target);
      }
    }
    await assert.rejects(downloadDelivery(noRequest, order, root));
    assert.equal(await readFile(outside, 'utf8'), 'keep this file', kind);
  }
});

test('publication and rejected-file collisions preserve both existing and downloaded bytes', async t => {
  for (const rejected of [false, true]) {
    const root = await directory(t), folder = join(root, 'delivery');
    await mkdir(folder);
    const target = join(folder, 'output.jsonl'), partial = target + '.part';
    if (rejected) await writeFile(partial + '.rejected', 'previous rejected bytes');
    const transport = { async stream() {
      if (!rejected) await writeFile(target, 'concurrent output');
      return { status: 200, total: bytes.length, body: stream(bytes) };
    } };
    const input = rejected ? { deliveries: [{ delivery_id: 'delivery', files: [{ ...order.deliveries[0].files[0], sha256: 'b'.repeat(64) }] }] } : order;
    await assert.rejects(downloadDelivery(transport, input, root), error => error.code === 'EEXIST');
    assert.deepEqual(await readFile(partial), bytes);
    assert.equal(await readFile(rejected ? partial + '.rejected' : target, 'utf8'), rejected ? 'previous rejected bytes' : 'concurrent output');
  }
});

test('interrupted downloads resume their retained bytes and new outputs stay private', async t => {
  const base = await directory(t), root = join(base, 'downloads');
  const offsets = [];
  const transport = { async stream(path, offset) {
    offsets.push(offset);
    return { status: offset ? 206 : 200, total: bytes.length, body: offset ? stream(bytes.subarray(offset)) : {
      async *[Symbol.asyncIterator]() { yield bytes.subarray(0, 2); throw new Error('Interrupted.'); },
    } };
  } };
  await assert.rejects(downloadDelivery(transport, order, root), /Interrupted/);
  assert.deepEqual(await readFile(join(root, 'delivery', 'output.jsonl.part')), bytes.subarray(0, 2));
  const [file] = await downloadDelivery(transport, order, root);
  assert.equal(file.verified, true);
  assert.deepEqual(await readFile(file.path), bytes);
  await downloadDelivery(noRequest, order, root);
  assert.deepEqual(offsets, [0, 2]);
  assert.equal((await stat(root)).mode & 0o077, 0);
  assert.equal((await stat(join(root, 'delivery'))).mode & 0o077, 0);
  assert.equal((await stat(file.path)).mode & 0o077, 0);
});

test('uploads reject source links and keep one source handle across parts', async t => {
  const root = await directory(t), path = join(root, 'requests.jsonl'), alias = join(root, 'alias.jsonl');
  await writeFile(path, bytes);
  await symlink(path, alias);
  const parts = [];
  let completed = false;
  const record = { id: 'file-one', object: 'file', bytes: bytes.length, filename: 'requests.jsonl', purpose: 'batch',
    created_at: '2030-01-01T00:00:00Z', status: 'uploading', upload: { part_size: 3, parts: 2 } };
  const transport = {
    async request(route) {
      if (route.endsWith('/complete')) { completed = true; return { ...record, status: 'processed' }; }
      await rename(path, path + '.original');
      await writeFile(path, 'replacement');
      return record;
    },
    async putPart(route, content) { parts.push(Buffer.from(content)); return { part: parts.length, etag: 'part' }; },
  };
  await assert.rejects(uploadFile(transport, alias), /regular file/);
  try { await uploadFile(transport, path); }
  catch (error) { assert.match(error.message, /source changed/); assert.equal(completed, false); }
  assert.deepEqual(Buffer.concat(parts), bytes);
});

test('a resumed upload checks the selected source metadata before accepting a processed file', async t => {
  const root = await directory(t), path = join(root, 'requests.jsonl');
  await writeFile(path, bytes);
  const transport = { async request() { return { id: 'file-one', object: 'file', bytes: bytes.length + 1, filename: 'other.jsonl', purpose: 'batch', status: 'processed', created_at: '2030-01-01T00:00:00Z' }; } };
  await assert.rejects(uploadFile(transport, path, { fileId: 'file-one' }), /other content/);
});
