import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, mkdir, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, OFFICIAL_SKILLS, DEVELOPER_PREVIEW, skillInstructionsPath } from '../dist/index.js';

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
    else if (req.url === '/api/monitoring/runs') res.end(JSON.stringify({ runs: [{ id: 'published-run', available: true }], collectedAt: now }));
    else if (req.url === '/api/monitoring/run' || req.url === '/api/monitoring/run?run=published-run') res.end(JSON.stringify({ mode: 'stale', collectedAt: now, analytics: { tokenComposition: { observedAt: '2026-10-29T10:00:00Z', counts: [0, null, 9007199254740991] } } }));
    else if (req.url === '/api/monitoring/health' || req.url === '/api/monitoring/snapshot') res.end(JSON.stringify({ observedAt: now, missing: null }));
    else if (req.url === '/api/health') res.end('{"ok":true}');
    else { res.statusCode = 429; res.setHeader('Retry-After', '30'); res.setHeader('X-Request-ID', 'fixture-429'); res.end('{"error":{"code":"rate_limited"}}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const packed = await run('npm', ['pack', '--json', '--pack-destination', temp]);
    assert.equal(packed.code, 0, packed.stderr);
    const entries = JSON.parse(packed.stdout);
    const shippedSkills = entries[0].files.filter(file => /^skills\/[^/]+\/SKILL\.md$/.test(file.path)).map(file => file.path).sort();
    assert.deepEqual(shippedSkills, OFFICIAL_SKILLS.map(skill => `skills/${skill.id}/SKILL.md`).sort());
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
    for (const args of [['runs', 'list'], ['runs', 'inspect'], ['runs', 'inspect', '--run', 'published-run'], ['monitoring', 'health'], ['monitoring', 'snapshot']]) {
      const result = await cli([...args, '--json']);
      assert.equal(result.code, 0, result.stderr);
      const data = JSON.parse(result.stdout);
      if (args[1] === 'inspect') {
        assert.equal(data.mode, 'stale');
        assert.equal(data.analytics.tokenComposition.observedAt, '2026-10-29T10:00:00Z');
        assert.deepEqual(data.analytics.tokenComposition.counts, [0, null, 9007199254740991]);
      }
    }
    const denied = await cli(['network', '--json']);
    assert.equal(denied.code, 1);
    assert.equal(denied.stdout, '');
    assert.equal(JSON.parse(denied.stderr).error.requestId, 'fixture-429');
    const before = requests.length;
    for (const args of [['train', 'start'], ['jobs', 'submit'], ['jobs', 'status', '--id', 'nope'], ['jobs', 'list', '--cursor', 'has space'],
      ['jobs', 'report', '--id', 'cpu:12345678-1234-4234-8234-123456789abc', '--artifact', 'has space'],
      ['runs', 'inspect', '--run', '../private'], ['runs', 'inspect', '--run', 'x?key=secret'], ['runs', 'list', '--run', 'current'],
      ['skills', 'show'], ['skills', 'list', '--interface', 'shell'], ['skills', 'list', '--access', 'admin'], ['skills', 'list', '--search', '  '], ['compute', 'rent'], ['inventory', '--limit', '5'], ['compute', 'list', '--limit', 'Infinity'], ['compute', 'list', '--gpu', '\u001b']]) {
      const output = await cli(args);
      assert.equal(output.code, 2, output.stderr);
    }
    assert.equal(requests.length, before);
    assert.ok(requests.every(request => request.method === 'GET' && request.auth === undefined));
    const listed = await cli(['skills', 'list', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    const manifest = JSON.parse(listed.stdout);
    assert.equal(manifest.version, '0.9.0');
    assert.equal(manifest.executionEnabled, false);
    assert.deepEqual(manifest.skills, OFFICIAL_SKILLS);
    assert.ok(manifest.skills.some(skill => skill.access === 'approval-required' && !skill.interfaces.includes('cli')));
    const searched = await cli(['skills', 'list', '--search', 'TOKEN', '--category', 'observability', '--interface', 'cli', '--access', 'public-read', '--json']);
    const found = JSON.parse(searched.stdout).skills;
    assert(found.some(skill => skill.id === 'reliquary-run-token-mix'));
    assert(found.every(skill => skill.category === 'observability' && skill.interfaces.includes('cli') && skill.access === 'public-read'));
    assert.deepEqual(JSON.parse((await cli(['skills', 'list', '--category', 'unknown', '--json'])).stdout).skills, []);
    const instructions = await cli(['skills', 'show', '--skill', 'reliquary-run-token-mix', '--json']);
    assert.equal(instructions.code, 0, instructions.stderr);
    assert.equal(JSON.parse(instructions.stdout).instructions, await readFile(join(temp, 'install/node_modules/@reliquary/api/skills/reliquary-run-token-mix/SKILL.md'), 'utf8'));
    assert.equal((await cli(['skills', 'show', '--skill', 'reliquary-run-token-mix'])).stdout, JSON.parse(instructions.stdout).instructions);
    const selectedId = 'reliquary-training-start';
    const filtered = await cli(['skills', 'list', '--skill', selectedId, '--json']);
    assert.deepEqual(JSON.parse(filtered.stdout).skills.map(skill => skill.id), [selectedId]);
    const selected = join(temp, 'selected');
    const selectedInstall = await cli(['skills', 'install', '--skill', selectedId, '--directory', selected, '--json']);
    assert.equal(selectedInstall.code, 0, selectedInstall.stderr);
    assert.deepEqual(JSON.parse(selectedInstall.stdout).installed, [selectedId]);
    assert.deepEqual(await readdir(selected), [selectedId]);
    const unknown = join(temp, 'unknown');
    assert.equal((await cli(['skills', 'install', '--skill', '../unknown', '--directory', unknown])).code, 2);
    await assert.rejects(access(unknown), error => error.code === 'ENOENT');
    assert.equal(requests.length, before);
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

test('public run selector refuses alternate routes before fetch and keeps release instructions pinned', async () => {
  let calls = 0;
  const client = createPublicClient({ fetch: async (url, init) => {
    calls++;
    assert.equal(url.href, 'https://api.reliqua.ai/api/monitoring/run?run=published-run');
    assert.equal(init.credentials, 'omit');
    return Response.json({ mode: 'unavailable', analytics: null });
  } });
  for (const id of ['', '.', '..', 'x/y', 'x?key=value', 'x'.repeat(129)]) await assert.rejects(client.run(id), e => e.code === 'invalid_run');
  assert.equal(calls, 0);
  assert.deepEqual(await client.run('published-run'), { mode: 'unavailable', analytics: null });
  assert.equal(calls, 1);
  assert.equal(skillInstructionsPath(OFFICIAL_SKILLS[0]), `/skills/${DEVELOPER_PREVIEW.version}/${OFFICIAL_SKILLS[0].id}/SKILL.md`);
});
