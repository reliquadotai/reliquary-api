import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, OFFICIAL_SKILLS } from '../dist/index.js';

const root = resolve(import.meta.dirname, '..');
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, ...options });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', reject);
  child.on('close', code => resolve({ code, stdout, stderr }));
});

test('public transport sends no credentials, refuses redirects and preserves bounded refusal diagnostics', async () => {
  let count = 0;
  const client = createPublicClient({ fetch: async (url, init) => {
    count++;
    assert.equal(url.href, 'https://api.reliqua.ai/api/health');
    assert.equal(init.method, 'GET');
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    assert.equal(new Headers(init.headers).has('Cookie'), false);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    return Response.json({ error: { code: 'rate_limited', message: 'untrusted text' } }, { status: 429, headers: { 'X-Request-ID': 'read-123', 'Retry-After': '20' } });
  } });
  await assert.rejects(client.read('health'), error => error.code === 'rate_limited' && error.requestId === 'read-123' && error.retryAfterSeconds === 20);
  assert.equal(count, 1);
  await assert.rejects(client.read('http://elsewhere.invalid'), error => error.code === 'invalid_route');
  assert.equal(count, 1);
  for (const origin of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/api', 'https://example.com/?key=value'])
    assert.throws(() => createPublicClient({ origin }));
  await assert.rejects(createPublicClient({ fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid' } }) }).read('health'), error => error.code === 'redirect_refused');
  await assert.rejects(createPublicClient({ fetch: async () => new Response('{}', { headers: { 'Content-Length': '4194305' } }) }).read('health'), error => error.code === 'response_too_large');
  await assert.rejects(createPublicClient({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4194305)); controller.close(); } })) }).read('health'), error => error.code === 'response_too_large');
  await assert.rejects(createPublicClient({ fetch: async () => Response.json([]) }).read('health'), error => error.code === 'invalid_response');
  await assert.rejects(createPublicClient({ fetch: async () => Response.json({ offers: [{ gpu: 'H200' }], sources: [] }) }).compute(), error => error.code === 'invalid_response');
});

test('clean packed installation supports public discovery, preserves skill edits and refuses execution', { timeout: 60_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'developer-preview-'));
  const requests = [];
  const now = '2026-10-30T18:00:00.000Z';
  const catalog = {
    offers: [{ provider: 'lium', gpu: 'H200', gpuCount: 8, priceMicroUsdPerHour: 24_000_000, observedAt: now },
      { provider: 'targon', gpu: 'H100', gpuCount: 1, priceMicroUsdPerHour: 2_000_000, observedAt: now }],
    sources: [{ provider: 'lium', state: 'live', observedAt: now, expiresAt: '2026-10-30T18:03:00Z' }],
    observedAt: now, managedRentalsEnabled: false, rehearsalEnabled: false,
  };
  const server = createServer((req, res) => {
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/compute/catalog') res.end(JSON.stringify(catalog));
    else if (req.url === '/api/inventory') res.end(JSON.stringify({ schemaVersion: 1, revision: 'public-1', fetchedAt: now, objects: [], sources: [], generation: null }));
    else if (req.url === '/api/health') res.end('{"ok":true}');
    else { res.statusCode = 429; res.setHeader('Retry-After', '30'); res.setHeader('X-Request-ID', 'fixture-429'); res.end('{"error":{"code":"rate_limited"}}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const packed = await run('npm', ['pack', '--json', '--pack-destination', temp]);
    assert.equal(packed.code, 0, packed.stderr);
    const entries = JSON.parse(packed.stdout);
    const installed = await run('npm', ['install', '--prefix', join(temp, 'install'), '--ignore-scripts', '--no-audit', '--no-fund', join(temp, entries[0].filename)]);
    assert.equal(installed.code, 0, installed.stderr);
    const bin = join(temp, 'install/node_modules/.bin/reliqua');
    const cli = args => run(process.execPath, [bin, ...args, '--origin', origin], { env: { ...process.env, RELIQUARY_RESOURCES_KEY: 'fixture-must-not-be-sent-to-public-reads' } });
    const compared = await cli(['compute', 'list', '--gpu', 'H200', '--limit', '1', '--json']);
    assert.equal(compared.code, 0, compared.stderr);
    const result = JSON.parse(compared.stdout);
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0].priceMicroUsdPerHour, 24_000_000);
    assert.deepEqual(result.sources, catalog.sources);
    assert.equal(result.executionEnabled, false);
    const human = await cli(['compute', 'list', '--gpu', 'H200']);
    assert.match(human.stdout, /USD\/package-hour/);
    assert.match(human.stdout, /24\.0000/);
    const empty = await cli(['compute', 'list', '--gpu', 'NoSuchGPU', '--json']);
    assert.equal(empty.code, 0);
    assert.deepEqual(JSON.parse(empty.stdout).offers, []);
    const inventory = await cli(['inventory', '--json']);
    assert.equal(inventory.code, 0, inventory.stderr);
    assert.deepEqual(JSON.parse(inventory.stdout).objects, []);
    const denied = await cli(['network', '--json']);
    assert.equal(denied.code, 1);
    assert.equal(denied.stdout, '');
    assert.equal(JSON.parse(denied.stderr).error.requestId, 'fixture-429');
    const before = requests.length;
    for (const args of [['train', 'start'], ['jobs', 'submit'], ['jobs', 'status', '--id', 'nope'], ['jobs', 'list', '--cursor', 'has space'],
      ['jobs', 'report', '--id', 'cpu:12345678-1234-4234-8234-123456789abc', '--artifact', 'has space'],
      ['compute', 'rent'], ['inventory', '--limit', '5'], ['compute', 'list', '--limit', 'Infinity'], ['compute', 'list', '--gpu', '\u001b']]) {
      const output = await cli(args);
      assert.equal(output.code, 2, output.stderr);
    }
    assert.equal(requests.length, before);
    assert.ok(requests.every(request => request.method === 'GET' && request.auth === undefined));
    const directory = join(temp, 'skills');
    for (let i = 0; i < 2; i++) assert.equal((await cli(['skills', 'install', '--directory', directory, '--json'])).code, 0);
    for (const skill of OFFICIAL_SKILLS) assert.match(await readFile(join(directory, skill.id, 'SKILL.md'), 'utf8'), new RegExp(`name: ${skill.id}`));
    const edited = join(directory, OFFICIAL_SKILLS[0].id, 'SKILL.md');
    await writeFile(edited, 'User-owned local edits');
    assert.equal((await cli(['skills', 'install', '--directory', directory])).code, 2);
    assert.equal(await readFile(edited, 'utf8'), 'User-owned local edits');
    const unsafe = join(temp, 'unsafe');
    await mkdir(unsafe);
    await symlink(directory, join(unsafe, OFFICIAL_SKILLS[0].id));
    assert.equal((await cli(['skills', 'install', '--directory', unsafe])).code, 2);
    const legacy = await run(process.execPath, [join(temp, 'install/node_modules/.bin/jobctl'), '--help']);
    assert.equal(legacy.code, 0);
    assert.match(legacy.stdout, /Usage: jobctl/);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); }
});
